import AVFoundation
import Lottie
import UIKit

/// Dual looping videos + screen-space scratch mask + mesh-UV body symbols.
final class LayeredScratchView: UIView {
    var onScratched: ((Float) -> Void)?
    var onIconFound: ((Int) -> Void)?
    var onSymbolsRevealed: ((Int) -> Void)?
    var onError: ((String) -> Void)?
    var mesh: GarmentMesh?
    var chromaKey: Bool = false {
        didSet { videoView.chromaKey = chromaKey }
    }
    var scratchEnabled: Bool = true

    private let videoView = DualVideoMetalView()
    private let iconOverlay = IconOverlayView()
    private var symbolAnimations: [LottieAnimation] = []
    private var symbolViews: [LottieAnimationView] = []

    private var backgroundPlayer: AVPlayer?
    private var foregroundPlayer: AVPlayer?
    private var bgOutput: AVPlayerItemVideoOutput?
    private var fgOutput: AVPlayerItemVideoOutput?
    private var endObservers: [NSObjectProtocol] = []

    private var sourceKey = ""
    private var playbackStarted = false
    private var lastBackgroundPosition: Double = -1
    private var seekHoldUntil: CFTimeInterval = 0

    private var scratchImage: CGImage?
    private var scratchContext: CGContext?
    private var maskWidth = 0
    private var maskHeight = 0

    private var iconX = Array(repeating: Float.nan, count: 12)
    private var iconY = Array(repeating: Float.nan, count: 12)
    private var iconRevealed = Array(repeating: false, count: 12)
    private var iconMiss = Array(repeating: false, count: 12)
    private var topClaimed = Array(repeating: false, count: 6)
    private var iconCount = 0

