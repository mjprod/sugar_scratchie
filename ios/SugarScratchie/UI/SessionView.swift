import AVFoundation
import Lottie
import SwiftUI
import UIKit

private enum RoundPhase {
    case intro, center, play, done
}

private let bodySymbolCount = 12
private let scratchAll: Float = 0.98

struct SessionView: View {
    @Bindable var vm: SmokeViewModel
    var user: UserPublic

    @State private var playbackError: String?
    @State private var foundMask = 0
    @State private var phase: RoundPhase = .center
    @State private var scratchView: LayeredScratchView?
    @State private var filming = false
    @State private var filmFrom: UIImage?
    @State private var advanced = false
    @State private var claimed = false
    @State private var sounds = GameSounds()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let backgroundUrl = vm.backgroundUrl,
               let foregroundUrl = vm.foregroundUrl,
               !backgroundUrl.isEmpty,
               !foregroundUrl.isEmpty
            {
                DualLayerScratchRepresentable(
                    backgroundUrl: backgroundUrl,
                    foregroundUrl: foregroundUrl,
                    mesh: vm.mesh,
                    chromaKey: vm.chromaKey,
                    symbolAnimations: vm.symbolAnimations,
                    scratchEnabled: phase == .play && !filming,
                    onView: { scratchView = $0 },
                    onError: { playbackError = $0 },
                    onIconFound: { index in
                        let bit = 1 << index
                        if foundMask & bit == 0 {
                            foundMask |= bit
                            sounds.playMatchFind()
                        }
                    },
                    onSymbolsRevealed: { count in
                        if phase == .play, count >= bodySymbolCount {
                            goNext()
                        }
                    },
                    onScratched: { fraction in
                        if phase == .play, fraction >= scratchAll {
                            goNext()
                        }
                    }
                )
                .ignoresSafeArea()
            } else {
                Text("Card needs both background and foreground videos.")
                    .foregroundStyle(Color(red: 1, green: 0.541, blue: 0.502))
                    .padding(24)
            }

            if phase == .intro, let introUrl = vm.introUrl, !introUrl.isEmpty {
                IntroClipView(url: introUrl) {
                    phase = .center
                }
                .ignoresSafeArea()
            }

            if phase != .intro && phase != .done {
                Text("\(vm.handIndex + 1) / \(max(vm.hand.count, 1))")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.white.opacity(0.8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(16)
                    .safeAreaPadding(.top)

                GameTopBar(
                    foundMask: foundMask,
                    diamonds: vm.wallet?.diamonds ?? 0,
                    coins: vm.wallet?.coins ?? 0,
                    note: phase == .center ? "Scratch the bar" : vm.lastClaimMessage,
                    symbolAnimations: vm.symbolAnimations,
                    scratchable: phase == .center,
                    onBarCleared: { phase = .play }
                )
                .padding(.top, phase == .play ? 8 : 0)
                .frame(maxHeight: .infinity, alignment: phase == .play ? .top : .center)
                .animation(.easeInOut(duration: 0.72), value: phase == .play)
                .safeAreaPadding(.top)
            }

            let problem: String? = {
                if let error = vm.error, error.contains("scratch hand limit") {
                    return playbackError
                }
                return playbackError ?? vm.error
            }()
            if let problem, !problem.isEmpty {
                Text(problem)
                    .foregroundStyle(Color(red: 1, green: 0.541, blue: 0.502))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(16)
            }

            Button("Log out") { vm.logout() }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(.trailing, 8)
                .safeAreaPadding(.top)

            if filming, let filmFrom, let next = vm.nextForegroundUrl, !next.isEmpty {
                FilmStripTransitionView(from: filmFrom, toUrl: next) {
                    vm.nextCard()
                }
                .ignoresSafeArea()
            }
        }
        .onAppear { resetPhaseForCard() }
        .onChange(of: vm.card?.id) { _, _ in
            foundMask = 0
            filming = false
            resetPhaseForCard()
        }
        .onChange(of: vm.roundEpoch) { _, _ in
            advanced = false
        }
        .onChange(of: vm.handId) { _, _ in
            claimed = false
        }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .play { vm.prepareNext() }
        }
        .task(id: "\(vm.card?.id ?? "")-\(vm.handId ?? "")-\(vm.loading)-\(String(describing: phase))-\(vm.foregroundUrl ?? "")") {
            if vm.card != nil,
               let fg = vm.foregroundUrl, !fg.isEmpty,
               vm.handId == nil,
               !vm.loading,
               phase != .intro,
               phase != .done
            {
                vm.startHand()
            }
        }
        .onDisappear { sounds.release() }
    }

    private func resetPhaseForCard() {
        if vm.handComplete {
            phase = .done
        } else if (vm.card?.trailer?.isEmpty ?? true) && (vm.introUrl?.isEmpty ?? true) {
            phase = .center
        } else {
            phase = .intro
        }
    }

    private func goNext() {
        if advanced || vm.handComplete { return }
        if !claimed, vm.handId != nil {
            claimed = true
            vm.claimMilestone()
        }
        advanced = true
        let shot = scratchView?.snapshot()
        if let shot, let next = vm.nextForegroundUrl, !next.isEmpty {
            filmFrom = shot
            filming = true
        } else {
            vm.nextCard()
        }
    }
}

