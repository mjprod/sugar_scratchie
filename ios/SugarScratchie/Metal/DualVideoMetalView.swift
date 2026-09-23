import AVFoundation
import CoreVideo
import Metal
import MetalKit
import UIKit

/// Both clips are GPU textures drawn into one MTKView. Scratches only update
/// a mask, so neither video is copied on the CPU during playback.
final class DualVideoMetalView: MTKView {
    var chromaKey: Bool = false

    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private var textureCache: CVMetalTextureCache?
    private var maskTexture: MTLTexture?
    private var solidWhite: MTLTexture?
    private var solidBlack: MTLTexture?
    private let maskLock = NSLock()
    private var maskDirty = false
    private var maskBitmap: CGImage?

    private var bgOutput: AVPlayerItemVideoOutput?
    private var fgOutput: AVPlayerItemVideoOutput?

    /// Hold last good frames so a missed copy never flashes white/black.
    private var lastBgTex: MTLTexture?
    private var lastFgTex: MTLTexture?
    private var lastBgCV: CVMetalTexture?
    private var lastFgCV: CVMetalTexture?
    private var inFlightCV: [(CVMetalTexture?, CVMetalTexture?)] = []

    init(frame: CGRect = .zero) {
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue()
        else {
            fatalError("Metal unavailable")
        }
        commandQueue = queue
        let library = try! DualVideoShaders.makeLibrary(device: device)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "dual_video_vertex")
        descriptor.fragmentFunction = library.makeFunction(name: "dual_video_fragment")
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        pipelineState = try! device.makeRenderPipelineState(descriptor: descriptor)
        var cache: CVMetalTextureCache?
        CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
        textureCache = cache
        super.init(frame: frame, device: device)
        framebufferOnly = true
        isPaused = false
        enableSetNeedsDisplay = false
        preferredFramesPerSecond = 30
        colorPixelFormat = .bgra8Unorm
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        solidWhite = Self.makeSolidTexture(device: device, color: (1, 1, 1, 1))
        solidBlack = Self.makeSolidTexture(device: device, color: (0, 0, 0, 1))
        maskTexture = solidWhite
        delegate = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    func attach(backgroundOutput: AVPlayerItemVideoOutput?, foregroundOutput: AVPlayerItemVideoOutput?) {
        bgOutput = backgroundOutput
        fgOutput = foregroundOutput
        lastBgTex = nil
        lastFgTex = nil
        lastBgCV = nil
        lastFgCV = nil
    }

    func attachMaskImage(_ image: CGImage?) {
        maskLock.lock()
        maskBitmap = image
        maskDirty = true
        maskLock.unlock()
    }

    func invalidateMask() {
        maskLock.lock()
        maskDirty = true
        maskLock.unlock()
    }

    func lockMask(_ block: () -> Void) {
        maskLock.lock()
        block()
        maskLock.unlock()
    }

