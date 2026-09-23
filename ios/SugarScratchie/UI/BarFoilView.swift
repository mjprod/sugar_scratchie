import SwiftUI
import UIKit

/// Scratch coat over the centered symbol bar.
final class BarFoilUIView: UIView {
    var onCleared: (() -> Void)?

    private var coatContext: CGContext?
    private var coatImage: CGImage?
    private var cleared = false
    private var coatedWithTexture = false
    private var lastX: CGFloat = 0
    private var lastY: CGFloat = 0
    private var lastTouchMs: CFTimeInterval = 0
    private let haptics = ScratchHaptics()
    private var coatWidth = 0
    private var coatHeight = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        layer.masksToBounds = true
        Self.ensureTexture()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        let w = Int(bounds.width)
        let h = Int(bounds.height)
        guard w > 0, h > 0 else { return }
        if w == coatWidth, h == coatHeight, coatContext != nil { return }
        coatWidth = w
        coatHeight = h
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: nil,
            width: w,
            height: h,
            bitsPerComponent: 8,
            bytesPerRow: w * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        // Quartz is bottom-left; flip so UIKit touch coords draw upright.
        ctx?.translateBy(x: 0, y: CGFloat(h))
        ctx?.scaleBy(x: 1, y: -1)
        coatContext = ctx
        cleared = false
        coatedWithTexture = false
        paintCoat()
    }

    override func draw(_ rect: CGRect) {
        if Self.texture != nil, !coatedWithTexture { paintCoat() }
        guard let image = coatImage else { return }
        UIImage(cgImage: image).draw(in: bounds)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        handle(touches, down: true)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        handle(touches, down: false)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        haptics.stop()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        haptics.stop()
    }

    private func handle(_ touches: Set<UITouch>, down: Bool) {
        guard let touch = touches.first, let ctx = coatContext else { return }
        let point = touch.location(in: self)
        let fresh = coatAt(point)
        let speed: Float
        if down {
            speed = 0
        } else {
            let dt = max(0.001, CACurrentMediaTime() - lastTouchMs)
            speed = Float(hypot(point.x - lastX, point.y - lastY) / dt)
        }
        haptics.pulse(speed: speed, pressure: 0.7, onFreshCoat: fresh)
        ctx.setBlendMode(.clear)
        if down {
            ctx.fillEllipse(in: CGRect(x: point.x - 36, y: point.y - 36, width: 72, height: 72))
        } else {
            ctx.setLineCap(.round)
            ctx.setLineWidth(72)
            ctx.move(to: CGPoint(x: lastX, y: lastY))
            ctx.addLine(to: point)
            ctx.strokePath()
        }
        lastX = point.x
        lastY = point.y
        lastTouchMs = CACurrentMediaTime()
        coatImage = ctx.makeImage()
        setNeedsDisplay()
        if !cleared, clearedFraction() >= 0.55 {
            cleared = true
            onCleared?()
        }
    }

    private func paintCoat() {
        guard let ctx = coatContext else { return }
        let width = CGFloat(coatWidth)
        let height = CGFloat(coatHeight)
        ctx.setBlendMode(.copy)
        ctx.setFillColor(UIColor(red: 0.604, green: 0.584, blue: 0.565, alpha: 1).cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if let tex = Self.texture {
            let scale = max((height / tex.size.height) * 1.15, 1)
            UIGraphicsPushContext(ctx)
            tex.draw(in: CGRect(x: 0, y: 0, width: tex.size.width * scale, height: tex.size.height * scale), blendMode: .normal, alpha: 1)
            UIGraphicsPopContext()
        }
        let colors = [UIColor(white: 1, alpha: 0.2).cgColor, UIColor.clear.cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
            ctx.drawLinearGradient(
                gradient,
                start: .zero,
                end: CGPoint(x: 0, y: height * 0.4),
                options: []
            )
        }
        coatedWithTexture = Self.texture != nil
        coatImage = ctx.makeImage()
        setNeedsDisplay()
    }

    private func coatAt(_ point: CGPoint) -> Bool {
        guard let ctx = coatContext, let data = ctx.data, coatWidth > 0 else { return false }
        let ix = min(max(0, Int(point.x)), coatWidth - 1)
        // Bitmap rows are still Quartz-ordered (row 0 = bottom) despite the draw CTM flip.
        let iy = min(max(0, coatHeight - 1 - Int(point.y)), coatHeight - 1)
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        return ptr[(iy * coatWidth + ix) * 4 + 3] >= 16
    }

    private func clearedFraction() -> Float {
        guard let ctx = coatContext, let data = ctx.data, coatWidth > 0, coatHeight > 0 else { return 0 }
        let step = 8
        var clear = 0
        var total = 0
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        var y = 0
        while y < coatHeight {
            var x = 0
            while x < coatWidth {
                total += 1
                if ptr[(y * coatWidth + x) * 4 + 3] < 16 { clear += 1 }
                x += step
            }
            y += step
        }
        guard total > 0 else { return 0 }
        return Float(clear) / Float(total)
    }

    private static let loader = DispatchQueue(label: "bar.foil.texture")
    private static var texture: UIImage?
    private static var textureLoading = false

    private static func ensureTexture() {
        if texture != nil || textureLoading { return }
        textureLoading = true
        loader.async {
            defer { textureLoading = false }
            let urlString = DevEndpoints.mediaBaseUrl + "/scratch/scratchTexture.jpg"
            guard let url = URL(string: urlString) else { return }
            let request = URLRequest(url: url)
            let sem = DispatchSemaphore(value: 0)
            var image: UIImage?
            DevMediaClient.shared.dataTask(with: request) { data, response, _ in
                if let data, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    image = UIImage(data: data)
                }
                sem.signal()
            }.resume()
            _ = sem.wait(timeout: .now() + 20)
            texture = image
        }
    }
}

struct BarFoilView: UIViewRepresentable {
    var onCleared: () -> Void

    func makeUIView(context: Context) -> BarFoilUIView {
        let view = BarFoilUIView()
        view.onCleared = onCleared
        return view
    }

    func updateUIView(_ uiView: BarFoilUIView, context: Context) {
        uiView.onCleared = onCleared
    }
}
