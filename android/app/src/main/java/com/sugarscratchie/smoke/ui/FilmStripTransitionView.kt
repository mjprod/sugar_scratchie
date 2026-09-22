package com.sugarscratchie.smoke.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Surface
import android.view.TextureView
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.sugarscratchie.smoke.data.devMediaClient
import kotlin.math.min
import kotlin.math.sin

/**
 * Four-frame film strip between motion cards, matching the web mirror slide:
 * current, flipped current, flipped next, next. The strip travels three
 * frames so the next card lands full-screen.
 */
class FilmStripTransitionView(context: Context) : FrameLayout(context) {
    var onFinished: (() -> Unit)? = null

    private val strip = StripView(context)
    private var player: ExoPlayer? = null
    private var toFrame: Bitmap? = null
    private var started = false
    private var sliding = false
    private var finished = false
    private val handler = Handler(Looper.getMainLooper())
    private val giveUp = Runnable { beginSlide() }

    init {
        setBackgroundColor(Color.BLACK)
        isClickable = true
        addView(strip, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun start(from: Bitmap, toUrl: String) {
        strip.fromFrame = from
        val texture = TextureView(context)
        texture.alpha = 0f
        texture.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        addView(texture, 0)
        val exo =
            ExoPlayer.Builder(context)
                .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(devMediaClient())))
                .build()
        player = exo
        exo.volume = 0f
        exo.playWhenReady = true
        exo.setMediaItem(MediaItem.fromUri(toUrl))
        exo.prepare()

        fun bind(surfaceTexture: SurfaceTexture) {
            exo.setVideoSurface(Surface(surfaceTexture))
        }
        texture.surfaceTextureListener =
            object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                    bind(surface)
                }

                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit

                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                    exo.clearVideoSurface()
                    return true
                }

                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
                    if (started || texture.width < 2 || texture.height < 2) return
                    started = true
                    val bitmap = Bitmap.createBitmap(texture.width, texture.height, Bitmap.Config.ARGB_8888)
                    val copySurface = Surface(surface)
                    try {
                        PixelCopy.request(
                            copySurface,
                            bitmap,
                            { result ->
                                copySurface.release()
                                if (sliding || finished) {
                                    bitmap.recycle()
                                    return@request
                                }
                                if (result == PixelCopy.SUCCESS) {
                                    toFrame = bitmap
                                    strip.toFrame = bitmap
                                } else {
                                    bitmap.recycle()
                                }
                                releasePlayer()
                                removeView(texture)
                                beginSlide()
                            },
                            handler,
                        )
                    } catch (_: Exception) {
                        copySurface.release()
                        bitmap.recycle()
                        releasePlayer()
                        removeView(texture)
                        beginSlide()
                    }
                }
            }
        if (texture.isAvailable) {
            texture.surfaceTexture?.let { bind(it) }
        }
        handler.postDelayed(giveUp, 600L)
    }

    private fun beginSlide() {
        if (finished || sliding) return
        sliding = true
        handler.removeCallbacks(giveUp)
        releasePlayer()
        strip.play(templateIndex % 3) {
            finish()
        }
        templateIndex += 1
    }

    private fun finish() {
        if (finished) return
        finished = true
        onFinished?.invoke()
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    override fun onDetachedFromWindow() {
        finished = true
        handler.removeCallbacks(giveUp)
        strip.stop()
        releasePlayer()
        toFrame?.recycle()
        toFrame = null
        strip.fromFrame?.recycle()
        strip.fromFrame = null
        strip.toFrame = null
        super.onDetachedFromWindow()
    }

    private class StripView(context: Context) : android.view.View(context) {
        var fromFrame: Bitmap? = null
        var toFrame: Bitmap? = null
        private var progress = 0f
        private var kind = 0
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private val flash = Paint()
        private var animator: android.animation.ValueAnimator? = null

        fun stop() {
            animator?.cancel()
            animator = null
        }

        fun play(template: Int, onEnd: () -> Unit) {
            kind = template
            val duration = when (template) {
                1 -> 750L
                2 -> 850L
                else -> 560L
            }
            animator?.cancel()
            animator =
                android.animation.ValueAnimator.ofFloat(0f, 1f).apply {
                    this.duration = duration
                    interpolator = PathInterpolator(0.51f, 0.02f, 0.44f, 1.14f)
                    addUpdateListener {
                        progress = it.animatedValue as Float
                        invalidate()
                    }
                    addListener(
                        object : android.animation.AnimatorListenerAdapter() {
                            override fun onAnimationEnd(animation: android.animation.Animator) {
                                onEnd()
                            }
                        },
                    )
                    start()
                }
        }

        override fun onDraw(canvas: Canvas) {
            val from = fromFrame ?: return
            val to = toFrame ?: from
            val w = width.toFloat()
            val h = height.toFloat()
            if (w < 2f || h < 2f) return
            val scale =
                when (kind) {
                    2 -> 1f + 0.28f * sin(progress * Math.PI).toFloat()
                    else -> 1f + 0.03f * sin(progress * Math.PI).toFloat()
                }
            val travelY =
                if (kind == 1) sin(progress * Math.PI * 4).toFloat() * h * 0.04f else 0f
            canvas.drawColor(Color.BLACK)
            canvas.save()
            canvas.translate(w / 2f, h / 2f)
            canvas.scale(scale, scale)
            canvas.translate(-w / 2f, -h / 2f)
            canvas.translate(-3f * w * progress, travelY)
            drawTile(canvas, from, 0, false, w, h)
            drawTile(canvas, from, 1, true, w, h)
            drawTile(canvas, to, 2, true, w, h)
            drawTile(canvas, to, 3, false, w, h)
            canvas.restore()
            if (kind == 1) {
                val flashAlpha = (sin(progress * Math.PI).toFloat() * 70f).toInt().coerceIn(0, 70)
                flash.color = Color.argb(flashAlpha, 255, 255, 255)
                canvas.drawRect(0f, 0f, w, h, flash)
            }
        }

        private fun drawTile(canvas: Canvas, bitmap: Bitmap, index: Int, flip: Boolean, w: Float, h: Float) {
            if (bitmap.isRecycled) return
            canvas.save()
            canvas.translate(index * w, 0f)
            canvas.clipRect(0f, 0f, w, h)
            if (flip) {
                canvas.translate(w, 0f)
                canvas.scale(-1f, 1f)
            }
            val scale = min(w / bitmap.width, h / bitmap.height)
            val dw = bitmap.width * scale
            val dh = bitmap.height * scale
            canvas.translate((w - dw) / 2f, (h - dh) / 2f)
            canvas.drawBitmap(bitmap, null, android.graphics.RectF(0f, 0f, dw, dh), paint)
            canvas.restore()
        }
    }

    companion object {
        private var templateIndex = 0
    }
}
