import AVFoundation
import Foundation

final class GameSounds {
    private let engine = AVAudioEngine()
    private let matchPlayers: [AVAudioPlayerNode]
    private let winPlayer = AVAudioPlayerNode()
    private var matchBuffers: [AVAudioPCMBuffer] = []
    private var winBuffer: AVAudioPCMBuffer?
    private var matchCursor = 0
    private var pendingMatches = 0
    private var lastMatchScheduledAt: CFTimeInterval = 0
    private var started = false

    init() {
        matchPlayers = (0..<4).map { _ in AVAudioPlayerNode() }
        let matchPCM = Self.renderMatchFind()
        let winPCM = Self.renderWin()
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false)!
        matchBuffers = matchPlayers.map { _ in Self.buffer(from: matchPCM, format: format) }.compactMap { $0 }
        winBuffer = Self.buffer(from: winPCM, format: format)
        for player in matchPlayers {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
        }
        engine.attach(winPlayer)
        engine.connect(winPlayer, to: engine.mainMixerNode, format: format)
        startIfNeeded()
    }

    func playMatchFind() {
        startIfNeeded()
        let now = CACurrentMediaTime()
        if now - lastMatchScheduledAt > 0.2 { pendingMatches = 0 }
        let delay = Double(pendingMatches) * 0.07
        pendingMatches += 1
        lastMatchScheduledAt = now + delay
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.pendingMatches = max(0, self.pendingMatches - 1)
            guard !self.matchBuffers.isEmpty else { return }
            let player = self.matchPlayers[self.matchCursor % self.matchPlayers.count]
            let buffer = self.matchBuffers[self.matchCursor % self.matchBuffers.count]
            self.matchCursor += 1
            player.stop()
            player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
            player.play()
        }
    }

    func playWin() {
        startIfNeeded()
        guard let winBuffer else { return }
        winPlayer.stop()
        winPlayer.scheduleBuffer(winBuffer, at: nil, options: [], completionHandler: nil)
        winPlayer.play()
    }

    func release() {
        engine.stop()
    }

    private func startIfNeeded() {
        guard !started else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            try engine.start()
            started = true
        } catch {}
    }

    private static func buffer(from samples: [Float], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        for i in samples.indices { channel[i] = samples[i] }
        return buffer
    }

    private static func renderMatchFind() -> [Float] {
        let mix = Mix(seconds: 0.4)
        mix.tone(startAt: 0.0, frequency: 659.25, duration: 0.1, volume: 0.2, wave: .triangle)
        mix.tone(startAt: 0.055, frequency: 880.0, duration: 0.12, volume: 0.18, wave: .sine)
        mix.tone(startAt: 0.11, frequency: 1174.66, duration: 0.14, volume: 0.12, wave: .sine)
        return mix.samples
    }

    private static func renderWin() -> [Float] {
        let mix = Mix(seconds: 2.6)
        let sparkle: [Double] = [523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0]
        let sparkleStep = 0.048
        for (index, freq) in sparkle.enumerated() {
            let t = Double(index) * sparkleStep
            mix.tone(startAt: t, frequency: freq, duration: 0.09, volume: 0.17, wave: .sine)
            if index % 2 == 0 {
                mix.tone(startAt: t + 0.012, frequency: freq * 2, duration: 0.055, volume: 0.09, wave: .triangle)
            }
        }
        let fanfareStart = Double(sparkle.count) * sparkleStep + 0.06
        let fanfare: [Double] = [523.25, 659.25, 783.99, 987.77, 1174.66]
        for (index, freq) in fanfare.enumerated() {
            let t = fanfareStart + Double(index) * 0.1
            mix.tone(startAt: t, frequency: freq, duration: 0.15, volume: 0.3, wave: .square)
            mix.tone(startAt: t, frequency: freq * 0.5, duration: 0.15, volume: 0.14, wave: .saw)
            mix.tone(startAt: t + 0.04, frequency: freq * 1.5, duration: 0.08, volume: 0.08, wave: .triangle)
        }
        let chordAt = fanfareStart + Double(fanfare.count) * 0.1 + 0.1
        let chord: [Double] = [261.63, 392.0, 523.25, 659.25, 783.99, 1046.5, 1318.51]
        for (index, freq) in chord.enumerated() {
            let wave: Wave = index < 2 ? .saw : .triangle
            let volume = index < 2 ? 0.11 : 0.13
            mix.tone(startAt: chordAt, frequency: freq, duration: 0.78, volume: volume, wave: wave)
        }
        let glitterStart = chordAt + 0.12
        let glitter: [Double] = [2093.0, 2349.0, 2637.0, 2793.0, 3136.0, 3520.0]
        for (index, freq) in glitter.enumerated() {
            mix.tone(startAt: glitterStart + Double(index) * 0.045, frequency: freq, duration: 0.11, volume: 0.11, wave: .sine)
        }
        let shimmerStart = glitterStart + Double(glitter.count) * 0.045 + 0.08
        for i in 0..<6 {
            mix.tone(startAt: shimmerStart + Double(i) * 0.06, frequency: 1760.0 + Double(i) * 110.0, duration: 0.07, volume: 0.09, wave: .sine)
        }
        return mix.samples
    }
}

private enum Wave { case sine, triangle, square, saw }

private final class Mix {
    private(set) var samples: [Float]

    init(seconds: Double) {
        samples = Array(repeating: 0, count: Int(seconds * 44100))
    }

    func tone(startAt: Double, frequency: Double, duration: Double, volume: Double, wave: Wave) {
        let start = max(0, Int(startAt * 44100))
        let end = min(samples.count, Int((startAt + duration + 0.02) * 44100))
        var i = start
        while i < end {
            let time = Double(i) / 44100.0
            let local = time - startAt
            let env = envelope(local: local, duration: duration, volume: volume)
            let phase = time * frequency
            samples[i] = Float(Double(samples[i]) + waveSample(phase: phase, wave: wave) * env)
            i += 1
        }
    }
}

private func envelope(local: Double, duration: Double, volume: Double) -> Double {
    if local < 0 || volume <= 0 { return 0 }
    if local < 0.015 { return 0.0001 * pow(volume / 0.0001, local / 0.015) }
    if local >= duration { return 0.0001 }
    let span = max(0.0001, duration - 0.015)
    return volume * pow(0.0001 / volume, (local - 0.015) / span)
}

private func waveSample(phase: Double, wave: Wave) -> Double {
    let wrapped = phase - floor(phase)
    switch wave {
    case .sine: return sin(2 * Double.pi * wrapped)
    case .square: return wrapped < 0.5 ? 1 : -1
    case .saw: return 2 * (wrapped - floor(wrapped + 0.5))
    case .triangle:
        let saw = 2 * (wrapped - floor(wrapped + 0.5))
        return 2 * abs(saw) - 1
    }
}
