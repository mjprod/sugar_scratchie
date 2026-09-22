package com.sugarscratchie.smoke

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sugarscratchie.smoke.data.ApiException
import com.airbnb.lottie.LottieComposition
import com.sugarscratchie.smoke.data.CardInfo
import com.sugarscratchie.smoke.data.DevEndpoints
import com.sugarscratchie.smoke.data.GarmentMesh
import com.sugarscratchie.smoke.data.ServerTarget
import com.sugarscratchie.smoke.data.SessionCookieJar
import com.sugarscratchie.smoke.data.SugarApi
import com.sugarscratchie.smoke.data.SymbolLotties
import com.sugarscratchie.smoke.data.UserPublic
import com.sugarscratchie.smoke.data.WalletResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

sealed interface SmokeScreen {
    data object Boot : SmokeScreen

    data object Login : SmokeScreen

    data class Session(val user: UserPublic) : SmokeScreen
}

data class SmokeUiState(
    val screen: SmokeScreen = SmokeScreen.Boot,
    val email: String = "",
    val password: String = "",
    val registerMode: Boolean = false,
    val serverTarget: ServerTarget = ServerTarget.Local,
    val apiBaseUrl: String = "",
    val loading: Boolean = false,
    val error: String? = null,
    val wallet: WalletResponse? = null,
    val card: CardInfo? = null,
    val hand: List<CardInfo> = emptyList(),
    val handIndex: Int = 0,
    /** Bumps on every presented card so SessionScreen can reset per-round UI (e.g. advanced). */
    val roundEpoch: Int = 0,
    val handComplete: Boolean = false,
    val backgroundUrl: String? = null,
    val foregroundUrl: String? = null,
    val introUrl: String? = null,
    val nextForegroundUrl: String? = null,
    val mesh: GarmentMesh? = null,
    val chromaKey: Boolean = true,
    val symbolCompositions: List<LottieComposition> = emptyList(),
    val handId: String? = null,
    val handsRemainingToday: Int? = null,
    val rewardHandDeclined: Boolean = false,
    val lastClaimMessage: String? = null,
)

