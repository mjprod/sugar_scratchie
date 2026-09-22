package com.sugarscratchie.smoke.data

import android.content.Context
import android.os.Build
import com.sugarscratchie.smoke.BuildConfig

enum class ServerTarget(
    val label: String,
) {
    Local("Local"),
    Remote("Remote (.env)"),
}

/**
 * Emulator → `10.0.2.2`. Phone on Wi‑Fi → [BuildConfig.LAN_HOST].
 * Remote → [BuildConfig.REMOTE_API_BASE_URL] / [BuildConfig.REMOTE_MEDIA_BASE_URL]
 * (from `frontend-new/.env` `VITE_*_PROXY` at build time).
 */
object DevEndpoints {
    private const val PREFS = "sugar_dev_endpoints"
    private const val KEY_TARGET = "server_target"

    @Volatile
    private var prefs: android.content.SharedPreferences? = null

    @Volatile
    private var current: ServerTarget = ServerTarget.Local

    fun init(context: Context) {
        if (prefs != null) return
        val store =
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = store
        current =
            runCatching {
                ServerTarget.valueOf(store.getString(KEY_TARGET, ServerTarget.Local.name)!!)
            }.getOrDefault(ServerTarget.Local)
    }

    var target: ServerTarget
        get() = current
        set(value) {
            current = value
            prefs?.edit()?.putString(KEY_TARGET, value.name)?.apply()
        }

    private val localHost: String = if (isEmulator()) "10.0.2.2" else BuildConfig.LAN_HOST

    val apiBaseUrl: String
        get() =
            when (current) {
                ServerTarget.Local -> "http://$localHost:8090"
                ServerTarget.Remote -> BuildConfig.REMOTE_API_BASE_URL.trimEnd('/')
            }

    val mediaBaseUrl: String
        get() =
            when (current) {
                ServerTarget.Local -> "https://$localHost:5080"
                ServerTarget.Remote -> BuildConfig.REMOTE_MEDIA_BASE_URL.trimEnd('/')
            }

    private fun isEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT
        val model = Build.MODEL
        val product = Build.PRODUCT
        return fingerprint.startsWith("generic") ||
            fingerprint.startsWith("unknown") ||
            model.contains("google_sdk") ||
            model.contains("Emulator") ||
            model.contains("Android SDK built for") ||
            model.startsWith("sdk_gphone") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            product.contains("sdk_gphone") ||
            product.contains("emulator") ||
            product.contains("simulator")
    }
}
