package com.sugarscratchie.smoke.ui

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin

/**
 * The same synthesized game tones as frontend-new: a match ding when a body
 * icon claims a top-bar slot, and the win / settle outcome chimes.
 */
class GameSounds {
    private val handler = Handler(Looper.getMainLooper())
    private val matchTracks = pool(renderMatchFind())
    private val winTrack = track(renderWin())
    private var matchCursor = 0
    private var pendingMatches = 0
    private var lastMatchScheduledAt = 0L

    fun playMatchFind() {
        val now = SystemClock.uptimeMillis()
        if (now - lastMatchScheduledAt > 200L) pendingMatches = 0
        val delay = pendingMatches * 70L
        pendingMatches += 1
        lastMatchScheduledAt = now + delay
        handler.postDelayed(
            {
                pendingMatches = (pendingMatches - 1).coerceAtLeast(0)
                replay(matchTracks.getOrNull(matchCursor % matchTracks.size.coerceAtLeast(1)))
                if (matchTracks.isNotEmpty()) matchCursor += 1
            },
            delay,
        )
    }

    fun playWin() {
        replay(winTrack)
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        (matchTracks + listOfNotNull(winTrack)).forEach { it.release() }
    }

    private fun replay(audio: AudioTrack?) {
        if (audio == null) return
        try {
            if (audio.playState != AudioTrack.PLAYSTATE_STOPPED) audio.stop()
            audio.reloadStaticData()
            audio.play()
        } catch (_: Exception) {
        }
    }

    private companion object {
        const val SAMPLE_RATE = 44100

        fun pool(pcm: ShortArray, count: Int = 4): List<AudioTrack> =
            List(count) { track(pcm) }.filterNotNull()

        fun track(pcm: ShortArray): AudioTrack? {
            return try {
                val audio =
                    AudioTrack.Builder()
                        .setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_GAME)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                .build(),
                        )
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(SAMPLE_RATE)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                                .build(),
                        )
                        .setBufferSizeInBytes(pcm.size * 2)
                        .setTransferMode(AudioTrack.MODE_STATIC)
                        .build()
                audio.write(pcm, 0, pcm.size)
                audio
            } catch (_: Exception) {
                null
            }
        }

        fun renderMatchFind(): ShortArray {
            val mix = Mix(0.4)
            mix.tone(0.0, 659.25, 0.1, 0.2, Wave.Triangle)
            mix.tone(0.055, 880.0, 0.12, 0.18, Wave.Sine)
            mix.tone(0.11, 1174.66, 0.14, 0.12, Wave.Sine)
            return mix.pcm()
        }

        fun renderWin(): ShortArray {
            val mix = Mix(2.6)
            val sparkle =
                doubleArrayOf(
                    523.25, 587.33, 659.25, 698.46, 783.99, 880.0,
                    987.77, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0,
                )
            val sparkleStep = 0.048
            sparkle.forEachIndexed { index, freq ->
                val t = index * sparkleStep
                mix.tone(t, freq, 0.09, 0.17, Wave.Sine)
                if (index % 2 == 0) mix.tone(t + 0.012, freq * 2, 0.055, 0.09, Wave.Triangle)
            }
            val fanfareStart = sparkle.size * sparkleStep + 0.06
            val fanfare = doubleArrayOf(523.25, 659.25, 783.99, 987.77, 1174.66)
            fanfare.forEachIndexed { index, freq ->
                val t = fanfareStart + index * 0.1
                mix.tone(t, freq, 0.15, 0.3, Wave.Square)
                mix.tone(t, freq * 0.5, 0.15, 0.14, Wave.Saw)
                mix.tone(t + 0.04, freq * 1.5, 0.08, 0.08, Wave.Triangle)
            }
            val chordAt = fanfareStart + fanfare.size * 0.1 + 0.1
            val chord = doubleArrayOf(261.63, 392.0, 523.25, 659.25, 783.99, 1046.5, 1318.51)
            chord.forEachIndexed { index, freq ->
                val wave = if (index < 2) Wave.Saw else Wave.Triangle
                val volume = if (index < 2) 0.11 else 0.13
                mix.tone(chordAt, freq, 0.78, volume, wave)
            }
            val glitterStart = chordAt + 0.12
            val glitter = doubleArrayOf(2093.0, 2349.0, 2637.0, 2793.0, 3136.0, 3520.0)
            glitter.forEachIndexed { index, freq ->
                mix.tone(glitterStart + index * 0.045, freq, 0.11, 0.11, Wave.Sine)
            }
            val shimmerStart = glitterStart + glitter.size * 0.045 + 0.08
            for (i in 0 until 6) {
                mix.tone(shimmerStart + i * 0.06, 1760.0 + i * 110.0, 0.07, 0.09, Wave.Sine)
            }
            return mix.pcm()
        }
    }
}

private enum class Wave { Sine, Triangle, Square, Saw }

private class Mix(seconds: Double) {
    private val samples = FloatArray((seconds * 44100).toInt())

    fun tone(startAt: Double, frequency: Double, durationS: Double, volume: Double, wave: Wave) {
        val start = (startAt * 44100).toInt().coerceAtLeast(0)
        val end = ((startAt + durationS + 0.02) * 44100).toInt().coerceAtMost(samples.size)
        var i = start
        while (i < end) {
            val time = i / 44100.0
            val local = time - startAt
            val env = envelope(local, durationS, volume)
            val phase = time * frequency
            samples[i] = (samples[i] + waveSample(phase, wave) * env).toFloat()
            i += 1
        }
    }

    fun pcm(): ShortArray {
        val out = ShortArray(samples.size)
        for (i in samples.indices) {
            val clipped = samples[i].coerceIn(-1f, 1f)
            out[i] = (clipped * 32767f).toInt().toShort()
        }
        return out
    }
}

private fun envelope(local: Double, durationS: Double, volume: Double): Double {
    if (local < 0.0 || volume <= 0.0) return 0.0
    if (local < 0.015) return 0.0001 * (volume / 0.0001).pow(local / 0.015)
    if (local >= durationS) return 0.0001
    val span = (durationS - 0.015).coerceAtLeast(0.0001)
    return volume * (0.0001 / volume).pow((local - 0.015) / span)
}

private fun waveSample(phase: Double, wave: Wave): Double {
    val wrapped = phase - floor(phase)
    return when (wave) {
        Wave.Sine -> sin(2.0 * PI * wrapped)
        Wave.Square -> if (wrapped < 0.5) 1.0 else -1.0
        Wave.Saw -> 2.0 * (wrapped - floor(wrapped + 0.5))
        Wave.Triangle -> {
            val saw = 2.0 * (wrapped - floor(wrapped + 0.5))
            2.0 * abs(saw) - 1.0
        }
    }
}
