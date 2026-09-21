package com.sugarscratchie.smoke.data

import android.annotation.SuppressLint
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Vite dev media is served with @vitejs/plugin-basic-ssl (a cert Android will not trust,
 * often for localhost rather than 10.0.2.2). Debug-only client for that local clip.
 */
@SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
fun devMediaClient(): OkHttpClient {
    val trustAll =
        object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit

            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trustAll), SecureRandom())
    return OkHttpClient.Builder()
        .sslSocketFactory(context.socketFactory, trustAll)
        .hostnameVerifier { _, _ -> true }
        .build()
}