    private var lastX: CGFloat = 0
    private var lastY: CGFloat = 0
    private var lastTouchMs: CFTimeInterval = 0
    private var moveTicks = 0
    private var scratching = false
    private var lastDustX = CGFloat.nan
    private var lastDustY = CGFloat.nan
    private var dust: [Dust] = []
    private let haptics = ScratchHaptics()
    private var tickTimer: CADisplayLink?
    private var mediaCacheTask: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        videoView.chromaKey = chromaKey
        videoView.translatesAutoresizingMaskIntoConstraints = false
        iconOverlay.translatesAutoresizingMaskIntoConstraints = false
        iconOverlay.isUserInteractionEnabled = false
        iconOverlay.onDrawExtras = { [weak self] ctx in
            self?.drawMissIcons(ctx)
            self?.drawDust(ctx)
        }
        addSubview(videoView)
        addSubview(iconOverlay)
        NSLayoutConstraint.activate([
            videoView.topAnchor.constraint(equalTo: topAnchor),
            videoView.bottomAnchor.constraint(equalTo: bottomAnchor),
            videoView.leadingAnchor.constraint(equalTo: leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: trailingAnchor),
            iconOverlay.topAnchor.constraint(equalTo: topAnchor),
            iconOverlay.bottomAnchor.constraint(equalTo: bottomAnchor),
            iconOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
            iconOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        isMultipleTouchEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func setSymbolAnimations(_ animations: [LottieAnimation]) {
        guard !animations.isEmpty else { return }
        if symbolAnimations.count == animations.count { return }
        symbolViews.forEach { $0.removeFromSuperview() }
        symbolAnimations = animations
        symbolViews = animations.map { animation in
            let view = LottieAnimationView(animation: animation)
            view.loopMode = .loop
            view.backgroundBehavior = .pauseAndRestore
            view.isHidden = true
            view.isUserInteractionEnabled = false
            iconOverlay.addSubview(view)
            view.play()
            return view
        }
    }

    func setSources(backgroundUrl: String, foregroundUrl: String) {
        let key = "\(backgroundUrl)\n\(foregroundUrl)"
        if key == sourceKey, backgroundPlayer != nil { return }
        sourceKey = key
        playbackStarted = false
        lastBackgroundPosition = -1
        seekHoldUntil = 0
        resetRound()
        releasePlayers()
        mediaCacheTask?.cancel()
        mediaCacheTask = Task { [weak self] in
            guard let self else { return }
            do {
                let api = SugarAPI(cookieStore: SessionCookieStore())
                async let bgFile = api.cachedMediaFile(urlString: backgroundUrl)
                async let fgFile = api.cachedMediaFile(urlString: foregroundUrl)
                let (bg, fg) = try await (bgFile, fgFile)
                await MainActor.run {
                    self.buildPlayers(backgroundFile: bg, foregroundFile: fg)
                    self.startTick()
                }
            } catch {
                await MainActor.run {
                    self.onError?(error.localizedDescription)
                }
            }
        }
    }

    func resetRound() {
        if let ctx = scratchContext {
            ctx.setBlendMode(.copy)
            ctx.setFillColor(UIColor.white.cgColor)
            ctx.fill(CGRect(x: 0, y: 0, width: maskWidth, height: maskHeight))
            scratchImage = ctx.makeImage()
            videoView.attachMaskImage(scratchImage)
        }
        iconRevealed = Array(repeating: false, count: Self.MAX_BODY)
        iconMiss = Array(repeating: false, count: Self.MAX_BODY)
        topClaimed = Array(repeating: false, count: Self.TOP_SLOTS)
        dust.removeAll()
        iconOverlay.setNeedsDisplay()
        videoView.invalidateMask()
    }

    func releaseResources() {
        tickTimer?.invalidate()
        tickTimer = nil
        mediaCacheTask?.cancel()
        releasePlayers()
        symbolViews.forEach { $0.removeFromSuperview() }
        symbolViews = []
        symbolAnimations = []
        videoView.attachMaskImage(nil)
        scratchContext = nil
        scratchImage = nil
    }

    func snapshot() -> UIImage? { videoView.snapshotImage() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = Int(bounds.width)
        let h = Int(bounds.height)
        guard w > 0, h > 0 else { return }
        let maskW = max(1, w / 2)
        let maskH = max(1, h / 2)
        if maskW == maskWidth, maskH == maskHeight, scratchContext != nil { return }
        maskWidth = maskW
        maskHeight = maskH
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: nil,
            width: maskW,
            height: maskH,
            bitsPerComponent: 8,
            bytesPerRow: maskW * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        // Quartz is bottom-left; flip so UIKit touch coords draw upright.
        ctx?.translateBy(x: 0, y: CGFloat(maskH))
        ctx?.scaleBy(x: 1, y: -1)
        scratchContext = ctx
        scratchContext?.setBlendMode(.copy)
        scratchContext?.setFillColor(UIColor.white.cgColor)
        scratchContext?.fill(CGRect(x: 0, y: 0, width: maskW, height: maskH))
        scratchImage = scratchContext?.makeImage()
        videoView.attachMaskImage(scratchImage)
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard scratchEnabled, let touch = touches.first, let ctx = scratchContext else { return }
        scratching = true
        let point = touch.location(in: self)
        let onCoat = freshCoat(point)
        haptics.pulse(speed: 0, pressure: Float(touch.force > 0 ? touch.force / touch.maximumPossibleForce : 0.7), onFreshCoat: onCoat)
        spawnDust(at: point, onCoat: onCoat)
        lastX = point.x
        lastY = point.y
        lastTouchMs = CACurrentMediaTime()
        let (mx, my) = toMask(point)
        let r = maskRadius()
        videoView.lockMask {
            eraseMask(ctx) {
                ctx.fillEllipse(in: CGRect(x: mx - r, y: my - r, width: r * 2, height: r * 2))
            }
        }
        publishMask(from: ctx)
        markIconsNear(point)
        iconOverlay.setNeedsDisplay()
        updateSymbolViews()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard scratchEnabled, let touch = touches.first, let ctx = scratchContext else { return }
        let point = touch.location(in: self)
        let dt = max(0.001, CACurrentMediaTime() - lastTouchMs)
        let speed = hypot(point.x - lastX, point.y - lastY) / CGFloat(dt)
        let onCoat = freshCoat(point)
        haptics.pulse(speed: Float(speed), pressure: Float(touch.force > 0 ? touch.force / touch.maximumPossibleForce : 0.7), onFreshCoat: onCoat)
        spawnDust(at: point, onCoat: onCoat)
        let (mx, my) = toMask(point)
        let (lx, ly) = toMask(CGPoint(x: lastX, y: lastY))
        videoView.lockMask {
            eraseMask(ctx) {
                ctx.setLineCap(.round)
                ctx.setLineWidth(140 * CGFloat(maskWidth) / max(bounds.width, 1))
                ctx.setStrokeColor(UIColor.black.cgColor)
                ctx.move(to: CGPoint(x: lx, y: ly))
                ctx.addLine(to: CGPoint(x: mx, y: my))
                ctx.strokePath()
            }
        }
        publishMask(from: ctx)
        lastX = point.x
        lastY = point.y
        lastTouchMs = CACurrentMediaTime()
        moveTicks += 1
        if moveTicks % 4 == 0 {
            onScratched?(scratchedFraction())
        }
        markIconsNear(point)
        iconOverlay.setNeedsDisplay()
        updateSymbolViews()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        scratching = false
        haptics.stop()
        lastDustX = .nan
        lastDustY = .nan
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchesEnded(touches, with: event)
    }

    deinit { releaseResources() }

    private func buildPlayers(backgroundFile: URL, foregroundFile: URL) {
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        let bgItem = AVPlayerItem(url: backgroundFile)
        let fgItem = AVPlayerItem(url: foregroundFile)
        let bgOut = AVPlayerItemVideoOutput(pixelBufferAttributes: attrs)
        let fgOut = AVPlayerItemVideoOutput(pixelBufferAttributes: attrs)
        bgItem.add(bgOut)
        fgItem.add(fgOut)
        bgOutput = bgOut
        fgOutput = fgOut

        let bgPlayer = AVPlayer(playerItem: bgItem)
        let fgPlayer = AVPlayer(playerItem: fgItem)
        bgPlayer.isMuted = true
        fgPlayer.isMuted = true
        backgroundPlayer = bgPlayer
        foregroundPlayer = fgPlayer
        videoView.attach(backgroundOutput: bgOut, foregroundOutput: fgOut)
        playbackStarted = false
        for observer in endObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        endObservers = [
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: bgItem,
                queue: .main
            ) { [weak bgPlayer] _ in
                bgPlayer?.seek(to: .zero)
                bgPlayer?.play()
            },
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: fgItem,
                queue: .main
            ) { [weak fgPlayer] _ in
                fgPlayer?.seek(to: .zero)
                fgPlayer?.play()
            },
        ]
        maybeStartTogether()
    }

