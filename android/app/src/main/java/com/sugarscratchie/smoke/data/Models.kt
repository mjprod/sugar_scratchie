package com.sugarscratchie.smoke.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class UserPublic(
    val id: String,
    val email: String,
    val provider: String? = null,
    val emailVerified: Boolean = false,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val genderInterest: String? = null,
    val referralCode: String? = null,
    val welcomeClaimed: Boolean = false,
    val homeTutorialDone: Boolean = false,
    val recommendationStatus: String? = null,
)

@Serializable
data class AuthResponse(
    val ok: Boolean = true,
    val user: UserPublic? = null,
)

@Serializable
data class SessionResponse(
    val authenticated: Boolean,
    val user: UserPublic? = null,
)

@Serializable
data class WalletResponse(
    val diamonds: Int = 0,
    val coins: Int = 0,
)

@Serializable
data class CardsResponse(
    val cards: List<CardInfo> = emptyList(),
)

@Serializable
data class CardInfo(
    val id: String,
    val label: String,
    val background: String = "",
    val foreground: String = "",
    val mesh: String = "",
    @SerialName("has_mesh") val hasMesh: Boolean = false,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("theme_id") val themeId: String? = null,
)

@Serializable
data class ScratchHandRequest(
    val cardId: String? = null,
)

@Serializable
data class ScratchHandResponse(
    val handId: String,
    val milestonesRemaining: Int = 0,
    val handsRemainingToday: Int = 0,
)

@Serializable
data class ScratchCoinsRequest(
    val handId: String,
    val milestone: Int,
    val cardId: String? = null,
)

@Serializable
data class ScratchCoinsResponse(
    val ok: Boolean = true,
    val coins: Int = 0,
    val alreadyClaimed: Boolean = false,
    val wallet: WalletResponse = WalletResponse(),
)

@Serializable
data class ApiErrorBody(
    val detail: JsonElement? = null,
)

class ApiException(
    val statusCode: Int,
    message: String,
) : Exception(message)
