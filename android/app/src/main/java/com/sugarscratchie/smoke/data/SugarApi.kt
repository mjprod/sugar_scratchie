package com.sugarscratchie.smoke.data

import com.sugarscratchie.smoke.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class SugarApi(
    private val cookieJar: SessionCookieJar,
    private val apiBaseUrl: String = BuildConfig.API_BASE_URL.trimEnd('/'),
    private val mediaBaseUrl: String = BuildConfig.MEDIA_BASE_URL.trimEnd('/'),
) {
    private val json =
        Json {
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
        }

    private val client =
        OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun mediaUrl(path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        var cleaned = path.trim()
        if (cleaned.startsWith("public/")) {
            cleaned = cleaned.removePrefix("public/")
        }
        if (!cleaned.startsWith("/")) {
            cleaned = "/$cleaned"
        }
        val encoded =
            cleaned.split("/").joinToString("/") { segment ->
                if (segment.isEmpty()) "" else URLEncoder.encode(segment, Charsets.UTF_8.name()).replace("+", "%20")
            }
        return "$mediaBaseUrl$encoded"
    }

    fun pickPlayableCard(cards: List<CardInfo>): CardInfo? =
        cards.firstOrNull {
            it.foreground.isNotBlank() && it.background.isNotBlank()
        } ?: cards.firstOrNull { it.foreground.isNotBlank() || it.background.isNotBlank() }

    fun backgroundUrl(card: CardInfo): String? {
        if (card.background.isBlank()) return null
        return mediaUrl(card.background)
    }

    fun foregroundUrl(card: CardInfo): String? {
        if (card.foreground.isBlank()) return null
        return mediaUrl(card.foreground)
    }

    suspend fun login(email: String, password: String): AuthResponse =
        postJson("/api/auth/login", CredentialsBody(email = email, password = password))

    suspend fun register(email: String, password: String): AuthResponse =
        postJson("/api/auth/register", CredentialsBody(email = email, password = password))

    suspend fun logout() {
        try {
            withContext(Dispatchers.IO) {
                val request =
                    Request.Builder()
                        .url("$apiBaseUrl/api/auth/logout")
                        .post("{}".toRequestBody(jsonMedia))
                        .header("Content-Type", "application/json")
                        .build()
                client.newCall(request).execute().use { /* ignore body */ }
            }
        } finally {
            cookieJar.clear()
        }
    }

    suspend fun session(): SessionResponse = get("/api/auth/session")

    suspend fun wallet(): WalletResponse = get("/api/me/wallet")

    suspend fun cards(): CardsResponse = get("/api/cards")

    suspend fun fetchBytes(url: String): ByteArray =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).get().build()
            devMediaClient().newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ApiException(response.code, "HTTP ${response.code}")
                }
                response.body?.bytes() ?: ByteArray(0)
            }
        }

    suspend fun fetchText(url: String): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).get().build()
            devMediaClient().newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw ApiException(response.code, "HTTP ${response.code}")
                }
                raw
            }
        }

    suspend fun startScratchHand(cardId: String): ScratchHandResponse =
        postJson("/api/rewards/scratch/hands", ScratchHandRequest(cardId = cardId))

    suspend fun claimScratchCoins(handId: String, milestone: Int, cardId: String): ScratchCoinsResponse =
        postJson(
            "/api/rewards/scratch/coins",
            ScratchCoinsRequest(handId = handId, milestone = milestone, cardId = cardId),
        )

    private suspend inline fun <reified T> get(path: String): T =
        withContext(Dispatchers.IO) {
            val request =
                Request.Builder()
                    .url("$apiBaseUrl$path")
                    .get()
                    .build()
            execute(request)
        }

    private suspend inline fun <reified Req, reified Res> postJson(path: String, body: Req): Res =
        withContext(Dispatchers.IO) {
            val encoded = json.encodeToString(body)
            val request =
                Request.Builder()
                    .url("$apiBaseUrl$path")
                    .post(encoded.toRequestBody(jsonMedia))
                    .header("Content-Type", "application/json")
                    .build()
            execute(request)
        }

    private inline fun <reified T> execute(request: Request): T {
        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ApiException(response.code, parseDetail(raw) ?: "HTTP ${response.code}")
            }
            return json.decodeFromString(raw)
        }
    }

    private fun parseDetail(raw: String): String? {
        if (raw.isBlank()) return null
        return try {
            val err = json.decodeFromString<ApiErrorBody>(raw)
            val detail = err.detail ?: return raw
            when (detail) {
                is JsonPrimitive -> detail.contentOrNull ?: detail.toString()
                else -> {
                    try {
                        detail.jsonArray.joinToString("; ") { el ->
                            el.jsonPrimitive.contentOrNull ?: el.toString()
                        }
                    } catch (_: Exception) {
                        detail.toString()
                    }
                }
            }
        } catch (_: Exception) {
            raw.take(300)
        }
    }
}

@Serializable
private data class CredentialsBody(
    val email: String,
    val password: String,
)