    private func releasePlayers() {
        backgroundPlayer?.pause()
        foregroundPlayer?.pause()
        for observer in endObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        endObservers = []
        backgroundPlayer = nil
        foregroundPlayer = nil
        bgOutput = nil
        fgOutput = nil
        videoView.attach(backgroundOutput: nil, foregroundOutput: nil)
    }

    private func startTick() {
        tickTimer?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(onTick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 20, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        tickTimer = link
    }

    @objc private func onTick() {
        stepDust()
        syncPlayers()
        placeIcons()
        updateSymbolViews()
        if !dust.isEmpty || mesh != nil {
            iconOverlay.setNeedsDisplay()
        }
    }

    private func maybeStartTogether() {
        guard !playbackStarted,
              let bg = backgroundPlayer,
              let fg = foregroundPlayer,
              bg.status == .readyToPlay || bg.currentItem?.status == .readyToPlay,
              fg.status == .readyToPlay || fg.currentItem?.status == .readyToPlay
        else {
            // Poll until ready
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.maybeStartTogether()
            }
            return
        }
        playbackStarted = true
        bg.rate = 1
        fg.rate = 1
        bg.seek(to: .zero)
        fg.seek(to: .zero)
        bg.play()
        fg.play()
    }

    private func syncPlayers() {
        guard let background = backgroundPlayer, let foreground = foregroundPlayer else { return }
        if !playbackStarted {
            maybeStartTogether()
            return
        }
        if foreground.rate > 0, background.rate == 0 { background.play() }
        let bgDuration = background.currentItem?.duration.seconds ?? 0
        let fgDuration = foreground.currentItem?.duration.seconds ?? 0
        guard bgDuration.isFinite, fgDuration.isFinite, bgDuration > 0, fgDuration > 0 else { return }
        let foregroundTime = foreground.currentTime().seconds
        let looped = lastBackgroundPosition >= 0 && foregroundTime + 0.2 < lastBackgroundPosition
        lastBackgroundPosition = foregroundTime
        let target: Double
        if abs(bgDuration - fgDuration) <= 0.25 {
            target = min(max(0, foregroundTime), max(0, bgDuration - 0.001))
        } else {
            target = foregroundTime.truncatingRemainder(dividingBy: bgDuration)
        }
        let drift = target - background.currentTime().seconds
        let now = CACurrentMediaTime()
        if now < seekHoldUntil && !looped { return }
        if looped || abs(drift) > 0.28 {
            background.rate = 1
            background.seek(to: CMTime(seconds: target, preferredTimescale: 600))
            seekHoldUntil = now + 0.4
            return
        }
        let speed: Float
        if abs(drift) <= 0.04 {
            speed = 1
        } else if drift > 0 {
            speed = 1.03
        } else {
            speed = 0.97
        }
        if abs(background.rate - speed) > 0.001 {
            background.rate = speed
        }
    }

