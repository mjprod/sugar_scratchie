package com.sugarscratchie.smoke.data

import android.content.Context
import android.content.SharedPreferences
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * Persists the player session cookie (`sugar_session`) across process restarts.
 * Auth is cookie-only — there is no Bearer token.
 */
class SessionCookieJar(
    context: Context,
) : CookieJar {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val memory = mutableMapOf<String, Cookie>()

    init {
        val name = prefs.getString(KEY_NAME, null)
        val value = prefs.getString(KEY_VALUE, null)
        val domain = prefs.getString(KEY_DOMAIN, null)
        val path = prefs.getString(KEY_PATH, "/") ?: "/"
        val secure = prefs.getBoolean(KEY_SECURE, false)
        val expiresAt = prefs.getLong(KEY_EXPIRES, Long.MAX_VALUE)
        if (!name.isNullOrBlank() && !value.isNullOrBlank() && !domain.isNullOrBlank()) {
            val hostOnly = prefs.getBoolean(KEY_HOST_ONLY, true)
            val builder =
                Cookie.Builder()
                    .name(name)
                    .value(value)
                    .path(path)
                    .expiresAt(expiresAt)
            if (hostOnly) {
                builder.hostOnlyDomain(domain.removePrefix("."))
            } else {
                builder.domain(domain.removePrefix("."))
            }
            if (secure) builder.secure()
            memory[name] = builder.build()
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (cookie in cookies) {
            if (cookie.name != SESSION_COOKIE) continue
            val expired = cookie.expiresAt < System.currentTimeMillis() || cookie.value.isEmpty()
            if (expired) {
                clear()
                continue
            }
            memory[cookie.name] = cookie
            prefs.edit()
                .putString(KEY_NAME, cookie.name)
                .putString(KEY_VALUE, cookie.value)
                .putString(KEY_DOMAIN, cookie.domain)
                .putString(KEY_PATH, cookie.path)
                .putBoolean(KEY_SECURE, cookie.secure)
                .putBoolean(KEY_HOST_ONLY, cookie.hostOnly)
                .putLong(KEY_EXPIRES, cookie.expiresAt)
                .apply()
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        return memory.values.filter { cookie ->
            cookie.expiresAt >= now && cookie.matches(url)
        }
    }

    fun clear() {
        memory.clear()
        prefs.edit().clear().apply()
    }

    companion object {
        const val SESSION_COOKIE = "sugar_session"
        private const val PREFS = "sugar_session_cookies"
        private const val KEY_NAME = "name"
        private const val KEY_VALUE = "value"
        private const val KEY_PATH = "path"
        private const val KEY_DOMAIN = "domain"
        private const val KEY_SECURE = "secure"
        private const val KEY_HOST_ONLY = "host_only"
        private const val KEY_EXPIRES = "expires"
    }
}
