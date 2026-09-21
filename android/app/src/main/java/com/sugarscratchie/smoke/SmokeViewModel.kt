package com.sugarscratchie.smoke

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.sugarscratchie.smoke.data.ApiException
import com.sugarscratchie.smoke.data.CardInfo
import com.sugarscratchie.smoke.data.SessionCookieJar
import com.sugarscratchie.smoke.data.SugarApi
import com.sugarscratchie.smoke.data.UserPublic
import com.sugarscratchie.smoke.data.WalletResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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
    val loading: Boolean = false,
    val error: String? = null,
    val wallet: WalletResponse? = null,
    val card: CardInfo? = null,
    val backgroundUrl: String? = null,
    val foregroundUrl: String? = null,
    val handId: String? = null,
    val handsRemainingToday: Int? = null,
    val lastClaimMessage: String? = null,
)

class SmokeViewModel(
    application: Application,
) : AndroidViewModel(application) {
    private val cookieJar = SessionCookieJar(application)
    private val api = SugarApi(cookieJar)

    private val _state = MutableStateFlow(SmokeUiState())
    val state: StateFlow<SmokeUiState> = _state.asStateFlow()

    fun bootstrap() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
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
        val card = _state.value.card ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null, lastClaimMessage = null) }
            try {
                val hand = api.startScratchHand(card.id)
                _state.update {
                    it.copy(
                        loading = false,
                        handId = hand.handId,
                        handsRemainingToday = hand.handsRemainingToday,
                        lastClaimMessage = "Hand started (${hand.milestonesRemaining} milestones left)",
                    )
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, error = e.message ?: "Could not start hand")
                }
            }
        }
    }

    fun claimMilestone() {
        val card = _state.value.card ?: return
        val handId = _state.value.handId ?: return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val claim = api.claimScratchCoins(handId = handId, milestone = 1, cardId = card.id)
                val msg =
                    if (claim.alreadyClaimed) {
                        "Milestone 1 already claimed"
                    } else {
                        "Claimed +${claim.coins} coins"
                    }
                _state.update {
                    it.copy(
                        loading = false,
                        wallet = claim.wallet,
                        lastClaimMessage = msg,
                    )
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, error = e.message ?: "Claim failed")
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

    private suspend fun loadCardAndWallet() {
        val wallet = api.wallet()
        val cards = api.cards().cards
        val card = api.pickPlayableCard(cards)
        _state.update {
            it.copy(
                wallet = wallet,
                card = card,
                backgroundUrl = card?.let { c -> api.backgroundUrl(c) },
                foregroundUrl = card?.let { c -> api.foregroundUrl(c) },
            )
        }
    }
}