private struct DualLayerScratchRepresentable: UIViewRepresentable {
    var backgroundUrl: String
    var foregroundUrl: String
    var mesh: GarmentMesh?
    var chromaKey: Bool
    var symbolAnimations: [LottieAnimation]
    var scratchEnabled: Bool
    var onView: (LayeredScratchView) -> Void
    var onError: (String) -> Void
    var onIconFound: (Int) -> Void
    var onSymbolsRevealed: (Int) -> Void
    var onScratched: (Float) -> Void

    func makeUIView(context: Context) -> LayeredScratchView {
        let view = LayeredScratchView()
        context.coordinator.view = view
        apply(to: view)
        onView(view)
        return view
    }

    func updateUIView(_ uiView: LayeredScratchView, context: Context) {
        apply(to: uiView)
        onView(uiView)
    }

    static func dismantleUIView(_ uiView: LayeredScratchView, coordinator: Coordinator) {
        uiView.releaseResources()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var view: LayeredScratchView?
    }

    private func apply(to view: LayeredScratchView) {
        view.onError = onError
        view.onIconFound = onIconFound
        view.onSymbolsRevealed = onSymbolsRevealed
        view.onScratched = onScratched
        view.mesh = mesh
        view.chromaKey = chromaKey
        view.setSymbolAnimations(symbolAnimations)
        view.scratchEnabled = scratchEnabled
        view.setSources(backgroundUrl: backgroundUrl, foregroundUrl: foregroundUrl)
    }
}

private struct IntroClipView: View {
    var url: String
    var onFinished: () -> Void
    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            Color.black
            if let player {
                VideoPlayerRepresentable(player: player)
                    .ignoresSafeArea()
            }
            Button("Skip") { onFinished() }
                .foregroundStyle(.white)
                .font(.system(size: 16))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 28)
        }
        .task {
            do {
                let api = SugarAPI(cookieStore: SessionCookieStore())
                let file = try await api.cachedMediaFile(urlString: url)
                let item = AVPlayerItem(url: file)
                let av = AVPlayer(playerItem: item)
                player = av
                NotificationCenter.default.addObserver(
                    forName: .AVPlayerItemDidPlayToEndTime,
                    object: item,
                    queue: .main
                ) { _ in onFinished() }
                av.play()
            } catch {
                onFinished()
            }
        }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }
}

private struct VideoPlayerRepresentable: UIViewRepresentable {
    var player: AVPlayer

    func makeUIView(context: Context) -> UIView {
        let view = PlayerUIView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        (uiView as? PlayerUIView)?.playerLayer.player = player
    }

    private final class PlayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