    private func placeIcons() {
        guard let field = mesh, bounds.width > 2, bounds.height > 2 else { return }
        let count = min(Self.MAX_BODY, field.symbolCount)
        iconCount = count
        let clock = foregroundPlayer ?? backgroundPlayer
        let time = Float(clock?.currentTime().seconds ?? 0)
        let verts = field.sampleVerts(timeSec: time)
        let scale = min(Float(bounds.width) / field.canvasWidth, Float(bounds.height) / field.canvasHeight)
        let originX = (Float(bounds.width) - field.canvasWidth * scale) / 2
        let originY = (Float(bounds.height) - field.canvasHeight * scale) / 2
        for i in 0..<count {
            let u = field.symbols[i * 2]
            let v = field.symbols[i * 2 + 1]
            let (wx, wy) = field.uvToWorld(verts: verts, u: u, v: v)
            iconX[i] = originX + wx * scale
            iconY[i] = originY + wy * scale
        }
    }

    private func updateSymbolViews() {
        let fit = min(bounds.width / 390, bounds.height / 672)
        let size = max(1, 72 * fit)
        for i in 0..<iconCount {
            guard i < symbolViews.count else { break }
            let view = symbolViews[i]
            if iconMiss[i], !iconX[i].isNaN {
                view.isHidden = false
                view.alpha = 0.55
                view.frame = CGRect(
                    x: CGFloat(iconX[i]) - size / 2,
                    y: CGFloat(iconY[i]) - size / 2,
                    width: size,
                    height: size
                )
            } else {
                view.isHidden = true
            }
        }
    }

    private func drawMissIcons(_ ctx: CGContext) {
        // Lottie views handle miss icons; dust drawn separately.
    }

    private func toMask(_ point: CGPoint) -> (CGFloat, CGFloat) {
        guard bounds.width > 0, bounds.height > 0 else { return (point.x, point.y) }
        return (point.x * CGFloat(maskWidth) / bounds.width, point.y * CGFloat(maskHeight) / bounds.height)
    }

    private func maskRadius() -> CGFloat {
        guard bounds.width > 0 else { return 70 }
        return 70 * CGFloat(maskWidth) / bounds.width
    }

    private func eraseMask(_ ctx: CGContext, _ draw: () -> Void) {
        ctx.saveGState()
        ctx.setBlendMode(.clear)
        ctx.setFillColor(UIColor.black.cgColor)
        draw()
        ctx.restoreGState()
    }

    private func publishMask(from ctx: CGContext) {
        scratchImage = ctx.makeImage()
        videoView.attachMaskImage(scratchImage)
    }

    private func freshCoat(_ point: CGPoint) -> Bool {
        guard fingerOnFabric(point), let ctx = scratchContext, let data = ctx.data else { return false }
        let (mx, my) = toMask(point)
        let ix = min(max(0, Int(mx)), maskWidth - 1)
        // Bitmap rows are still Quartz-ordered (row 0 = bottom) despite the draw CTM flip.
        let iy = min(max(0, maskHeight - 1 - Int(my)), maskHeight - 1)
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        let alpha = ptr[(iy * maskWidth + ix) * 4 + 3]
        return alpha >= 16
    }

    private func fingerOnFabric(_ point: CGPoint) -> Bool {
        guard maskWidth > 1, maskHeight > 1, let ctx = scratchContext, let data = ctx.data else { return true }
        let (mx, my) = toMask(point)
        let ix = min(max(0, Int(mx)), maskWidth - 1)
        let iy = min(max(0, maskHeight - 1 - Int(my)), maskHeight - 1)
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        return ptr[(iy * maskWidth + ix) * 4 + 3] >= 16
    }

