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
import com.sugarscratchie.smoke.data.devMediaClient

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
        var onError: ((String) -> Unit)? = null

        private val mediaFactory =
            DefaultMediaSourceFactory(OkHttpDataSource.Factory(devMediaClient()))

        private val backgroundView =
            TextureView(context).also {
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

        private var backgroundPlayer: ExoPlayer? = null
        private var foregroundPlayer: ExoPlayer? = null

        private var scratchMask: Bitmap? = null
        private var scratchCanvas: Canvas? = null
        private var displayFrame: Bitmap? = null
        private var workFrame: Bitmap? = null

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

        private val mainHandler = Handler(Looper.getMainLooper())
        private val compositeTick =
            object : Runnable {
                override fun run() {
                    captureAndComposite()
                    mainHandler.postDelayed(this, 33L)
                }
            }

        fun setSources(backgroundUrl: String, foregroundUrl: String) {
            releasePlayers()
            backgroundPlayer = buildPlayer(backgroundUrl, backgroundView)
            foregroundPlayer = buildPlayer(foregroundUrl, foregroundView)
            mainHandler.removeCallbacks(compositeTick)
            mainHandler.post(compositeTick)
        }

        fun release() {
            mainHandler.removeCallbacks(compositeTick)
            releasePlayers()
            scratchMask?.recycle()
            scratchMask = null
            scratchCanvas = null
            displayFrame?.recycle()
            displayFrame = null
            workFrame?.recycle()
            workFrame = null
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            if (w <= 0 || h <= 0) return
            scratchMask?.recycle()
            displayFrame?.recycle()
            workFrame?.recycle()
            val mask = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(mask)
            canvas.drawColor(Color.WHITE)
            scratchMask = mask
            scratchCanvas = canvas
            displayFrame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            workFrame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            val canvas = scratchCanvas ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = event.x
                    lastY = event.y
                    canvas.drawCircle(event.x, event.y, 70f, eraseDot)
                }
                MotionEvent.ACTION_MOVE -> {
                    canvas.drawLine(lastX, lastY, event.x, event.y, erase)
                    lastX = event.x
                    lastY = event.y
                    moveTicks += 1
                    if (moveTicks % 4 == 0) {
                        onScratched?.invoke(scratchedFraction())
                    }
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
                        playWhenReady = true
                        volume = 0f
                        setMediaItem(MediaItem.fromUri(url))
                        prepare()
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

        private fun captureAndComposite() {
            if (copying) return
            val dst = workFrame ?: return
            val mask = scratchMask ?: return
            if (!foregroundView.isAvailable || foregroundView.width == 0 || foregroundView.height == 0) return
            if (dst.width != width || dst.height != height) return

            copying = true
            val surfaceTexture = foregroundView.surfaceTexture
            if (surfaceTexture == null) {
                copying = false
                return
            }
            val surface = android.view.Surface(surfaceTexture)
            try {
                PixelCopy.request(surface, dst, { result ->
                    surface.release()
                    copying = false
                    if (result != PixelCopy.SUCCESS) return@request
                    applyChromaAndMask(dst, mask)
                    val out = displayFrame ?: return@request
                    val canvas = Canvas(out)
                    canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
                    canvas.drawBitmap(dst, 0f, 0f, null)
                    displayFrame = out
                    composite.invalidate()
                }, mainHandler)
            } catch (e: Exception) {
                surface.release()
                copying = false
                onError?.invoke(e.message ?: "Could not composite video")
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
                    val greenScreen = g > 70 && g > r + 30 && g > b + 30
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
    }

private fun ExoPlayer.setVideoTexture(surfaceTexture: SurfaceTexture) {
    setVideoSurface(android.view.Surface(surfaceTexture))
}
