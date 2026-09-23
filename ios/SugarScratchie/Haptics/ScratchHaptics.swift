import CoreHaptics
import UIKit

/// Short scratch ticks. Faster strokes buzz a little harder.
final class ScratchHaptics {
    private var engine: CHHapticEngine?
    private var lastAt: CFTimeInterval = 0

    init() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        engine = try? CHHapticEngine()
        try? engine?.start()
    }

    func pulse(speed: Float, pressure: Float, onFreshCoat: Bool) {
        guard onFreshCoat else { return }
        let speedNorm = min(1, max(0, speed / 1600))
        let press = min(1.15, max(0.35, pressure))
        let scale = min(0.62, max(0.14, (0.16 + speedNorm * 0.42) * press))
        let gap = max(0.016, 0.036 - Double(speedNorm) * 0.018)
        let now = CACurrentMediaTime()
        if now - lastAt < gap { return }
        lastAt = now

        if let engine {
            let intensity = CHHapticEventParameter(parameterID: .hapticIntensity, value: scale)
            let sharpness = CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.7)
            let event = CHHapticEvent(eventType: .hapticTransient, parameters: [intensity, sharpness], relativeTime: 0)
            if let pattern = try? CHHapticPattern(events: [event], parameters: []),
               let player = try? engine.makePlayer(with: pattern)
            {
                try? player.start(atTime: 0)
                return
            }
        }
        let generator = UIImpactFeedbackGenerator(style: scale > 0.4 ? .medium : .light)
        generator.impactOccurred(intensity: CGFloat(scale))
    }

    func stop() {
        // Transient ticks — nothing to cancel beyond engine lifecycle.
    }
}
