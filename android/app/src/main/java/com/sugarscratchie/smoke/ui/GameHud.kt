package com.sugarscratchie.smoke.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieConstants

/** Same six targets as the web match bar (first catalog symbols). */
internal val GAME_SYMBOLS = listOf("Heart", "Lock", "Gem", "Star", "Diamond", "Magnet")

@Composable
fun GameTopBar(
    foundMask: Int,
    diamonds: Int,
    coins: Int,
    note: String?,
    symbolCompositions: List<LottieComposition> = emptyList(),
    showWallet: Boolean = true,
    scratchable: Boolean = false,
    onBarCleared: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (showWallet) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WalletChip(mark = "◆", value = diamonds, tint = Color(0xFF7EC8FF))
                WalletChip(mark = "●", value = coins, tint = Color(0xFFFFD56A))
            }
        }
        Box {
            Row(
                modifier =
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(Color(0x9E141210))
                        .border(1.dp, Color(0x47FFFFFF), RoundedCornerShape(999.dp))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GAME_SYMBOLS.forEachIndexed { index, name ->
                    SymbolSlot(
                        name = name,
                        found = ((foundMask shr index) and 1) == 1,
                        composition = symbolCompositions.getOrNull(index),
                    )
                }
            }
            if (scratchable) {
                AndroidView(
                    factory = { context ->
                        BarFoilView(context).apply { this.onCleared = onBarCleared }
                    },
                    update = { view -> view.onCleared = onBarCleared },
                    modifier = Modifier.matchParentSize(),
                )
            }
        }
        if (!note.isNullOrBlank()) {
            Text(note, color = Color(0xFFFFE7A3), fontSize = 12.sp)
        }
    }
}

@Composable
private fun WalletChip(mark: String, value: Int, tint: Color) {
    Row(
        modifier =
            Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(Color(0xB3141210))
                .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(999.dp))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(mark, color = tint, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Text(value.toString(), color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun SymbolSlot(name: String, found: Boolean, composition: LottieComposition?) {
    Box(
        modifier =
            Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(if (found) Color(0x33FFD278) else Color(0xFA080706))
                .border(
                    1.dp,
                    if (found) Color(0xBFFFDC8C) else Color(0x33FFFFFF),
                    CircleShape,
                ),
        contentAlignment = Alignment.Center,
    ) {
        if (composition != null) {
            LottieAnimation(
                composition = composition,
                iterations = LottieConstants.IterateForever,
                modifier = Modifier.size(32.dp).alpha(if (found) 1f else 0.45f),
            )
        } else {
            val tint = if (found) Color(0xFFFFE7A3) else Color(0xFF6A6560)
            SymbolMark(name = name, color = tint, modifier = Modifier.size(26.dp))
        }
    }
}

@Composable
fun SymbolMark(name: String, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val stroke = Stroke(width = w * 0.09f)
        when (name) {
            "Heart" -> {
                val path =
                    Path().apply {
                        moveTo(w * 0.5f, h * 0.88f)
                        cubicTo(w * -0.05f, h * 0.45f, w * 0.18f, h * 0.05f, w * 0.5f, h * 0.32f)
                        cubicTo(w * 0.82f, h * 0.05f, w * 1.05f, h * 0.45f, w * 0.5f, h * 0.88f)
                        close()
                    }
                drawPath(path, color)
            }
            "Lock" -> {
                drawRoundRect(
                    color,
                    topLeft = Offset(w * 0.18f, h * 0.42f),
                    size = Size(w * 0.64f, h * 0.48f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(w * 0.08f),
                )
                drawArc(
                    color,
                    startAngle = 200f,
                    sweepAngle = 140f,
                    useCenter = false,
                    topLeft = Offset(w * 0.28f, h * 0.08f),
                    size = Size(w * 0.44f, h * 0.48f),
                    style = stroke,
                )
            }
            "Gem" -> {
                val path =
                    Path().apply {
                        moveTo(w * 0.5f, h * 0.08f)
                        lineTo(w * 0.88f, h * 0.38f)
                        lineTo(w * 0.5f, h * 0.92f)
                        lineTo(w * 0.12f, h * 0.38f)
                        close()
                    }
                drawPath(path, color)
            }
            "Star" -> {
                val path = starPath(w, h)
                drawPath(path, color)
            }
            "Diamond" -> {
                val path =
                    Path().apply {
                        moveTo(w * 0.5f, h * 0.06f)
                        lineTo(w * 0.92f, h * 0.5f)
                        lineTo(w * 0.5f, h * 0.94f)
                        lineTo(w * 0.08f, h * 0.5f)
                        close()
                    }
                drawPath(path, color, style = stroke)
            }
            else -> {
                drawCircle(color, radius = w * 0.18f, center = Offset(w * 0.28f, h * 0.42f))
                drawCircle(color, radius = w * 0.18f, center = Offset(w * 0.72f, h * 0.42f))
                drawLine(color, Offset(w * 0.46f, h * 0.42f), Offset(w * 0.54f, h * 0.42f), strokeWidth = w * 0.08f)
                drawLine(color, Offset(w * 0.5f, h * 0.42f), Offset(w * 0.5f, h * 0.86f), strokeWidth = w * 0.08f)
            }
        }
    }
}

private fun starPath(w: Float, h: Float): Path {
    val cx = w * 0.5f
    val cy = h * 0.52f
    val outer = w * 0.46f
    val inner = w * 0.2f
    return Path().apply {
        for (i in 0 until 10) {
            val radius = if (i % 2 == 0) outer else inner
            val angle = Math.toRadians((-90.0 + i * 36.0))
            val x = cx + (radius * kotlin.math.cos(angle)).toFloat()
            val y = cy + (radius * kotlin.math.sin(angle)).toFloat()
            if (i == 0) moveTo(x, y) else lineTo(x, y)
        }
        close()
    }
}

@Composable
fun BodySymbol(name: String, modifier: Modifier = Modifier) {
    Box(
        modifier =
            modifier
                .size(56.dp)
                .offset(x = (-28).dp, y = (-28).dp)
                .clip(CircleShape)
                .background(Color(0xE6141210))
                .border(1.dp, Color(0xBFFFDC8C), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        SymbolMark(name = name, color = Color(0xFFFFE7A3), modifier = Modifier.size(32.dp))
    }
}