    private func markIconsNear(_ point: CGPoint) {
        let radius: CGFloat = 72
        var revealed = 0
        var changed = false
        for i in 0..<iconCount {
            if iconRevealed[i] {
                revealed += 1
                continue
            }
            if iconX[i].isNaN { continue }
            let dx = CGFloat(iconX[i]) - point.x
            let dy = CGFloat(iconY[i]) - point.y
            if dx * dx + dy * dy > radius * radius { continue }
            iconRevealed[i] = true
            revealed += 1
            changed = true
            if i < Self.TOP_SLOTS, !topClaimed[i] {
                topClaimed[i] = true
                onIconFound?(i)
            } else {
                iconMiss[i] = true
            }
        }
        if changed { onSymbolsRevealed?(revealed) }
    }

    private func scratchedFraction() -> Float {
        guard let ctx = scratchContext, let data = ctx.data, maskWidth > 0, maskHeight > 0 else { return 0 }
        let step = 12
        var clear = 0
        var total = 0
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        var y = 0
        while y < maskHeight {
            var x = 0
            while x < maskWidth {
                total += 1
                if ptr[(y * maskWidth + x) * 4 + 3] < 16 { clear += 1 }
                x += step
            }
            y += step
        }
        guard total > 0 else { return 0 }
        return Float(clear) / Float(total)
    }

    private func spawnDust(at point: CGPoint, onCoat: Bool) {
        guard scratching, onCoat else { return }
        if !lastDustX.isNaN {
            let dx = point.x - lastDustX
            let dy = point.y - lastDustY
            if dx * dx + dy * dy <= 1 { return }
        }
        lastDustX = point.x
        lastDustY = point.y
        let room = Self.MAX_DUST - dust.count
        let count = min(Self.DUST_PER_MOVE, room)
        for _ in 0..<count {
            let speed = CGFloat.random(in: 0.5...1.5)
            let sign: CGFloat = Bool.random() ? -1 : 1
            dust.append(Dust(x: point.x, y: point.y, vx: sign * speed, vy: -CGFloat.random(in: 0...1.5), life: Self.DUST_LIFE))
        }
    }

    private func stepDust() {
        guard !dust.isEmpty else { return }
        let dt: CGFloat = 33 / 16
        let fade = pow(Self.DUST_FADE, dt)
        dust = dust.compactMap { particle in
            var p = particle
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.vy += Self.DUST_GRAVITY * dt
            p.life *= fade
            return p.life / Self.DUST_LIFE <= 0.02 ? nil : p
        }
    }

    private func drawDust(_ ctx: CGContext) {
        for particle in dust {
            let scale = particle.life / Self.DUST_LIFE
            let size = Self.DUST_SIZE * scale
            ctx.setFillColor(UIColor(red: 1, green: 0.835, blue: 0.416, alpha: scale).cgColor)
            ctx.fillEllipse(in: CGRect(x: particle.x - size * 0.42, y: particle.y - size * 0.42, width: size * 0.84, height: size * 0.84))
            ctx.saveGState()
            ctx.translateBy(x: particle.x, y: particle.y)
            ctx.rotate(by: .pi / 4)
            let gem = size * 0.22
            ctx.setFillColor(UIColor(red: 1, green: 0.965, blue: 0.816, alpha: scale).cgColor)
            ctx.fill(CGRect(x: -gem, y: -gem, width: gem * 2, height: gem * 2))
            ctx.restoreGState()
        }
    }

    private static let TOP_SLOTS = 6
    private static let MAX_BODY = 12
    private static let DUST_PER_MOVE = 5
    private static let DUST_SIZE: CGFloat = 64
    private static let DUST_GRAVITY: CGFloat = 0.1
    private static let DUST_FADE: CGFloat = 0.96
    private static let DUST_LIFE: CGFloat = 100
    private static let MAX_DUST = 250
}

private struct Dust {
    var x: CGFloat
    var y: CGFloat
    var vx: CGFloat
    var vy: CGFloat
    var life: CGFloat
}

private final class IconOverlayView: UIView {
    var onDrawExtras: ((CGContext) -> Void)?

    override class var layerClass: AnyClass { CALayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        onDrawExtras?(ctx)
    }
}
