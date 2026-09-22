package com.sugarscratchie.smoke.ui

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Short scratch ticks. Faster strokes buzz a little harder. Already-cleared
 * pixels must not call [pulse].
 */
class ScratchHaptics(context: Context) {
    private val vibrator: Vibrator =
        if (Build.VERSION.SDK_INT >= 31) {
            val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            manager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

    private var lastAtMs = 0L

    fun pulse(speedPxPerSec: Float, pressure: Float, onFreshCoat: Boolean) {
        if (!onFreshCoat || !vibrator.hasVibrator()) return
        val speed = (speedPxPerSec / 1600f).coerceIn(0f, 1f)
        val press = pressure.coerceIn(0.35f, 1.15f)
        val scale = ((0.16f + speed * 0.42f) * press).coerceIn(0.14f, 0.62f)
        val gapMs = (36L - (speed * 18f).toLong()).coerceAtLeast(16L)
        val now = SystemClock.uptimeMillis()
        if (now - lastAtMs < gapMs) return
        lastAtMs = now
        if (
            Build.VERSION.SDK_INT >= 30 &&
            vibrator.areAllPrimitivesSupported(VibrationEffect.Composition.PRIMITIVE_TICK)
        ) {
            vibrator.vibrate(
                VibrationEffect.startComposition()
                    .addPrimitive(VibrationEffect.Composition.PRIMITIVE_TICK, scale)
                    .compose(),
            )
            return
        }
        val amplitude =
            if (vibrator.hasAmplitudeControl()) {
                (scale * 255f).toInt().coerceIn(1, 180)
            } else {
                VibrationEffect.DEFAULT_AMPLITUDE
            }
        val duration = (8f + speed * 8f).toLong()
        vibrator.vibrate(VibrationEffect.createOneShot(duration, amplitude))
    }

    fun stop() {
        vibrator.cancel()
    }
}
