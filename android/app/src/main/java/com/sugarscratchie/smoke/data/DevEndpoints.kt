package com.sugarscratchie.smoke.data

import android.os.Build
import com.sugarscratchie.smoke.BuildConfig

/**
 * Emulator reaches the Mac through 10.0.2.2. A phone on the same Wi-Fi uses
 * this machine's LAN address, baked in at build time ([BuildConfig.LAN_HOST]).
 */
object DevEndpoints {
    val host: String = if (isEmulator()) "10.0.2.2" else BuildConfig.LAN_HOST

    val apiBaseUrl: String = "http://$host:8090"
    val mediaBaseUrl: String = "https://$host:5080"

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