    func snapshotImage() -> UIImage? {
        guard let current = currentDrawable?.texture else {
            return UIGraphicsImageRenderer(size: bounds.size).image { ctx in
                layer.render(in: ctx.cgContext)
            }
        }
        let width = current.width
        let height = current.height
        let rowBytes = width * 4
        var bytes = [UInt8](repeating: 0, count: rowBytes * height)
        current.getBytes(
            &bytes,
            bytesPerRow: rowBytes,
            from: MTLRegionMake2D(0, 0, width, height),
            mipmapLevel: 0
        )
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &bytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: rowBytes,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ),
            let cg = context.makeImage()
        else { return nil }
        return UIImage(cgImage: cg)
    }

    private func uploadMaskIfNeeded() {
        maskLock.lock()
        defer { maskLock.unlock() }
        guard maskDirty else { return }
        maskDirty = false
        guard let image = maskBitmap, let device else {
            maskTexture = solidWhite
            return
        }
        let width = image.width
        let height = image.height
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        descriptor.usage = [.shaderRead]
        guard let texture = device.makeTexture(descriptor: descriptor) else { return }
        let bytesPerRow = width * 4
        var data = [UInt8](repeating: 0, count: bytesPerRow * height)

        // Copy CGImage pixels top-row-first into the Metal texture (Metal origin = top-left).
        // Avoid Quartz draw + extra Y flips — those inverted the scratch relative to the finger.
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        if let ctx = CGContext(
            data: &data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) {
            ctx.interpolationQuality = .none
            // Bitmap contexts are bottom-left; flip once so UIKit/CGImage top lands at texture y = 0.
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            texture.replace(
                region: MTLRegionMake2D(0, 0, width, height),
                mipmapLevel: 0,
                withBytes: data,
                bytesPerRow: bytesPerRow
            )
            maskTexture = texture
        }
    }

    private func makeTexture(from pixelBuffer: CVPixelBuffer) -> (MTLTexture, CVMetalTexture)? {
        guard let textureCache else { return nil }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var cvTexture: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil,
            textureCache,
            pixelBuffer,
            nil,
            .bgra8Unorm,
            width,
            height,
            0,
            &cvTexture
        )
        guard status == kCVReturnSuccess,
              let cvTexture,
              let texture = CVMetalTextureGetTexture(cvTexture)
        else { return nil }
        return (texture, cvTexture)
    }

    private func pullFrame(from output: AVPlayerItemVideoOutput?) -> (MTLTexture, CVMetalTexture)? {
        guard let output else { return nil }
        let hostTime = CACurrentMediaTime()
        let itemTime = output.itemTime(forHostTime: hostTime)
        guard itemTime.isValid, !itemTime.isIndefinite else { return nil }
        if output.hasNewPixelBuffer(forItemTime: itemTime),
           let pb = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil)
        {
            return makeTexture(from: pb)
        }
        // Hold last displayed frame rather than flashing when the decoder stalls.
        if let pb = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) {
            return makeTexture(from: pb)
        }
        return nil
    }

    private static func makeSolidTexture(device: MTLDevice, color: (Float, Float, Float, Float)) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: 1,
            height: 1,
            mipmapped: false
        )
        descriptor.usage = [.shaderRead]
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        var pixel: [UInt8] = [
            UInt8(color.0 * 255),
            UInt8(color.1 * 255),
            UInt8(color.2 * 255),
            UInt8(color.3 * 255),
        ]
        texture.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &pixel, bytesPerRow: 4)
        return texture
    }
}

extension DualVideoMetalView: MTKViewDelegate {
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        uploadMaskIfNeeded()
        guard let drawable = currentDrawable,
              let descriptor = currentRenderPassDescriptor,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
        else { return }

        var frameBgCV: CVMetalTexture?
        var frameFgCV: CVMetalTexture?

        if let pair = pullFrame(from: bgOutput) {
            lastBgTex = pair.0
            lastBgCV = pair.1
            frameBgCV = pair.1
        }
        if let pair = pullFrame(from: fgOutput) {
            lastFgTex = pair.0
            lastFgCV = pair.1
            frameFgCV = pair.1
        }

        // Never bind the white mask as a video — that made scratches flash solid white.
        let bgTex = lastBgTex ?? solidBlack
        let fgTex = lastFgTex ?? solidBlack

        encoder.setRenderPipelineState(pipelineState)
        encoder.setFragmentTexture(bgTex, index: 0)
        encoder.setFragmentTexture(fgTex, index: 1)
        encoder.setFragmentTexture(maskTexture ?? solidWhite, index: 2)
        var chroma: Float = chromaKey ? 1 : 0
        encoder.setFragmentBytes(&chroma, length: MemoryLayout<Float>.size, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()

        // Keep CVMetalTexture alive until the GPU finishes sampling the IOSurface.
        let retainBg = frameBgCV ?? lastBgCV
        let retainFg = frameFgCV ?? lastFgCV
        inFlightCV.append((retainBg, retainFg))
        commandBuffer.addCompletedHandler { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.inFlightCV.isEmpty else { return }
                self.inFlightCV.removeFirst()
            }
        }

        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}