class SmokeViewModel(
    application: Application,
) : AndroidViewModel(application) {
    private val cookieJar = SessionCookieJar(application)
    private val api = SugarApi(cookieJar)

    private val _state =
        MutableStateFlow(
            SmokeUiState(
                serverTarget = run {
                    DevEndpoints.init(application)
                    DevEndpoints.target
                },
                apiBaseUrl = DevEndpoints.apiBaseUrl,
            ),
        )
    val state: StateFlow<SmokeUiState> = _state.asStateFlow()

    fun bootstrap() {
        viewModelScope.launch {
            _state.update {
                it.copy(
                    loading = true,
                    error = null,
                    serverTarget = DevEndpoints.target,
                    apiBaseUrl = DevEndpoints.apiBaseUrl,
                )
            }
            try {
                val session = api.session()
                if (session.authenticated && session.user != null) {
                    enterSession(session.user)
                } else {
                    _state.update {
                        it.copy(screen = SmokeScreen.Login, loading = false)
                    }
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        screen = SmokeScreen.Login,
                        loading = false,
                        error = e.message ?: "Could not reach API",
                    )
                }
            }
        }
    }

    fun onEmailChange(value: String) {
        _state.update { it.copy(email = value, error = null) }
    }

    fun onPasswordChange(value: String) {
        _state.update { it.copy(password = value, error = null) }
    }

    fun onServerTargetChange(target: ServerTarget) {
        if (target == DevEndpoints.target) return
        cookieJar.clear()
        DevEndpoints.target = target
        _state.update {
            it.copy(
                serverTarget = target,
                apiBaseUrl = DevEndpoints.apiBaseUrl,
                error = null,
                handId = null,
                wallet = null,
                card = null,
            )
        }
    }

    fun toggleRegisterMode() {
        _state.update { it.copy(registerMode = !it.registerMode, error = null) }
    }

    fun submitAuth() {
        val email = _state.value.email.trim()
        val password = _state.value.password
        val register = _state.value.registerMode
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val res =
                    if (register) {
                        api.register(email, password)
                    } else {
                        api.login(email, password)
                    }
                val user = res.user ?: throw ApiException(500, "Auth succeeded but user missing")
                enterSession(user)
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, error = e.message ?: "Auth failed")
                }
            }
        }
    }

    fun refreshSessionData() {
        val user =
            (_state.value.screen as? SmokeScreen.Session)?.user ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                loadCardAndWallet()
                _state.update { it.copy(loading = false) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, error = e.message ?: "Refresh failed")
                }
            }
            // keep user
            _state.update { it.copy(screen = SmokeScreen.Session(user)) }
        }
    }

    fun startHand() {
        val current = _state.value
        if (current.rewardHandDeclined || current.handId != null || current.loading) return
        val card = current.card ?: return
        val cardId = card.id
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null, lastClaimMessage = null) }
            try {
                val hand = api.startScratchHand(cardId)
                _state.update { state ->
                    // Drop stale starts: startAnotherHand may have moved on while this was in flight.
                    // Do not clear loading — the hand transition owns that flag.
                    if (state.card?.id != cardId) {
                        state
                    } else {
                        state.copy(
                            loading = false,
                            handId = hand.handId,
                            handsRemainingToday = hand.handsRemainingToday,
                            lastClaimMessage = "Hand started (${hand.milestonesRemaining} milestones left)",
                        )
                    }
                }
            } catch (e: Exception) {
                val message = e.message.orEmpty()
                if (message.contains("scratch hand limit")) {
                    _state.update { state ->
                        if (state.card?.id != cardId) {
                            state
                        } else {
                            state.copy(loading = false, error = null, rewardHandDeclined = true)
                        }
                    }
                } else {
                    _state.update { state ->
                        if (state.card?.id != cardId) {
                            state
                        } else {
                            state.copy(loading = false, error = message.ifBlank { "Could not start hand" })
                        }
                    }
                }
            }
        }
    }

    fun claimMilestone() {
        val card = _state.value.card ?: return
        val handId = _state.value.handId ?: return
        val cardId = card.id
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val claim = api.claimScratchCoins(handId = handId, milestone = 1, cardId = cardId)
                val msg =
                    if (claim.alreadyClaimed) {
                        "Milestone 1 already claimed"
                    } else {
                        "Claimed +${claim.coins} coins"
                    }
                _state.update { state ->
                    // Auto-claim races with next-card / startAnotherHand. Always keep the wallet
                    // update; only clear loading when it is safe for SessionScreen's auto-start.
                    when {
                        // Hand rollover cleared the finished card; transition owns loading.
                        state.card == null -> state.copy(wallet = claim.wallet)
                        // Next card already on screen — unblock its startHand.
                        state.card?.id != cardId ->
                            state.copy(loading = false, wallet = claim.wallet)
                        // Same card but handId was cleared (gap before card swap) — do not
                        // reopen startHand for the finished round.
                        state.handId != handId -> state.copy(wallet = claim.wallet)
                        else ->
                            state.copy(
                                loading = false,
                                wallet = claim.wallet,
                                lastClaimMessage = msg,
                            )
                    }
                }
            } catch (e: Exception) {
                _state.update { state ->
                    when {
                        state.card == null -> state
                        state.card?.id != cardId -> state.copy(loading = false)
                        state.handId != handId -> state
                        else -> state.copy(loading = false, error = e.message ?: "Claim failed")
                    }
                }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                api.logout()
            } catch (_: Exception) {
                cookieJar.clear()
            }
            _state.value =
                SmokeUiState(
                    screen = SmokeScreen.Login,
                    email = _state.value.email,
                    serverTarget = DevEndpoints.target,
                    apiBaseUrl = DevEndpoints.apiBaseUrl,
                )
        }
    }

    private suspend fun enterSession(user: UserPublic) {
        _state.update {
            it.copy(
                screen = SmokeScreen.Session(user),
                loading = true,
                error = null,
                password = "",
            )
        }
        try {
            loadCardAndWallet()
            _state.update { it.copy(loading = false) }
        } catch (e: Exception) {
            _state.update {
                it.copy(loading = false, error = e.message ?: "Failed loading session data")
            }
        }
    }

    private var preparedIndex = -1
    private var preparedMesh: GarmentMesh? = null
    private var preparingIndex = -1
    private var prepareJob: Job? = null

    fun prepareNext() {
        val state = _state.value
        val next = state.handIndex + 1
        if (next >= state.hand.size || preparedIndex == next || preparingIndex == next) return
        val hand = state.hand
        preparingIndex = next
        prepareJob =
            viewModelScope.launch {
                val mesh = fetchMesh(hand[next])
                if (mesh != null && mesh.symbolCount >= 6) {
                    preparedIndex = next
                    preparedMesh = mesh
                }
                if (preparingIndex == next) preparingIndex = -1
            }
    }

    fun nextCard() {
        val state = _state.value
        if (state.handComplete) return
        val next = state.handIndex + 1
        if (next >= state.hand.size) {
            viewModelScope.launch { startAnotherHand() }
            return
        }
        viewModelScope.launch {
            presentCard(next, state.hand)
        }
    }

    private suspend fun startAnotherHand() {
        // Drop the finished card *with* handId so SessionScreen cannot auto-start a hand
        // against the previous card while the next mesh is still loading. Keep loading=true
        // until presentCard lands so the in-flight auto-claim cannot reopen that window.
        _state.update {
            it.copy(
                loading = true,
                handId = null,
                card = null,
                backgroundUrl = null,
                foregroundUrl = null,
                introUrl = null,
                nextForegroundUrl = null,
                mesh = null,
                lastClaimMessage = null,
                handComplete = false,
            )
        }
        val cards =
            api.cards().cards.filter { card ->
                card.id != "original" &&
                    card.mesh != "tracked-mesh.json" &&
                    card.foreground.isNotBlank() &&
                    card.background.isNotBlank() &&
                    card.mesh.isNotBlank()
            }
        val hand = dealMotionHand(cards, HAND_SIZE)
        preparedIndex = -1
        preparedMesh = null
        preparingIndex = -1
        _state.update {
            it.copy(
                hand = hand,
                handIndex = 0,
                handComplete = hand.isEmpty(),
                handId = null,
                lastClaimMessage = null,
            )
        }
        if (hand.isNotEmpty()) {
            presentCard(0, hand)
            _state.update { it.copy(loading = false) }
        } else {
            _state.update { it.copy(loading = false, handComplete = true) }
        }
    }

    private suspend fun loadMesh(card: CardInfo): GarmentMesh? {
        val job = prepareJob
        if (job != null && job.isActive && _state.value.hand.getOrNull(preparingIndex)?.id == card.id) {
            job.join()
        }
        val ready = preparedMesh
        if (ready != null && _state.value.hand.getOrNull(preparedIndex)?.id == card.id) return ready
        return fetchMesh(card)
    }

    private suspend fun fetchMesh(card: CardInfo): GarmentMesh? {
        return try {
            val raw = api.fetchText(api.mediaUrl("/mesh/${card.mesh}"))
            withContext(Dispatchers.Default) { GarmentMesh.parse(raw) }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun loadCardAndWallet() {
        val wallet = api.wallet()
        val cards =
            api.cards().cards.filter { card ->
                card.id != "original" &&
                    card.mesh != "tracked-mesh.json" &&
                    card.foreground.isNotBlank() &&
                    card.background.isNotBlank() &&
                    card.mesh.isNotBlank()
            }
        val hand = dealMotionHand(cards, HAND_SIZE)
        val symbols =
            try {
                SymbolLotties.load(api)
            } catch (_: Exception) {
                emptyList()
            }
        _state.update {
            it.copy(
                wallet = wallet,
                hand = hand,
                handIndex = 0,
                handComplete = hand.isEmpty(),
                symbolCompositions = symbols,
            )
        }
        if (hand.isNotEmpty()) presentCard(0, hand)
    }

    private suspend fun presentCard(index: Int, hand: List<CardInfo>) {
        val card = hand.getOrNull(index) ?: return
        val mesh = loadMesh(card)
        if (mesh == null || mesh.symbolCount < 6) {
            val rest = hand.filterIndexed { i, _ -> i != index }
            if (rest.isEmpty()) {
                _state.update { it.copy(handComplete = true, loading = false) }
            } else if (index < rest.size) {
                _state.update { it.copy(hand = rest) }
                // Keep the same index so the next remaining card slides into place.
                // Do not clamp to lastIndex — that re-presents the card just finished
                // when the skipped card was the last one (SessionScreen advanced stays true).
                presentCard(index, rest)
            } else {
                // Last card unplayable: roll the hand. startAnotherHand clears card+handId
                // together so SessionScreen cannot auto-start against the finished round.
                startAnotherHand()
            }
            return
        }
        val nextCard = hand.getOrNull(index + 1)
        _state.update {
            it.copy(
                handIndex = index,
                roundEpoch = it.roundEpoch + 1,
                card = card,
                backgroundUrl = api.backgroundUrl(card),
                foregroundUrl = api.foregroundUrl(card),
                introUrl = card.trailer?.takeIf { it.isNotBlank() }?.let { api.mediaUrl(it) },
                nextForegroundUrl = nextCard?.let { api.foregroundUrl(it) },
                mesh = mesh,
                chromaKey = false,
                handId = null,
                lastClaimMessage = null,
                handComplete = false,
            )
        }
    }

    private fun dealMotionHand(cards: List<CardInfo>, count: Int): List<CardInfo> {
        val byTheme = cards.groupBy { card -> (card.themeId ?: card.label).trim().lowercase() }
        val picked = mutableListOf<CardInfo>()
        for (theme in byTheme.keys.shuffled()) {
            if (picked.size >= count) break
            val options = byTheme[theme].orEmpty()
            if (options.isEmpty()) continue
            picked += options.random()
        }
        if (picked.size < count) {
            val used = picked.map { it.id }.toSet()
            picked += cards.filter { it.id !in used }.shuffled().take(count - picked.size)
        }
        return picked
    }

    companion object {
        private const val HAND_SIZE = 5
    }
}
