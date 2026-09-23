import Foundation
import Lottie
import Observation

enum SmokeScreen: Equatable {
    case boot
    case login
    case session(UserPublic)
}

@Observable
final class SmokeViewModel {
    var screen: SmokeScreen = .login
    var email: String = ""
    var password: String = ""
    var registerMode: Bool = false
    var serverTarget: ServerTarget = DevEndpoints.target
    var apiBaseUrl: String = DevEndpoints.apiBaseUrl
    var loading: Bool = false
    var error: String?
    var wallet: WalletResponse?
    var card: CardInfo?
    var hand: [CardInfo] = []
    var handIndex: Int = 0
    var roundEpoch: Int = 0
    var handComplete: Bool = false
    var backgroundUrl: String?
    var foregroundUrl: String?
    var introUrl: String?
    var nextForegroundUrl: String?
    var mesh: GarmentMesh?
    var chromaKey: Bool = true
    var symbolAnimations: [LottieAnimation] = []
    var handId: String?
    var handsRemainingToday: Int?
    var rewardHandDeclined: Bool = false
    var lastClaimMessage: String?

    private let cookieStore: SessionCookieStore
    private let api: SugarAPI

    private var preparedIndex = -1
    private var preparedMesh: GarmentMesh?
    private var preparingIndex = -1
    private var prepareTask: Task<Void, Never>?

    private static let handSize = 5

    init() {
        let store = SessionCookieStore()
        cookieStore = store
        api = SugarAPI(cookieStore: store)
    }

    func bootstrap() {
        Task { @MainActor in
            loading = true
            error = nil
            serverTarget = DevEndpoints.target
            apiBaseUrl = DevEndpoints.apiBaseUrl
            do {
                let session = try await api.session()
                if session.authenticated, let user = session.user {
                    await enterSession(user)
                } else {
                    screen = .login
                    loading = false
                }
            } catch {
                screen = .login
                loading = false
                self.error = error.localizedDescription
            }
        }
    }

    func onEmailChange(_ value: String) {
        email = value
        error = nil
    }

    func onPasswordChange(_ value: String) {
        password = value
        error = nil
    }

    func onServerTargetChange(_ target: ServerTarget) {
        guard target != DevEndpoints.target else { return }
        cookieStore.clear()
        DevEndpoints.target = target
        serverTarget = target
        apiBaseUrl = DevEndpoints.apiBaseUrl
        error = nil
        handId = nil
        wallet = nil
        card = nil
    }

    func toggleRegisterMode() {
        registerMode.toggle()
        error = nil
    }

    func submitAuth() {
        let email = self.email.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = self.password
        let register = registerMode
        Task { @MainActor in
            loading = true
            error = nil
            do {
                let res = register
                    ? try await api.register(email: email, password: password)
                    : try await api.login(email: email, password: password)
                guard let user = res.user else {
                    throw ApiException(statusCode: 500, message: "Auth succeeded but user missing")
                }
                await enterSession(user)
            } catch {
                loading = false
                self.error = error.localizedDescription
            }
        }
    }

    func startHand() {
        if rewardHandDeclined || handId != nil || loading { return }
        guard let card else { return }
        let cardId = card.id
        Task { @MainActor in
            loading = true
            error = nil
            lastClaimMessage = nil
            do {
                let hand = try await api.startScratchHand(cardId: cardId)
                if self.card == nil { return }
                if self.card?.id != cardId {
                    loading = false
                    return
                }
                loading = false
                handId = hand.handId
                handsRemainingToday = hand.handsRemainingToday
                lastClaimMessage = "Hand started (\(hand.milestonesRemaining ?? 0) milestones left)"
            } catch {
                let message = error.localizedDescription
                if message.contains("scratch hand limit") {
                    if self.card == nil { return }
                    if self.card?.id != cardId {
                        loading = false
                        return
                    }
                    loading = false
                    self.error = nil
                    rewardHandDeclined = true
                } else {
                    if self.card == nil { return }
                    if self.card?.id != cardId {
                        loading = false
                        return
                    }
                    loading = false
                    self.error = message.isEmpty ? "Could not start hand" : message
                }
            }
        }
    }

    func claimMilestone() {
        guard let card, let handId else { return }
        let cardId = card.id
        let claimHandId = handId
        Task { @MainActor in
            loading = true
            error = nil
            do {
                let claim = try await api.claimScratchCoins(handId: claimHandId, milestone: 1, cardId: cardId)
                let msg = (claim.alreadyClaimed == true)
                    ? "Milestone 1 already claimed"
                    : "Claimed +\(claim.coins ?? 0) coins"
                if let wallet = claim.wallet {
                    self.wallet = wallet
                }
                if self.card == nil { return }
                if self.card?.id != cardId {
                    loading = false
                    return
                }
                if self.handId != claimHandId { return }
                loading = false
                lastClaimMessage = msg
            } catch {
                if self.card == nil { return }
                if self.card?.id != cardId {
                    loading = false
                    return
                }
                if self.handId != claimHandId { return }
                loading = false
                self.error = error.localizedDescription
            }
        }
    }

    func logout() {
        Task { @MainActor in
            loading = true
            error = nil
            await api.logout()
            let keptEmail = email
            screen = .login
            email = keptEmail
            password = ""
            registerMode = false
            serverTarget = DevEndpoints.target
            apiBaseUrl = DevEndpoints.apiBaseUrl
            loading = false
            wallet = nil
            card = nil
            hand = []
            handIndex = 0
            roundEpoch = 0
            handComplete = false
            backgroundUrl = nil
            foregroundUrl = nil
            introUrl = nil
            nextForegroundUrl = nil
            mesh = nil
            symbolAnimations = []
            handId = nil
            handsRemainingToday = nil
            rewardHandDeclined = false
            lastClaimMessage = nil
        }
    }

