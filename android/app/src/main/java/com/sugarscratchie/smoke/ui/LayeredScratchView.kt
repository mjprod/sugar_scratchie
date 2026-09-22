package com.sugarscratchie.smoke.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.Surface
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.drawable.Drawable
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieDrawable
import com.sugarscratchie.smoke.data.GarmentMesh
import com.sugarscratchie.smoke.data.devMediaClient
import kotlin.math.hypot
import kotlin.math.pow

/**
 * Product-shaped smoke session:
 * - looping background clip (reveal)
 * - looping foreground clip with green keyed out (garment)
 * - finger scratches punch holes in the garment so the background shows through
 *
 * Not the UV mesh tracker — native dual-layer compositing for the smoke client.
 */
class LayeredScratchView
    @JvmOverloads
    constructor(
        context: Context,
        attrs: AttributeSet? = null,
    ) : FrameLayout(context, attrs) {
        var onScratched: ((Float) -> Unit)? = null
        var onIconFound: ((Int) -> Unit)? = null
        var onSymbolsRevealed: ((Int) -> Unit)? = null
        var onError: ((String) -> Unit)? = null
        var mesh: GarmentMesh? = null
        var chromaKey: Boolean = false
            set(value) {
                field = value
                videoView?.chromaKey = value
            }
        var scratchEnabled: Boolean = true
        private var sourceKey = ""
        private var symbolDrawables: List<LottieDrawable> = emptyList()
        private val missFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) })

        private val mediaFactory =
            DefaultMediaSourceFactory(OkHttpDataSource.Factory(devMediaClient()))

        private var backgroundSurface: Surface? = null
        private var foregroundSurface: Surface? = null
        private var videoView: DualVideoGlView? = null
        private val video =
            DualVideoGlView(context).also { surface ->
                videoView = surface
                surface.chromaKey = chromaKey
                surface.onSurfaces = { background, foreground ->
                    backgroundSurface = background
                    foregroundSurface = foreground
                    backgroundPlayer?.setVideoSurface(background)
                    foregroundPlayer?.setVideoSurface(foreground)
                }
                addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            }

        private val iconOverlay =
            object : View(context) {
                override fun onDraw(canvas: Canvas) {
                    val count = iconCount
                    for (i in 0 until count) {
                        // Unfound marks stay hidden. Matches leave for the top bar.
                        if (!iconMiss[i]) continue
                        val x = iconX[i]
                        val y = iconY[i]
                        if (x.isNaN() || y.isNaN()) continue
                        drawBodyLottie(canvas, i, x, y)
                    }
                    drawCursorFx(canvas)
                }
            }.also {
                it.isClickable = false
                it.setWillNotDraw(false)
                it.elevation = 12f
                addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            }

        private val iconX = FloatArray(MAX_BODY) { Float.NaN }
        private val iconY = FloatArray(MAX_BODY) { Float.NaN }
        private val iconRevealed = BooleanArray(MAX_BODY)
        private val iconMiss = BooleanArray(MAX_BODY)
        private val topClaimed = BooleanArray(TOP_SLOTS)
        private var iconCount = 0
        private var backgroundPlayer: ExoPlayer? = null
        private var foregroundPlayer: ExoPlayer? = null

        private var scratchMask: Bitmap? = null
        private var scratchCanvas: Canvas? = null
        private var playbackStarted = false
        private var lastBackgroundPosition = -1L
        private var seekHoldUntilMs = 0L

        private val erase =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
                strokeWidth = 140f
                xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
            }
        private val eraseDot =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
            }
        private var lastX = 0f
        private var lastY = 0f
        private var lastTouchMs = 0L
        private val haptics = ScratchHaptics(context)
        private var moveTicks = 0
        private var scratching = false
        private var lastDustX = Float.NaN
        private var lastDustY = Float.NaN
        private val dust = ArrayList<Dust>(64)
        private val dustFill =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0xFFFFD56A.toInt()
                style = Paint.Style.FILL
            }
        private val dustGem =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0xFFFFF6D0.toInt()
                style = Paint.Style.FILL
            }

        private val mainHandler = Handler(Looper.getMainLooper())
        private val compositeTick =
            object : Runnable {
                override fun run() {
                    stepCursorFx()
                    syncPlayers()
                    placeIcons()
                    if (dust.isNotEmpty() || mesh != null) iconOverlay.invalidate()
                    mainHandler.postDelayed(this, 33L)
                }
            }

        fun setSymbolCompositions(compositions: List<LottieComposition>) {
            if (compositions.isEmpty()) return
            if (symbolDrawables.size == compositions.size) return
            symbolDrawables.forEach { it.cancelAnimation() }
            symbolDrawables =
                compositions.map { composition ->
                    LottieDrawable().apply {
                        setComposition(composition)
                        repeatCount = LottieDrawable.INFINITE
                        callback =
                            object : Drawable.Callback {
                                override fun invalidateDrawable(who: Drawable) {
                                    iconOverlay.invalidate()
                                }

                                override fun scheduleDrawable(who: Drawable, what: Runnable, time: Long) {
                                    mainHandler.postAtTime(what, time)
                                }

                                override fun unscheduleDrawable(who: Drawable, what: Runnable) {
                                    mainHandler.removeCallbacks(what)
                                }
                            }
                        playAnimation()
                    }
                }
        }

        fun setSources(backgroundUrl: String, foregroundUrl: String) {
            val key = "$backgroundUrl\n$foregroundUrl"
            if (key == sourceKey && backgroundPlayer != null) return
            sourceKey = key
            playbackStarted = false
            lastBackgroundPosition = -1L
            seekHoldUntilMs = 0L
            resetRound()
            releasePlayers()
            backgroundPlayer = buildPlayer(backgroundUrl, backgroundSurface)
            foregroundPlayer = buildPlayer(foregroundUrl, foregroundSurface)
            mainHandler.removeCallbacks(compositeTick)
            mainHandler.post(compositeTick)
        }

        fun resetRound() {
            scratchCanvas?.drawColor(Color.WHITE)
            iconRevealed.fill(false)
            iconMiss.fill(false)
            topClaimed.fill(false)
            dust.clear()
            iconOverlay.invalidate()
            video.invalidateMask()
        }

        fun release() {
            mainHandler.removeCallbacks(compositeTick)
            releasePlayers()
            symbolDrawables.forEach { it.cancelAnimation() }
            symbolDrawables = emptyList()
            video.attachMask(null)
            scratchMask?.recycle()
            scratchMask = null
            scratchCanvas = null
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            if (w <= 0 || h <= 0) return
            val maskW = (w / 2).coerceAtLeast(1)
            val maskH = (h / 2).coerceAtLeast(1)
            video.lockMask {
                scratchMask?.recycle()
                val mask = Bitmap.createBitmap(maskW, maskH, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(mask)
                canvas.drawColor(Color.WHITE)
                scratchMask = mask
                scratchCanvas = canvas
            }
            erase.strokeWidth = 140f * maskW / w
            video.attachMask(scratchMask)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (!scratchEnabled) return false
            val canvas = scratchCanvas ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    scratching = true
                    val onCoat = freshCoat(event.x, event.y)
                    haptics.pulse(0f, event.pressure, onCoat)
                    spawnCursorFx(event.x, event.y, onCoat)
                    lastX = event.x
                    lastY = event.y
                    lastTouchMs = event.eventTime
                    val (mx, my) = toMask(event.x, event.y)
                    video.lockMask { canvas.drawCircle(mx, my, maskRadius(), eraseDot) }
                    markIconsNear(event.x, event.y)
                    video.invalidateMask()
                    iconOverlay.invalidate()
                }
                MotionEvent.ACTION_MOVE -> {
                    val dt = (event.eventTime - lastTouchMs).coerceAtLeast(1L)
                    val speed = hypot(event.x - lastX, event.y - lastY) / dt * 1000f
                    val onCoat = freshCoat(event.x, event.y)
                    haptics.pulse(speed, event.pressure, onCoat)
                    spawnCursorFx(event.x, event.y, onCoat)
                    val (mx, my) = toMask(event.x, event.y)
                    val (lx, ly) = toMask(lastX, lastY)
                    video.lockMask { canvas.drawLine(lx, ly, mx, my, erase) }
                    lastX = event.x
                    lastY = event.y
                    lastTouchMs = event.eventTime
                    moveTicks += 1
                    if (moveTicks % 4 == 0) {
                        onScratched?.invoke(scratchedFraction())
                    }
                    markIconsNear(event.x, event.y)
                    video.invalidateMask()
                    iconOverlay.invalidate()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    scratching = false
                    haptics.stop()
                    lastDustX = Float.NaN
                    lastDustY = Float.NaN
                }
            }
            return true
        }

        override fun onDetachedFromWindow() {
            haptics.stop()
            release()
            super.onDetachedFromWindow()
        }

        private fun toMask(x: Float, y: Float): Pair<Float, Float> {
            val mask = scratchMask ?: return x to y
            if (width < 1 || height < 1) return x to y
            return (x * mask.width / width) to (y * mask.height / height)
        }

        private fun maskRadius(): Float {
            val mask = scratchMask ?: return 70f
            if (width < 1) return 70f
            return 70f * mask.width / width
        }

        /** Still-covered garment only. Cleared holes and keyed-out pixels stay silent. */
        private fun freshCoat(x: Float, y: Float): Boolean {
            if (!fingerOnFabric(x, y)) return false
            val mask = scratchMask ?: return false
            val (mx, my) = toMask(x, y)
            val ix = mx.toInt().coerceIn(0, mask.width - 1)
            val iy = my.toInt().coerceIn(0, mask.height - 1)
            return (mask.getPixel(ix, iy) ushr 24) >= 16
        }

        private fun buildPlayer(url: String, surface: Surface?): ExoPlayer {
            val player =
                ExoPlayer.Builder(context)
                    .setMediaSourceFactory(mediaFactory)
                    .build()
                    .apply {
                        repeatMode = Player.REPEAT_MODE_ONE
                        playWhenReady = false
                        volume = 0f
                        setMediaItem(MediaItem.fromUri(url))
                        prepare()
                        surface?.let { setVideoSurface(it) }
                        addListener(
                            object : Player.Listener {
                                override fun onPlaybackStateChanged(playbackState: Int) {
                                    maybeStartTogether()
                                }
                            },
                        )
                    }
            return player
        }

        private fun releasePlayers() {
            backgroundPlayer?.clearVideoSurface()
            foregroundPlayer?.clearVideoSurface()
            backgroundPlayer?.release()
            foregroundPlayer?.release()
            backgroundPlayer = null
            foregroundPlayer = null
        }

        private fun placeIcons() {
            val field = mesh ?: return
            val player = backgroundPlayer ?: return
            if (width < 2 || height < 2) return
            val count = minOf(MAX_BODY, field.symbolCount)
            iconCount = count
            val clock = foregroundPlayer ?: player
            val verts = field.sampleVerts(clock.currentPosition / 1000f)
            // ExoPlayer SCALE_TO_FIT letterboxes the 390×672 frame inside the view.
            val scale = minOf(width / field.canvasWidth, height / field.canvasHeight)
            val originX = (width - field.canvasWidth * scale) / 2f
            val originY = (height - field.canvasHeight * scale) / 2f
            for (i in 0 until count) {
                val u = field.symbols[i * 2]
                val v = field.symbols[i * 2 + 1]
                val (wx, wy) = field.uvToWorld(verts, u, v)
                iconX[i] = originX + wx * scale
                iconY[i] = originY + wy * scale
            }
        }

        private fun drawBodyLottie(canvas: Canvas, index: Int, x: Float, y: Float) {
            val drawables = symbolDrawables
            if (drawables.isEmpty()) return
            val drawable = drawables[index.coerceIn(0, drawables.lastIndex)]
            val fit = minOf(width / 390f, height / 672f)
            val size = (72f * fit).toInt().coerceAtLeast(1)
            val left = (x - size / 2f).toInt()
            val top = (y - size / 2f).toInt()
            drawable.colorFilter = missFilter
            drawable.alpha = 180
            drawable.setBounds(left, top, left + size, top + size)
            drawable.draw(canvas)
        }

        private fun spawnCursorFx(x: Float, y: Float, onCoat: Boolean) {
            if (!scratching || !onCoat) return
            if (!lastDustX.isNaN()) {
                val dx = x - lastDustX
                val dy = y - lastDustY
                if (dx * dx + dy * dy <= 1f) return
            }
            lastDustX = x
            lastDustY = y
            val room = MAX_DUST - dust.size
            val count = minOf(DUST_PER_MOVE, room)
            for (i in 0 until count) {
                val speed = (Math.random() * 1f + 0.5f).toFloat()
                val sign = if (Math.random() < 0.5) -1f else 1f
                dust.add(
                    Dust(
                        x,
                        y,
                        sign * speed,
                        -(Math.random() * 1.5f).toFloat(),
                        DUST_LIFE,
                    ),
                )
            }
        }

        /** Still-covered garment only. Already-scratched holes stay silent. */
        private fun fingerOnFabric(x: Float, y: Float): Boolean {
            val mask = scratchMask ?: return true
            if (mask.width < 2 || mask.height < 2) return true
            val (mx, my) = toMask(x, y)
            val ix = mx.toInt().coerceIn(0, mask.width - 1)
            val iy = my.toInt().coerceIn(0, mask.height - 1)
            return (mask.getPixel(ix, iy) ushr 24) >= 16
        }

        private fun stepCursorFx() {
            if (dust.isEmpty()) return
            val dt = 33f / 16f
            val fade = DUST_FADE.toDouble().pow(dt.toDouble()).toFloat()
            var i = 0
            while (i < dust.size) {
                val particle = dust[i]
                particle.x += particle.vx * dt
                particle.y += particle.vy * dt
                particle.vy += DUST_GRAVITY * dt
                particle.life *= fade
                if (particle.life / DUST_LIFE <= 0.02f) {
                    dust.removeAt(i)
                } else {
                    i += 1
                }
            }
        }

        private fun drawCursorFx(canvas: Canvas) {
            for (particle in dust) {
                val scale = particle.life / DUST_LIFE
                val size = DUST_SIZE * scale
                dustFill.alpha = (scale * 255f).toInt().coerceIn(0, 255)
                canvas.drawCircle(particle.x, particle.y, size * 0.42f, dustFill)
                canvas.save()
                canvas.translate(particle.x, particle.y)
                canvas.rotate(45f)
                dustGem.alpha = dustFill.alpha
                val gem = size * 0.22f
                canvas.drawRect(-gem, -gem, gem, gem, dustGem)
                canvas.restore()
            }
        }

        private fun markIconsNear(x: Float, y: Float) {
            val radius = 72f
            var revealed = 0
            var changed = false
            for (i in 0 until iconCount) {
                if (iconRevealed[i]) {
                    revealed += 1
                    continue
                }
                if (iconX[i].isNaN()) continue
                val dx = iconX[i] - x
                val dy = iconY[i] - y
                if (dx * dx + dy * dy > radius * radius) continue
                iconRevealed[i] = true
                revealed += 1
                changed = true
                val type = i
                if (type < TOP_SLOTS && !topClaimed[type]) {
                    topClaimed[type] = true
                    onIconFound?.invoke(type)
                } else {
                    iconMiss[i] = true
                }
            }
            if (changed) onSymbolsRevealed?.invoke(revealed)
        }

        fun snapshot(): Bitmap? = video.snapshot()

        private fun maybeStartTogether() {
            if (playbackStarted) return
            val background = backgroundPlayer ?: return
            val foreground = foregroundPlayer ?: return
            if (background.playbackState != Player.STATE_READY) return
            if (foreground.playbackState != Player.STATE_READY) return
            playbackStarted = true
            background.setPlaybackSpeed(1f)
            foreground.setPlaybackSpeed(1f)
            background.seekTo(0)
            foreground.seekTo(0)
            background.play()
            foreground.play()
        }

        /**
         * The garment plays live. The hidden background is nudged onto that
         * clock, and only a large gap or a loop is allowed to seek — seeking
         * every frame freezes the decoder.
         */
        private fun syncPlayers() {
            val background = backgroundPlayer ?: return
            val foreground = foregroundPlayer ?: return
            if (!playbackStarted) {
                maybeStartTogether()
                return
            }
            if (foreground.isPlaying && !background.isPlaying) background.play()
            val backgroundDuration = background.duration
            val foregroundDuration = foreground.duration
            if (backgroundDuration <= 0L || foregroundDuration <= 0L) return
            val foregroundTime = foreground.currentPosition
            val looped = lastBackgroundPosition >= 0L && foregroundTime + 200L < lastBackgroundPosition
            lastBackgroundPosition = foregroundTime
            val target =
                if (kotlin.math.abs(backgroundDuration - foregroundDuration) <= 250L) {
                    foregroundTime.coerceIn(0L, (backgroundDuration - 1L).coerceAtLeast(0L))
                } else {
                    foregroundTime % backgroundDuration
                }
            val drift = target - background.currentPosition
            val now = android.os.SystemClock.uptimeMillis()
            if (now < seekHoldUntilMs && !looped) return
            if (looped || kotlin.math.abs(drift) > SNAP_DRIFT_MS) {
                background.setPlaybackSpeed(1f)
                background.seekTo(target)
                seekHoldUntilMs = now + SEEK_HOLD_MS
                return
            }
            val speed =
                when {
                    kotlin.math.abs(drift) <= 40L -> 1f
                    drift > 0L -> 1.03f
                    else -> 0.97f
                }
            if (background.playbackParameters.speed != speed) {
                background.setPlaybackSpeed(speed)
            }
        }

        private fun scratchedFraction(): Float {
            val mask = scratchMask ?: return 0f
            val step = 12
            var clear = 0
            var total = 0
            val row = IntArray(mask.width)
            var y = 0
            while (y < mask.height) {
                mask.getPixels(row, 0, mask.width, 0, y, mask.width, 1)
                var x = 0
                while (x < mask.width) {
                    total += 1
                    if ((row[x] ushr 24) < 16) clear += 1
                    x += step
                }
                y += step
            }
            if (total == 0) return 0f
            return clear.toFloat() / total.toFloat()
        }

        private companion object {
            const val TOP_SLOTS = 6
            const val MAX_BODY = 12
            const val DUST_PER_MOVE = 5
            const val DUST_SIZE = 64f
            const val DUST_GRAVITY = 0.1f
            const val DUST_FADE = 0.96f
            const val DUST_LIFE = 100f
            const val MAX_DUST = 250
            const val SNAP_DRIFT_MS = 280L
            const val SEEK_HOLD_MS = 400L
        }
    }

private class Dust(
    var x: Float,
    var y: Float,
    var vx: Float,
    var vy: Float,
    var life: Float,
)
