package com.sugarscratchie.smoke.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.sugarscratchie.smoke.data.CardInfo
import com.sugarscratchie.smoke.data.UserPublic
import com.sugarscratchie.smoke.data.WalletResponse

private const val SCRATCH_CLAIM_FRACTION = 0.22f

@Composable
fun SessionScreen(
    user: UserPublic,
    wallet: WalletResponse?,
    card: CardInfo?,
    backgroundUrl: String?,
    foregroundUrl: String?,
    handId: String?,
    lastClaimMessage: String?,
    loading: Boolean,
    error: String?,
    onStartHand: () -> Unit,
    onClaimMilestone: () -> Unit,
    onLogout: () -> Unit,
) {
    var playbackError by remember(backgroundUrl, foregroundUrl) { mutableStateOf<String?>(null) }
    var claimed by remember(handId) { mutableStateOf(false) }

    LaunchedEffect(card?.id, handId, loading) {
        if (card != null && handId == null && !loading) {
            onStartHand()
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (!backgroundUrl.isNullOrBlank() && !foregroundUrl.isNullOrBlank()) {
            DualLayerScratch(
                backgroundUrl = backgroundUrl,
                foregroundUrl = foregroundUrl,
                onError = { playbackError = it },
                onScratched = { fraction ->
                    if (!claimed && handId != null && fraction >= SCRATCH_CLAIM_FRACTION) {
                        claimed = true
                        onClaimMilestone()
                    }
                },
            )
        } else {
            Text(
                "Card needs both background and foreground videos.",
                color = Color(0xFFFF8A80),
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
            )
        }

        val coins = wallet?.coins ?: 0
        val status =
            buildString {
                append(card?.label ?: "Scratch")
                append("  ·  ")
                append(coins)
                append(" coins")
                if (!lastClaimMessage.isNullOrBlank()) {
                    append("  ·  ")
                    append(lastClaimMessage)
                }
            }
        Text(
            status,
            color = Color.White,
            modifier =
                Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(16.dp),
        )
        val problem = playbackError ?: error
        if (!problem.isNullOrBlank()) {
            Text(
                problem,
                color = Color(0xFFFF8A80),
                modifier =
                    Modifier
                        .align(Alignment.BottomStart)
                        .padding(16.dp),
            )
        }
        TextButton(
            onClick = onLogout,
            modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding(),
        ) {
            Text("Log out", color = Color.White)
        }
    }
}

@Composable
private fun DualLayerScratch(
    backgroundUrl: String,
    foregroundUrl: String,
    onError: (String) -> Unit,
    onScratched: (Float) -> Unit,
) {
    val viewRef = remember { arrayOfNulls<LayeredScratchView>(1) }

    DisposableEffect(Unit) {
        onDispose {
            viewRef[0]?.release()
        }
    }

    AndroidView(
        factory = { ctx ->
            LayeredScratchView(ctx).also { view ->
                viewRef[0] = view
                view.onError = onError
                view.onScratched = onScratched
                view.setSources(backgroundUrl, foregroundUrl)
            }
        },
        update = { view ->
            view.onError = onError
            view.onScratched = onScratched
        },
        modifier = Modifier.fillMaxSize(),
    )
}
