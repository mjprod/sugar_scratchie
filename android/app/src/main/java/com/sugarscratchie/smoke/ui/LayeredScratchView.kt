package com.sugarscratchie.smoke.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.TextureView
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
        var onError: ((String) -> Unit)? = null
        var mesh: GarmentMesh? = null
        var chromaKey: Boolean = true
        var scratchEnabled: Boolean = true
        private var sourceKey = ""
        private var symbolDrawables: List<LottieDrawable> = emptyList()
        private val missFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) })

        private val mediaFactory =
            DefaultMediaSourceFactory(OkHttpDataSource.Factory(devMediaClient()))

        private val backgroundView =
            TextureView(context).also {
                // Drawn from a snapshot, not this live surface, so it stays on the
                // same frame as the garment layer.
                it.alpha = 0f
                addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            }
        private val foregroundView =
            TextureView(context).also {
                // Keep decoding off-screen; we composite keyed frames ourselves.
                it.alpha = 0f
                addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            }
        private val composite =
            object : View(context) {
                override fun onDraw(canvas: Canvas) {
                    val frame = displayFrame ?: return
                    canvas.drawBitmap(frame, 0f, 0f, null)
                }
            }.also {
                addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
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
        private var displayFrame: Bitmap? = null
        private var workFrame: Bitmap? = null
        private var backgroundFrame: Bitmap? = null
        private var playbackStarted = false
        private var driftSinceMs = 0L
        private var lastSeekAtMs = 0L

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
        private var moveTicks = 0
        private var copying = false
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
                    captureAndComposite()
                    if (dust.isNotEmpty()) iconOverlay.invalidate()
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
            driftSinceMs = 0L
            lastSeekAtMs = 0L
            resetRound()
            releasePlayers()
            backgroundPlayer = buildPlayer(backgroundUrl, backgroundView)
            foregroundPlayer = buildPlayer(foregroundUrl, foregroundView)
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
            composite.invalidate()
        }

        fun release() {
            mainHandler.removeCallbacks(compositeTick)
            releasePlayers()
            symbolDrawables.forEach { it.cancelAnimation() }
            symbolDrawables = emptyList()
            scratchMask?.recycle()
            scratchMask = null
            scratchCanvas = null
            displayFrame?.recycle()
            displayFrame = null
            workFrame?.recycle()
            workFrame = null
            backgroundFrame?.recycle()
            backgroundFrame = null
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            if (w <= 0 || h <= 0) return
            scratchMask?.recycle()
            displayFrame?.recycle()
            workFrame?.recycle()
            backgroundFrame?.recycle()
            val mask = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(mask)
            canvas.drawColor(Color.WHITE)
            scratchMask = mask
            scratchCanvas = canvas
            displayFrame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            workFrame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            backgroundFrame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (!scratchEnabled) return false
            val canvas = scratchCanvas ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    scratching = true
                    lastX = event.x
                    lastY = event.y
                    canvas.drawCircle(event.x, event.y, 70f, eraseDot)
                    markIconsNear(event.x, event.y)
                    spawnCursorFx(event.x, event.y)
                }
                MotionEvent.ACTION_MOVE -> {
                    canvas.drawLine(lastX, lastY, event.x, event.y, erase)
                    lastX = event.x
                    lastY = event.y
                    moveTicks += 1
                    if (moveTicks % 4 == 0) {
                        onScratched?.invoke(scratchedFraction())
                    }
                    markIconsNear(event.x, event.y)
                    spawnCursorFx(event.x, event.y)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    scratching = false
                    lastDustX = Float.NaN
                    lastDustY = Float.NaN
                }
            }
            return true
        }

        override fun onDetachedFromWindow() {
            release()
            super.onDetachedFromWindow()
        }

        private fun buildPlayer(url: String, textureView: TextureView): ExoPlayer {
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
                        addListener(
                            object : Player.Listener {
                                override fun onPlaybackStateChanged(playbackState: Int) {
                                    maybeStartTogether()
                                }
                            },
                        )
                    }

            fun bindSurface() {
                val surface = textureView.surfaceTexture ?: return
                player.setVideoTexture(surface)
            }

            if (textureView.isAvailable) {
                bindSurface()
            } else {
                textureView.surfaceTextureListener =
                    object : TextureView.SurfaceTextureListener {
                        override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                            bindSurface()
                        }

                        override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit

                        override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                            player.clearVideoSurface()
                            return true
                        }

                        override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
                    }
            }
            return player
        }

        private fun releasePlayers() {
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

        private fun spawnCursorFx(x: Float, y: Float) {
            if (!scratching || !fingerOnFabric(x, y)) return
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

        /** Coins stay on the garment. Keyed-out and already-scratched pixels spawn nothing. */
        private fun fingerOnFabric(x: Float, y: Float): Boolean {
            val frame = displayFrame ?: return true
            if (frame.width < 2 || frame.height < 2) return true
            val ix = x.toInt().coerceIn(0, frame.width - 1)
            val iy = y.toInt().coerceIn(0, frame.height - 1)
            return (frame.getPixel(ix, iy) ushr 24) >= FABRIC_ALPHA_MIN
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
            for (i in 0 until iconCount) {
                if (iconRevealed[i] || iconX[i].isNaN()) continue
                val dx = iconX[i] - x
                val dy = iconY[i] - y
                if (dx * dx + dy * dy > radius * radius) continue
                iconRevealed[i] = true
                val type = i
                if (type < TOP_SLOTS && !topClaimed[type]) {
                    topClaimed[type] = true
                    onIconFound?.invoke(type)
                } else {
                    iconMiss[i] = true
                }
            }
        }

        private fun maybeStartTogether() {
            if (playbackStarted) return
            val background = backgroundPlayer ?: return
            val foreground = foregroundPlayer ?: return
            if (background.playbackState != Player.STATE_READY) return
            if (foreground.playbackState != Player.STATE_READY) return
            playbackStarted = true
            background.seekTo(0)
            foreground.seekTo(0)
            background.play()
            foreground.play()
        }

        /** Keep the garment clip on the background clock. Seeks only, and rarely. */
        private fun syncPlayers() {
            val background = backgroundPlayer ?: return
            val foreground = foregroundPlayer ?: return
            if (!playbackStarted) {
                maybeStartTogether()
                return
            }
            val backgroundDuration = background.duration
            val foregroundDuration = foreground.duration
            if (backgroundDuration <= 0L || foregroundDuration <= 0L) return
            val backgroundTime = background.currentPosition
            val target =
                if (kotlin.math.abs(backgroundDuration - foregroundDuration) <= 250L) {
                    backgroundTime.coerceIn(0L, foregroundDuration - 1L)
                } else {
                    backgroundTime % foregroundDuration
                }
            val drift = target - foreground.currentPosition
            val now = android.os.SystemClock.uptimeMillis()
            if (kotlin.math.abs(drift) > HARD_SEEK_DRIFT_MS) {
                foreground.seekTo(target)
                driftSinceMs = 0L
                lastSeekAtMs = now
                return
            }
            if (kotlin.math.abs(drift) > SOFT_SEEK_DRIFT_MS) {
                if (driftSinceMs == 0L) {
                    driftSinceMs = now
                } else if (
                    now - driftSinceMs >= SOFT_SEEK_CONFIRM_MS &&
                    now - lastSeekAtMs >= SOFT_SEEK_COOLDOWN_MS
                ) {
                    foreground.seekTo(target)
                    driftSinceMs = 0L
                    lastSeekAtMs = now
                }
            } else {
                driftSinceMs = 0L
            }
        }

        private fun captureAndComposite() {
            if (copying) return
            syncPlayers()
            val backgroundBitmap = backgroundFrame ?: return
            val foregroundBitmap = workFrame ?: return
            val mask = scratchMask ?: return
            if (!foregroundView.isAvailable || !backgroundView.isAvailable) return
            if (foregroundView.width == 0 || backgroundView.width == 0) return
            if (foregroundBitmap.width != width || foregroundBitmap.height != height) return

            copying = true
            copySurface(backgroundView, backgroundBitmap) { backgroundOk ->
                if (!backgroundOk) {
                    copying = false
                    return@copySurface
                }
                copySurface(foregroundView, foregroundBitmap) { foregroundOk ->
                    copying = false
                    if (!foregroundOk) return@copySurface
                    applyChromaAndMask(foregroundBitmap, mask)
                    val out = displayFrame ?: return@copySurface
                    val canvas = Canvas(out)
                    canvas.drawBitmap(backgroundBitmap, 0f, 0f, null)
                    canvas.drawBitmap(foregroundBitmap, 0f, 0f, null)
                    composite.invalidate()
                    placeIcons()
                    iconOverlay.invalidate()
                }
            }
        }

        private fun copySurface(view: TextureView, bitmap: Bitmap, done: (Boolean) -> Unit) {
            val surfaceTexture = view.surfaceTexture
            if (surfaceTexture == null) {
                done(false)
                return
            }
            val surface = android.view.Surface(surfaceTexture)
            try {
                PixelCopy.request(
                    surface,
                    bitmap,
                    { result ->
                        surface.release()
                        done(result == PixelCopy.SUCCESS)
                    },
                    mainHandler,
                )
            } catch (e: Exception) {
                surface.release()
                copying = false
                onError?.invoke(e.message ?: "Could not composite video")
                done(false)
            }
        }

        private fun applyChromaAndMask(frame: Bitmap, mask: Bitmap) {
            val w = frame.width
            val h = frame.height
            val row = IntArray(w)
            val maskRow = IntArray(w)
            for (y in 0 until h) {
                frame.getPixels(row, 0, w, 0, y, w, 1)
                mask.getPixels(maskRow, 0, w, 0, y, w, 1)
                for (x in 0 until w) {
                    val c = row[x]
                    val r = (c shr 16) and 0xFF
                    val g = (c shr 8) and 0xFF
                    val b = c and 0xFF
                    val greenScreen = chromaKey && g > 70 && g > r + 30 && g > b + 30
                    val scratched = (maskRow[x] ushr 24) < 16
                    row[x] =
                        if (greenScreen || scratched) {
                            Color.TRANSPARENT
                        } else {
                            c or (0xFF shl 24)
                        }
                }
                frame.setPixels(row, 0, w, 0, y, w, 1)
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
            const val FABRIC_ALPHA_MIN = 31
            const val HARD_SEEK_DRIFT_MS = 450L
            const val SOFT_SEEK_DRIFT_MS = 50L
            const val SOFT_SEEK_CONFIRM_MS = 150L
            const val SOFT_SEEK_COOLDOWN_MS = 2000L
        }
    }

private class Dust(
    var x: Float,
    var y: Float,
    var vx: Float,
    var vy: Float,
    var life: Float,
)

private fun ExoPlayer.setVideoTexture(surfaceTexture: SurfaceTexture) {
    setVideoSurface(android.view.Surface(surfaceTexture))
}
