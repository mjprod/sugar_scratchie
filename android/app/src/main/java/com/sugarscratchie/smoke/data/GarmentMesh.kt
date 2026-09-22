package com.sugarscratchie.smoke.data

import android.util.JsonReader
import java.io.StringReader
import kotlin.math.floor
import kotlin.math.min

/**
 * Deforming garment lattice from `tracked-mesh` JSON.
 * Symbol icons are mesh UV points, reprojected with the frame that matches video time.
 */
class GarmentMesh(
    val cols: Int,
    val rows: Int,
    val canvasWidth: Float,
    val canvasHeight: Float,
    private val times: FloatArray,
    private val frames: Array<FloatArray>,
    val symbols: FloatArray,
) {
    val symbolCount: Int = symbols.size / 2
    private val sample = FloatArray(cols * rows * 2)

    fun sampleVerts(timeSec: Float): FloatArray {
        if (frames.isEmpty()) return sample
        val duration = times.last()
        val t = if (duration > 0f && times.size > 1) timeSec % duration else timeSec
        var prev = 0
        var next = times.lastIndex
        for (i in times.indices) {
            if (times[i] <= t) prev = i
            if (times[i] >= t) {
                next = i
                break
            }
        }
        val span = times[next] - times[prev]
        val alpha = if (span <= 1e-4f) 0f else ((t - times[prev]) / span).coerceIn(0f, 1f)
        val a = frames[prev]
        val b = frames[next]
        for (i in sample.indices) {
            sample[i] = a[i] + (b[i] - a[i]) * alpha
        }
        return sample
    }

    /** Bilinear lookup. u,v are 0–1 across the grid, matching `sampleMeshUvToWorld`. */
    fun uvToWorld(verts: FloatArray, u: Float, v: Float): Pair<Float, Float> {
        val gx = (u * (cols - 1)).coerceIn(0f, (cols - 1).toFloat())
        val gy = (v * (rows - 1)).coerceIn(0f, (rows - 1).toFloat())
        val x0 = floor(gx.toDouble()).toInt()
        val y0 = floor(gy.toDouble()).toInt()
        val x1 = min(cols - 1, x0 + 1)
        val y1 = min(rows - 1, y0 + 1)
        val fx = gx - x0
        val fy = gy - y0
        fun vx(x: Int, y: Int) = verts[(y * cols + x) * 2]
        fun vy(x: Int, y: Int) = verts[(y * cols + x) * 2 + 1]
        val topX = vx(x0, y0) + (vx(x1, y0) - vx(x0, y0)) * fx
        val topY = vy(x0, y0) + (vy(x1, y0) - vy(x0, y0)) * fx
        val botX = vx(x0, y1) + (vx(x1, y1) - vx(x0, y1)) * fx
        val botY = vy(x0, y1) + (vy(x1, y1) - vy(x0, y1)) * fx
        return (topX + (botX - topX) * fy) to (topY + (botY - topY) * fy)
    }

    companion object {
        fun parse(raw: String): GarmentMesh? {
            if (!raw.contains("\"symbolPoints\"")) return null
            return try {
                JsonReader(StringReader(raw)).use { reader ->
                    reader.isLenient = true
                    var cols = 0
                    var rows = 0
                    var canvasWidth = 390f
                    var canvasHeight = 672f
                    var symbols: FloatArray? = null
                    val times = ArrayList<Float>()
                    val frames = ArrayList<FloatArray>()
                    reader.beginObject()
                    while (reader.hasNext()) {
                        when (reader.nextName()) {
                            "canvas" -> {
                                reader.beginObject()
                                while (reader.hasNext()) {
                                    when (reader.nextName()) {
                                        "width" -> canvasWidth = reader.nextDouble().toFloat()
                                        "height" -> canvasHeight = reader.nextDouble().toFloat()
                                        else -> reader.skipValue()
                                    }
                                }
                                reader.endObject()
                            }
                            "mesh" -> {
                                reader.beginObject()
                                while (reader.hasNext()) {
                                    when (reader.nextName()) {
                                        "cols" -> cols = reader.nextInt()
                                        "rows" -> rows = reader.nextInt()
                                        else -> reader.skipValue()
                                    }
                                }
                                reader.endObject()
                            }
                            "frames" -> {
                                if (cols < 2 || rows < 2) return null
                                val expected = cols * rows
                                reader.beginArray()
                                while (reader.hasNext()) {
                                    var time = 0f
                                    var packed: FloatArray? = null
                                    reader.beginObject()
                                    while (reader.hasNext()) {
                                        when (reader.nextName()) {
                                            "t" -> time = reader.nextDouble().toFloat()
                                            "verts" -> {
                                                packed = FloatArray(expected * 2)
                                                reader.beginArray()
                                                var i = 0
                                                while (reader.hasNext()) {
                                                    reader.beginArray()
                                                    if (i + 1 < packed.size) {
                                                        packed[i] = reader.nextDouble().toFloat()
                                                        packed[i + 1] = reader.nextDouble().toFloat()
                                                    } else {
                                                        reader.skipValue()
                                                        reader.skipValue()
                                                    }
                                                    i += 2
                                                    reader.endArray()
                                                }
                                                reader.endArray()
                                                if (i != expected * 2) return null
                                            }
                                            else -> reader.skipValue()
                                        }
                                    }
                                    reader.endObject()
                                    val verts = packed ?: return null
                                    times.add(time)
                                    frames.add(verts)
                                }
                                reader.endArray()
                            }
                            "symbolPoints" -> {
                                val points = ArrayList<Float>()
                                reader.beginArray()
                                while (reader.hasNext()) {
                                    var u = 0f
                                    var v = 0f
                                    reader.beginObject()
                                    while (reader.hasNext()) {
                                        when (reader.nextName()) {
                                            "u" -> u = reader.nextDouble().toFloat()
                                            "v" -> v = reader.nextDouble().toFloat()
                                            else -> reader.skipValue()
                                        }
                                    }
                                    reader.endObject()
                                    points.add(u)
                                    points.add(v)
                                }
                                reader.endArray()
                                symbols = points.toFloatArray()
                            }
                            else -> reader.skipValue()
                        }
                    }
                    reader.endObject()
                    val symbolUv = symbols ?: return null
                    if (symbolUv.size < 12 || times.isEmpty()) return null
                    GarmentMesh(
                        cols,
                        rows,
                        canvasWidth,
                        canvasHeight,
                        times.toFloatArray(),
                        frames.toTypedArray(),
                        symbolUv,
                    )
                }
            } catch (_: Exception) {
                null
            }
        }
    }
}
