import AVFoundation
import SwiftUI
import UIKit

/// Four-frame film strip between motion cards.
final class FilmStripTransitionUIView: UIView {
    var onFinished: (() -> Void)?

    private let strip = StripView()
    private var player: AVPlayer?
    private var toFrame: UIImage?
    private var started = false
    private var sliding = false
    private var finished = false
    private var giveUpWork: DispatchWorkItem?
    private static var templateIndex = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        isUserInteractionEnabled = true
        strip.frame = bounds
        strip.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(strip)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func start(from: UIImage, toUrl: String) {
        strip.fromFrame = from
        Task {
            do {
                let api = SugarAPI(cookieStore: SessionCookieStore())
                let file = try await api.cachedMediaFile(urlString: toUrl)
                await MainActor.run {
                    self.captureFirstFrame(file: file)
                }
            } catch {
                await MainActor.run { self.beginSlide() }
            }
        }
        let work = DispatchWorkItem { [weak self] in self?.beginSlide() }
        giveUpWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    private func captureFirstFrame(file: URL) {
        let item = AVPlayerItem(url: file)
        let player = AVPlayer(playerItem: item)
        player.isMuted = true
        self.player = player
        let generator = AVAssetImageGenerator(asset: item.asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: bounds.width * UIScreen.main.scale, height: bounds.height * UIScreen.main.scale)
        let time = CMTime(seconds: 0.05, preferredTimescale: 600)
        generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) { [weak self] _, image, _, _, _ in
            DispatchQueue.main.async {
                guard let self, !self.sliding, !self.finished else { return }
                if let image {
                    let ui = UIImage(cgImage: image)
                    self.toFrame = ui
                    self.strip.toFrame = ui
                }
                self.releasePlayer()
                self.beginSlide()
            }
        }
        player.play()
    }

    private func beginSlide() {
        guard !finished, !sliding else { return }
        sliding = true
        giveUpWork?.cancel()
        releasePlayer()
        let template = Self.templateIndex % 3
        Self.templateIndex += 1
        strip.play(template: template) { [weak self] in
            self?.finish()
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        onFinished?()
    }

    private func releasePlayer() {
        player?.pause()
        player = nil
    }

    deinit {
        giveUpWork?.cancel()
        strip.stop()
        releasePlayer()
    }

    private final class StripView: UIView {
        var fromFrame: UIImage?
        var toFrame: UIImage?
        private var progress: CGFloat = 0
        private var kind = 0
        private var displayLink: CADisplayLink?
        private var startTime: CFTimeInterval = 0
        private var duration: CFTimeInterval = 0.56
        private var onEnd: (() -> Void)?

        func stop() {
            displayLink?.invalidate()
            displayLink = nil
        }

        func play(template: Int, onEnd: @escaping () -> Void) {
            kind = template
            duration = template == 1 ? 0.75 : template == 2 ? 0.85 : 0.56
            self.onEnd = onEnd
            startTime = CACurrentMediaTime()
            stop()
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        @objc private func tick() {
            let t = min(1, (CACurrentMediaTime() - startTime) / duration)
            // Approximate PathInterpolator(0.51, 0.02, 0.44, 1.14)
            progress = CGFloat(cubicBezier(t, 0.51, 0.02, 0.44, 1.14))
            setNeedsDisplay()
            if t >= 1 {
                stop()
                onEnd?()
            }
        }

        override func draw(_ rect: CGRect) {
            guard let from = fromFrame else { return }
            let to = toFrame ?? from
            let w = bounds.width
            let h = bounds.height
            guard w > 2, h > 2, let ctx = UIGraphicsGetCurrentContext() else { return }
            let scale: CGFloat = kind == 2
                ? 1 + 0.28 * sin(progress * .pi)
                : 1 + 0.03 * sin(progress * .pi)
            let travelY: CGFloat = kind == 1 ? sin(progress * .pi * 4) * h * 0.04 : 0
            UIColor.black.setFill()
            ctx.fill(bounds)
            ctx.saveGState()
            ctx.translateBy(x: w / 2, y: h / 2)
            ctx.scaleBy(x: scale, y: scale)
            ctx.translateBy(x: -w / 2, y: -h / 2)
            ctx.translateBy(x: -3 * w * progress, y: travelY)
            drawTile(ctx, image: from, index: 0, flip: false, w: w, h: h)
            drawTile(ctx, image: from, index: 1, flip: true, w: w, h: h)
            drawTile(ctx, image: to, index: 2, flip: true, w: w, h: h)
            drawTile(ctx, image: to, index: 3, flip: false, w: w, h: h)
            ctx.restoreGState()
            if kind == 1 {
                let alpha = sin(progress * .pi) * 70 / 255
                UIColor(white: 1, alpha: alpha).setFill()
                ctx.fill(bounds)
            }
        }

        private func drawTile(_ ctx: CGContext, image: UIImage, index: Int, flip: Bool, w: CGFloat, h: CGFloat) {
            ctx.saveGState()
            ctx.translateBy(x: CGFloat(index) * w, y: 0)
            ctx.clip(to: CGRect(x: 0, y: 0, width: w, height: h))
            if flip {
                ctx.translateBy(x: w, y: 0)
                ctx.scaleBy(x: -1, y: 1)
            }
            let scale = min(w / image.size.width, h / image.size.height)
            let dw = image.size.width * scale
            let dh = image.size.height * scale
            image.draw(in: CGRect(x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh))
            ctx.restoreGState()
        }

        private func cubicBezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
            // Solve for parameter where x(t)=t roughly using Newton; then evaluate y.
            var u = t
            for _ in 0..<5 {
                let x = bezier(u, 0, x1, x2, 1)
                let dx = bezierDeriv(u, 0, x1, x2, 1)
                if abs(dx) < 1e-6 { break }
                u -= (x - t) / dx
                u = min(1, max(0, u))
            }
            return bezier(u, 0, y1, y2, 1)
        }

        private func bezier(_ t: Double, _ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double) -> Double {
            let u = 1 - t
            return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
        }

        private func bezierDeriv(_ t: Double, _ p0: Double, _ p1: Double, _ p2: Double, _ p3: Double) -> Double {
            let u = 1 - t
            return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2)
        }
    }
}

struct FilmStripTransitionView: UIViewRepresentable {
    var from: UIImage
    var toUrl: String
    var onFinished: () -> Void

    func makeUIView(context: Context) -> FilmStripTransitionUIView {
        let view = FilmStripTransitionUIView()
        view.onFinished = onFinished
        view.start(from: from, toUrl: toUrl)
        return view
    }

    func updateUIView(_ uiView: FilmStripTransitionUIView, context: Context) {
        uiView.onFinished = onFinished
    }
}