    func prepareNext() {
        let next = handIndex + 1
        if next >= hand.count || preparedIndex == next || preparingIndex == next { return }
        let handSnapshot = hand
        preparingIndex = next
        prepareTask = Task {
            let mesh = await fetchMesh(handSnapshot[next])
            if let mesh, mesh.symbolCount >= 6 {
                preparedIndex = next
                preparedMesh = mesh
            }
            if preparingIndex == next { preparingIndex = -1 }
        }
    }

    func nextCard() {
        if handComplete { return }
        let next = handIndex + 1
        if next >= hand.count {
            Task { @MainActor in await startAnotherHand() }
            return
        }
        Task { @MainActor in
            await presentCard(index: next, hand: hand)
        }
    }

    private func enterSession(_ user: UserPublic) async {
        screen = .session(user)
        loading = true
        error = nil
        password = ""
        do {
            try await loadCardAndWallet()
            loading = false
        } catch {
            loading = false
            self.error = error.localizedDescription
        }
    }

    private func startAnotherHand() async {
        loading = true
        handId = nil
        card = nil
        backgroundUrl = nil
        foregroundUrl = nil
        introUrl = nil
        nextForegroundUrl = nil
        mesh = nil
        lastClaimMessage = nil
        handComplete = false
        do {
            let cards = try await api.cards().cards.filter { card in
                card.id != "original"
                    && card.mesh != "tracked-mesh.json"
                    && !card.foreground.isEmpty
                    && !card.background.isEmpty
                    && !card.mesh.isEmpty
            }
            let hand = dealMotionHand(cards, count: Self.handSize)
            preparedIndex = -1
            preparedMesh = nil
            preparingIndex = -1
            self.hand = hand
            handIndex = 0
            handComplete = hand.isEmpty
            handId = nil
            lastClaimMessage = nil
            if !hand.isEmpty {
                await presentCard(index: 0, hand: hand)
                loading = false
            } else {
                loading = false
                handComplete = true
            }
        } catch {
            loading = false
            handComplete = true
            self.error = error.localizedDescription
        }
    }

    private func loadMesh(_ card: CardInfo) async -> GarmentMesh? {
        if let task = prepareTask, !task.isCancelled,
           hand.indices.contains(preparingIndex),
           hand[preparingIndex].id == card.id
        {
            await task.value
        }
        if let ready = preparedMesh,
           hand.indices.contains(preparedIndex),
           hand[preparedIndex].id == card.id
        {
            return ready
        }
        return await fetchMesh(card)
    }

    private func fetchMesh(_ card: CardInfo) async -> GarmentMesh? {
        do {
            let raw = try await api.fetchText(api.mediaUrl("/mesh/\(card.mesh)"))
            return await Task.detached(priority: .userInitiated) {
                GarmentMesh.parse(raw)
            }.value
        } catch {
            return nil
        }
    }

    private func loadCardAndWallet() async throws {
        let wallet = try await api.wallet()
        let cards = try await api.cards().cards.filter { card in
            card.id != "original"
                && card.mesh != "tracked-mesh.json"
                && !card.foreground.isEmpty
                && !card.background.isEmpty
                && !card.mesh.isEmpty
        }
        let hand = dealMotionHand(cards, count: Self.handSize)
        let symbols = await SymbolLotties.load(api: api)
        self.wallet = wallet
        self.hand = hand
        handIndex = 0
        handComplete = hand.isEmpty
        symbolAnimations = symbols
        if !hand.isEmpty {
            await presentCard(index: 0, hand: hand)
        }
    }

    private func presentCard(index: Int, hand: [CardInfo]) async {
        guard let card = hand[safe: index] else { return }
        let mesh = await loadMesh(card)
        if mesh == nil || (mesh?.symbolCount ?? 0) < 6 {
            let rest = hand.enumerated().compactMap { $0.offset == index ? nil : $0.element }
            if rest.isEmpty {
                handComplete = true
                loading = false
            } else if index < rest.count {
                self.hand = rest
                await presentCard(index: index, hand: rest)
            } else {
                await startAnotherHand()
            }
            return
        }
        let nextCard = hand[safe: index + 1]
        handIndex = index
        roundEpoch += 1
        self.card = card
        backgroundUrl = api.backgroundUrl(card)
        foregroundUrl = api.foregroundUrl(card)
        if let trailer = card.trailer, !trailer.isEmpty {
            introUrl = api.mediaUrl(trailer)
        } else {
            introUrl = nil
        }
        nextForegroundUrl = nextCard.flatMap { api.foregroundUrl($0) }
        self.mesh = mesh
        chromaKey = false
        handId = nil
        lastClaimMessage = nil
        handComplete = false
    }

    private func dealMotionHand(_ cards: [CardInfo], count: Int) -> [CardInfo] {
        let byTheme = Dictionary(grouping: cards) { card in
            (card.themeId ?? card.label).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        var picked: [CardInfo] = []
        for theme in byTheme.keys.shuffled() {
            if picked.count >= count { break }
            guard let options = byTheme[theme], !options.isEmpty else { continue }
            picked.append(options.randomElement()!)
        }
        if picked.count < count {
            let used = Set(picked.map(\.id))
            picked += cards.filter { !used.contains($0.id) }.shuffled().prefix(count - picked.count)
        }
        return picked
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
