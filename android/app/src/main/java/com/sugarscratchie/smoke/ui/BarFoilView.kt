package com.sugarscratchie.smoke.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Shader
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import com.sugarscratchie.smoke.data.DevEndpoints
import com.sugarscratchie.smoke.data.devMediaClient
import okhttp3.Request
import java.util.concurrent.Executors
import kotlin.math.hypot
import kotlin.math.max

/**
 * Scratch coat over the centered symbol bar, using the same foil image as the web.
 */
class BarFoilView
    @JvmOverloads
    constructor(
        context: Context,
        attrs: AttributeSet? = null,
    ) : View(context, attrs) {
        var onCleared: (() -> Unit)? = null

        private var coat: Bitmap? = null
        private var coatCanvas: Canvas? = null
        private var cleared = false
        private var coatedWithTexture = false
        private var lastX = 0f
        private var lastY = 0f
        private var lastTouchMs = 0L
        private val haptics = ScratchHaptics(context)
        private val erase =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
            }

        init {
            clipToOutline = true
            outlineProvider =
                object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) {
                        outline.setRoundRect(0, 0, view.width, view.height, view.height / 2f)
                    }
                }
            ensureTexture()
        }

        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            if (w <= 0 || h <= 0) return
            coat?.recycle()
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            coat = bitmap
            coatCanvas = Canvas(bitmap)
            cleared = false
            coatedWithTexture = false
            paintCoat()
            invalidateOutline()
        }

        private fun paintCoat() {
            val canvas = coatCanvas ?: return
            val width = canvas.width.toFloat()
            val height = canvas.height.toFloat()
            canvas.drawColor(0xFF9A9590.toInt())
            val tex = texture
            if (tex != null && tex.height > 0) {
                val scale = max((height / tex.height) * 1.15f, 1f)
                val shader =
                    BitmapShader(tex, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
                        setLocalMatrix(Matrix().apply { setScale(scale, scale) })
                    }
                canvas.drawRect(0f, 0f, width, height, Paint().apply { this.shader = shader })
            }
            val highlight =
                Paint().apply {
                    shader =
                        LinearGradient(
                            0f,
                            0f,
                            0f,
                            height * 0.4f,
                            0x33FFFFFF,
                            Color.TRANSPARENT,
                            Shader.TileMode.CLAMP,
                        )
                }
            canvas.drawRect(0f, 0f, width, height, highlight)
            coatedWithTexture = tex != null
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            if (texture != null && !coatedWithTexture) paintCoat()
            val bitmap = coat ?: return
            canvas.drawBitmap(bitmap, 0f, 0f, null)
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            val canvas = coatCanvas ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                    val fresh = coatAt(event.x, event.y)
                    val speed =
                        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                            0f
                        } else {
                            val dt = (event.eventTime - lastTouchMs).coerceAtLeast(1L)
                            hypot(event.x - lastX, event.y - lastY) / dt * 1000f
                        }
                    haptics.pulse(speed, event.pressure, fresh)
                    erase.style = if (event.actionMasked == MotionEvent.ACTION_DOWN) Paint.Style.FILL else Paint.Style.STROKE
                    erase.strokeWidth = 72f
                    erase.strokeCap = Paint.Cap.ROUND
                    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                        canvas.drawCircle(event.x, event.y, 36f, erase)
                    } else {
                        canvas.drawLine(lastX, lastY, event.x, event.y, erase)
                    }
                    lastX = event.x
                    lastY = event.y
                    lastTouchMs = event.eventTime
                    invalidate()
                    if (!cleared && clearedFraction() >= 0.55f) {
                        cleared = true
                        onCleared?.invoke()
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> haptics.stop()
            }
            return true
        }

        private fun coatAt(x: Float, y: Float): Boolean {
            val bitmap = coat ?: return false
            val ix = x.toInt().coerceIn(0, bitmap.width - 1)
            val iy = y.toInt().coerceIn(0, bitmap.height - 1)
            return (bitmap.getPixel(ix, iy) ushr 24) >= 16
        }

        private fun clearedFraction(): Float {
            val bitmap = coat ?: return 0f
            val step = 8
            var clear = 0
            var total = 0
            val row = IntArray(bitmap.width)
            var y = 0
            while (y < bitmap.height) {
                bitmap.getPixels(row, 0, bitmap.width, 0, y, bitmap.width, 1)
                var x = 0
                while (x < bitmap.width) {
                    total += 1
                    if ((row[x] ushr 24) < 16) clear += 1
                    x += step
                }
                y += step
            }
            if (total == 0) return 0f
            return clear.toFloat() / total.toFloat()
        }

        private fun ensureTexture() {
            if (texture != null || textureLoading) {
                return
            }
            textureLoading = true
            loader.execute {
                try {
                    val url = DevEndpoints.mediaBaseUrl + "/scratch/scratchTexture.jpg"
                    val request = Request.Builder().url(url).get().build()
                    devMediaClient().newCall(request).execute().use { response ->
                        val bytes = response.body?.bytes()
                        if (response.isSuccessful && bytes != null) {
                            texture = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        }
                    }
                } catch (_: Exception) {
                    texture = null
                } finally {
                    textureLoading = false
                    post { paintCoat() }
                }
            }
        }

        override fun onDetachedFromWindow() {
            haptics.stop()
            coat?.recycle()
            coat = null
            coatCanvas = null
            super.onDetachedFromWindow()
        }

        companion object {
            private val loader = Executors.newSingleThreadExecutor()

            @Volatile
            private var texture: Bitmap? = null

            @Volatile
            private var textureLoading = false
        }
    }
