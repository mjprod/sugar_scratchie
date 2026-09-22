package com.sugarscratchie.smoke.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLUtils
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Both clips are GPU textures drawn into one TextureView. Scratches only update
 * a mask, so neither video is copied on the CPU during playback.
 */
class DualVideoGlView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener {
    var chromaKey: Boolean = false
    var onSurfaces: ((Surface, Surface) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val maskLock = Any()
    private var mask: Bitmap? = null
    private val maskDirty = AtomicBoolean(false)
    private var renderer: Renderer? = null

    init {
        surfaceTextureListener = this
        isOpaque = true
    }

    fun attachMask(bitmap: Bitmap?) {
        synchronized(maskLock) { mask = bitmap }
        maskDirty.set(true)
        renderer?.wake()
    }

    fun invalidateMask() {
        maskDirty.set(true)
        renderer?.wake()
    }

    fun lockMask(block: () -> Unit) {
        synchronized(maskLock) { block() }
    }

    /** Latest composited frame, for the film transition only. */
    fun snapshot(): Bitmap? =
        try {
            bitmap
        } catch (_: Exception) {
            null
        }

    override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
        renderer = Renderer(surface, width, height).also { it.start() }
    }

    override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
        renderer?.resize(width, height)
    }

    override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
        renderer?.shutdown()
        renderer = null
        return true
    }

    override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit

    private inner class Renderer(
        private val window: SurfaceTexture,
        width: Int,
        height: Int,
    ) : Thread("dual-video") {
        private val wake = Object()
        private val running = AtomicBoolean(true)
        private val bgFrame = AtomicBoolean(false)
        private val fgFrame = AtomicBoolean(false)

        @Volatile
        private var viewWidth = width.coerceAtLeast(1)

        @Volatile
        private var viewHeight = height.coerceAtLeast(1)

        private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
        private var context: EGLContext = EGL14.EGL_NO_CONTEXT
        private var surface: EGLSurface = EGL14.EGL_NO_SURFACE
        private var program = 0
        private var bgTex = 0
        private var fgTex = 0
        private var maskTex = 0
        private var bgSurfaceTexture: SurfaceTexture? = null
        private var fgSurfaceTexture: SurfaceTexture? = null
        private var bgSurface: Surface? = null
        private var fgSurface: Surface? = null
        private val bgMatrix = FloatArray(16)
        private val fgMatrix = FloatArray(16)
        private val quad: FloatBuffer =
            ByteBuffer.allocateDirect(16 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
                put(floatArrayOf(-1f, -1f, 0f, 0f, 1f, -1f, 1f, 0f, -1f, 1f, 0f, 1f, 1f, 1f, 1f, 1f))
                position(0)
            }

        fun wake() {
            synchronized(wake) { wake.notifyAll() }
        }

        fun resize(width: Int, height: Int) {
            viewWidth = width.coerceAtLeast(1)
            viewHeight = height.coerceAtLeast(1)
            wake()
        }

        fun shutdown() {
            running.set(false)
            wake()
            try {
                join(800)
            } catch (_: InterruptedException) {
                interrupt()
            }
        }

        override fun run() {
            if (!initEgl()) return
            initGl()
            while (running.get()) {
                if (bgFrame.getAndSet(false)) bgSurfaceTexture?.updateTexImage()
                if (fgFrame.getAndSet(false)) fgSurfaceTexture?.updateTexImage()
                draw()
                EGL14.eglSwapBuffers(display, surface)
                if (!bgFrame.get() && !fgFrame.get() && !maskDirty.get()) {
                    synchronized(wake) {
                        if (!bgFrame.get() && !fgFrame.get() && !maskDirty.get() && running.get()) {
                            try {
                                wake.wait(500)
                            } catch (_: InterruptedException) {
                                running.set(false)
                            }
                        }
                    }
                }
            }
            releaseGl()
        }

        private fun initEgl(): Boolean {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            if (display == EGL14.EGL_NO_DISPLAY) return false
            val version = IntArray(2)
            if (!EGL14.eglInitialize(display, version, 0, version, 1)) return false
            val attribs =
                intArrayOf(
                    EGL14.EGL_RED_SIZE, 8,
                    EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8,
                    EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_NONE,
                )
            val configs = arrayOfNulls<EGLConfig>(1)
            val count = IntArray(1)
            if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0)) return false
            val config = configs[0] ?: return false
            context =
                EGL14.eglCreateContext(
                    display,
                    config,
                    EGL14.EGL_NO_CONTEXT,
                    intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE),
                    0,
                )
            surface = EGL14.eglCreateWindowSurface(display, config, window, intArrayOf(EGL14.EGL_NONE), 0)
            return EGL14.eglMakeCurrent(display, surface, surface, context)
        }

        private fun initGl() {
            program = linkProgram(VERTEX, FRAGMENT)
            bgTex = externalTexture()
            fgTex = externalTexture()
            val maskIds = IntArray(1)
            GLES20.glGenTextures(1, maskIds, 0)
            maskTex = maskIds[0]
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            val white = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
            white.eraseColor(android.graphics.Color.WHITE)
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, white, 0)
            white.recycle()

            val listener = Handler(Looper.getMainLooper())
            val background =
                SurfaceTexture(bgTex).apply {
                    setOnFrameAvailableListener({
                        bgFrame.set(true)
                        wake()
                    }, listener)
                }
            val foreground =
                SurfaceTexture(fgTex).apply {
                    setOnFrameAvailableListener({
                        fgFrame.set(true)
                        wake()
                    }, listener)
                }
            background.setDefaultBufferSize(viewWidth, viewHeight)
            foreground.setDefaultBufferSize(viewWidth, viewHeight)
            bgSurfaceTexture = background
            fgSurfaceTexture = foreground
            val backgroundSurface = Surface(background)
            val foregroundSurface = Surface(foreground)
            bgSurface = backgroundSurface
            fgSurface = foregroundSurface
            mainHandler.post { onSurfaces?.invoke(backgroundSurface, foregroundSurface) }
        }

        private fun draw() {
            bgSurfaceTexture?.getTransformMatrix(bgMatrix)
            fgSurfaceTexture?.getTransformMatrix(fgMatrix)
            if (maskDirty.getAndSet(false)) uploadMask()
            GLES20.glViewport(0, 0, viewWidth, viewHeight)
            GLES20.glUseProgram(program)
            val pos = GLES20.glGetAttribLocation(program, "aPos")
            val uv = GLES20.glGetAttribLocation(program, "aUv")
            quad.position(0)
            GLES20.glVertexAttribPointer(pos, 2, GLES20.GL_FLOAT, false, 16, quad)
            GLES20.glEnableVertexAttribArray(pos)
            quad.position(2)
            GLES20.glVertexAttribPointer(uv, 2, GLES20.GL_FLOAT, false, 16, quad)
            GLES20.glEnableVertexAttribArray(uv)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uBgMat"), 1, false, bgMatrix, 0)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uFgMat"), 1, false, fgMatrix, 0)
            GLES20.glUniform2f(GLES20.glGetUniformLocation(program, "uResolution"), viewWidth.toFloat(), viewHeight.toFloat())
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uChroma"), if (chromaKey) 1f else 0f)
            bindSampler("uBg", bgTex, GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 0)
            bindSampler("uFg", fgTex, GLES11Ext.GL_TEXTURE_EXTERNAL_OES, 1)
            bindSampler("uMask", maskTex, GLES20.GL_TEXTURE_2D, 2)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        }

        private fun uploadMask() {
            synchronized(maskLock) {
                val bitmap = mask ?: return
                if (bitmap.isRecycled) return
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
                GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
            }
        }

        private fun bindSampler(name: String, texture: Int, target: Int, unit: Int) {
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0 + unit)
            GLES20.glBindTexture(target, texture)
            GLES20.glUniform1i(GLES20.glGetUniformLocation(program, name), unit)
        }

        private fun releaseGl() {
            bgSurface?.release()
            fgSurface?.release()
            bgSurface = null
            fgSurface = null
            bgSurfaceTexture?.release()
            fgSurfaceTexture?.release()
            bgSurfaceTexture = null
            fgSurfaceTexture = null
            if (display != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(display, surface)
                EGL14.eglDestroyContext(display, context)
                EGL14.eglTerminate(display)
            }
            display = EGL14.EGL_NO_DISPLAY
            context = EGL14.EGL_NO_CONTEXT
            surface = EGL14.EGL_NO_SURFACE
        }
    }

    private companion object {
        const val VERTEX = """
            attribute vec2 aPos;
            attribute vec2 aUv;
            uniform mat4 uBgMat;
            uniform mat4 uFgMat;
            varying vec2 vBg;
            varying vec2 vFg;
            void main() {
              gl_Position = vec4(aPos, 0.0, 1.0);
              vBg = (uBgMat * vec4(aUv, 0.0, 1.0)).xy;
              vFg = (uFgMat * vec4(aUv, 0.0, 1.0)).xy;
            }
        """

        const val FRAGMENT = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES uBg;
            uniform samplerExternalOES uFg;
            uniform sampler2D uMask;
            uniform vec2 uResolution;
            uniform float uChroma;
            varying vec2 vBg;
            varying vec2 vFg;
            void main() {
              vec4 bg = texture2D(uBg, vBg);
              vec4 fg = texture2D(uFg, vFg);
              vec2 maskUv = vec2(gl_FragCoord.x / uResolution.x, 1.0 - (gl_FragCoord.y / uResolution.y));
              float keep = texture2D(uMask, maskUv).a;
              float green = step(0.5, uChroma) * step(0.27, fg.g) * step(fg.r + 0.12, fg.g) * step(fg.b + 0.12, fg.g);
              gl_FragColor = mix(bg, fg, keep * (1.0 - green));
            }
        """

        fun externalTexture(): Int {
            val id = IntArray(1)
            GLES20.glGenTextures(1, id, 0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, id[0])
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            return id[0]
        }

        fun linkProgram(vertex: String, fragment: String): Int {
            fun shader(type: Int, source: String): Int {
                val id = GLES20.glCreateShader(type)
                GLES20.glShaderSource(id, source)
                GLES20.glCompileShader(id)
                val compiled = IntArray(1)
                GLES20.glGetShaderiv(id, GLES20.GL_COMPILE_STATUS, compiled, 0)
                if (compiled[0] == 0) {
                    android.util.Log.e("DualVideo", GLES20.glGetShaderInfoLog(id))
                }
                return id
            }
            val program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, vertex))
            GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, fragment))
            GLES20.glLinkProgram(program)
            return program
        }
    }
}
