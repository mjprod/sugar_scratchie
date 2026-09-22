package com.sugarscratchie.smoke.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.view.TextureView
import com.airbnb.lottie.LottieComposition
import com.sugarscratchie.smoke.data.CardInfo
import com.sugarscratchie.smoke.data.GarmentMesh
import com.sugarscratchie.smoke.data.UserPublic
import com.sugarscratchie.smoke.data.WalletResponse
import com.sugarscratchie.smoke.data.devMediaClient
import kotlinx.coroutines.delay

private enum class RoundPhase {
    Intro,
    Center,
    Play,
    Done,
}

@Composable
fun SessionScreen(
    user: UserPublic,
    wallet: WalletResponse?,
    card: CardInfo?,
    backgroundUrl: String?,
    foregroundUrl: String?,
    introUrl: String?,
    nextForegroundUrl: String?,
    mesh: GarmentMesh?,
    chromaKey: Boolean,
    symbolCompositions: List<LottieComposition>,
    handIndex: Int,
    handSize: Int,
    handComplete: Boolean,
    handId: String?,
    lastClaimMessage: String?,
    loading: Boolean,
    error: String?,
    onStartHand: () -> Unit,
    onClaimMilestone: () -> Unit,
    onNextCard: () -> Unit,
    onPrepareNext: () -> Unit,
    onLogout: () -> Unit,
) {
    var playbackError by remember(backgroundUrl, foregroundUrl) { mutableStateOf<String?>(null) }
    var foundMask by remember(card?.id) { mutableIntStateOf(0) }
    var phase by remember(card?.id, handComplete) {
        mutableStateOf(
            when {
                handComplete -> RoundPhase.Done
                card?.trailer.isNullOrBlank() && introUrl.isNullOrBlank() -> RoundPhase.Center
                else -> RoundPhase.Intro
            },
        )
    }
    val barBias by animateFloatAsState(
        targetValue = if (phase == RoundPhase.Play) -1f else 0f,
        animationSpec = tween(durationMillis = 720),
        label = "topBar",
    )
    val sounds = remember { GameSounds() }
    DisposableEffect(sounds) {
        onDispose { sounds.release() }
    }

    LaunchedEffect(card?.id, handId, loading, phase) {
        if (card != null && handId == null && !loading && phase != RoundPhase.Intro && phase != RoundPhase.Done) {
            onStartHand()
        }
    }

    var scratchView by remember { mutableStateOf<LayeredScratchView?>(null) }
    var filming by remember { mutableStateOf(false) }
    var filmFrom by remember { mutableStateOf<Bitmap?>(null) }
    var advanced by remember(card?.id) { mutableStateOf(false) }
    var claimed by remember(handId) { mutableStateOf(false) }

    LaunchedEffect(card?.id, handComplete) {
        filming = false
    }

    LaunchedEffect(phase, card?.id) {
        if (phase == RoundPhase.Play) onPrepareNext()
    }

    fun goNext() {
        if (advanced || handComplete) return
        if (!claimed && handId != null) {
            claimed = true
            onClaimMilestone()
        }
        advanced = true
        val shot = scratchView?.snapshot()
        val next = nextForegroundUrl
        if (shot != null && !next.isNullOrBlank()) {
            filmFrom = shot
            filming = true
        } else {
            shot?.recycle()
            onNextCard()
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (!backgroundUrl.isNullOrBlank() && !foregroundUrl.isNullOrBlank()) {
            DualLayerScratch(
                backgroundUrl = backgroundUrl,
                foregroundUrl = foregroundUrl,
                mesh = mesh,
                chromaKey = chromaKey,
                symbolCompositions = symbolCompositions,
                scratchEnabled = phase == RoundPhase.Play && !filming,
                onView = { scratchView = it },
                onError = { playbackError = it },
                onIconFound = { index ->
                    val bit = 1 shl index
                    if (foundMask and bit == 0) {
                        foundMask = foundMask or bit
                        sounds.playMatchFind()
                    }
                },
                onSymbolsRevealed = { count ->
                    if (phase == RoundPhase.Play && count >= BODY_SYMBOL_COUNT) goNext()
                },
                onScratched = { fraction ->
                    if (phase == RoundPhase.Play && fraction >= SCRATCH_ALL) goNext()
                },
            )
        } else {
            Text(
                "Card needs both background and foreground videos.",
                color = Color(0xFFFF8A80),
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
            )
        }

        if (phase == RoundPhase.Intro && !introUrl.isNullOrBlank()) {
            IntroClip(
                url = introUrl,
                onFinished = { phase = RoundPhase.Center },
            )
        }

        if (phase != RoundPhase.Intro && phase != RoundPhase.Done) {
            Text(
                "${handIndex + 1} / $handSize",
                color = Color(0xCCFFFFFF),
                fontSize = 12.sp,
                modifier =
                    Modifier
                        .align(Alignment.TopStart)
                        .statusBarsPadding()
                        .padding(16.dp),
            )
            GameTopBar(
                foundMask = foundMask,
                diamonds = wallet?.diamonds ?: 0,
                coins = wallet?.coins ?: 0,
                note = if (phase == RoundPhase.Center) "Scratch the bar" else lastClaimMessage,
                symbolCompositions = symbolCompositions,
                scratchable = phase == RoundPhase.Center,
                onBarCleared = { phase = RoundPhase.Play },
                modifier =
                    Modifier
                        .align(BiasAlignment(0f, barBias))
                        .then(
                            if (phase == RoundPhase.Play) {
                                Modifier.statusBarsPadding().padding(top = 8.dp)
                            } else {
                                Modifier
                            },
                        ),
            )
        }
        val problem = playbackError ?: error?.takeUnless { it.contains("scratch hand limit") }
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
        val fromFrame = filmFrom
        val nextFrameUrl = nextForegroundUrl
        if (filming && fromFrame != null && !nextFrameUrl.isNullOrBlank()) {
            AndroidView(
                factory = { context ->
                    FilmStripTransitionView(context).also { view ->
                        view.onFinished = { onNextCard() }
                        view.start(fromFrame, nextFrameUrl)
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun DualLayerScratch(
    backgroundUrl: String,
    foregroundUrl: String,
    mesh: GarmentMesh?,
    chromaKey: Boolean,
    symbolCompositions: List<LottieComposition>,
    scratchEnabled: Boolean,
    onView: (LayeredScratchView) -> Unit,
    onError: (String) -> Unit,
    onIconFound: (Int) -> Unit,
    onSymbolsRevealed: (Int) -> Unit,
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
                view.onIconFound = onIconFound
                view.onSymbolsRevealed = onSymbolsRevealed
                view.onScratched = onScratched
                view.mesh = mesh
                view.chromaKey = chromaKey
                view.setSymbolCompositions(symbolCompositions)
                view.scratchEnabled = scratchEnabled
                view.setSources(backgroundUrl, foregroundUrl)
                onView(view)
            }
        },
        update = { view ->
            onView(view)
            view.onError = onError
            view.onIconFound = onIconFound
            view.onSymbolsRevealed = onSymbolsRevealed
            view.onScratched = onScratched
            view.mesh = mesh
            view.chromaKey = chromaKey
            view.setSymbolCompositions(symbolCompositions)
            view.scratchEnabled = scratchEnabled
            view.setSources(backgroundUrl, foregroundUrl)
        },
        modifier = Modifier.fillMaxSize(),
    )
}

private const val BODY_SYMBOL_COUNT = 12
private const val SCRATCH_ALL = 0.98f

@Composable
private fun IntroClip(url: String, onFinished: () -> Unit) {
    val playerRef = remember(url) { arrayOfNulls<ExoPlayer>(1) }

    DisposableEffect(url) {
        onDispose {
            playerRef[0]?.release()
            playerRef[0] = null
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { context ->
                TextureView(context).also { texture ->
                    val player =
                        ExoPlayer.Builder(context)
                            .setMediaSourceFactory(
                                DefaultMediaSourceFactory(OkHttpDataSource.Factory(devMediaClient())),
                            )
                            .build()
                    playerRef[0] = player
                    player.repeatMode = Player.REPEAT_MODE_OFF
                    player.playWhenReady = true
                    player.setMediaItem(MediaItem.fromUri(url))
                    player.addListener(
                        object : Player.Listener {
                            override fun onPlaybackStateChanged(playbackState: Int) {
                                if (playbackState == Player.STATE_ENDED) onFinished()
                            }

                            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                                onFinished()
                            }
                        },
                    )
                    player.prepare()
                    fun bind() {
                        val surfaceTexture = texture.surfaceTexture ?: return
                        player.setVideoSurface(android.view.Surface(surfaceTexture))
                    }
                    if (texture.isAvailable) {
                        bind()
                    } else {
                        texture.surfaceTextureListener =
                            object : TextureView.SurfaceTextureListener {
                                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                                    bind()
                                }

                                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit

                                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                                    player.clearVideoSurface()
                                    return true
                                }

                                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
                            }
                    }
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        TextButton(
            onClick = onFinished,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp),
        ) {
            Text("Skip", color = Color.White, fontSize = 16.sp)
        }
    }
}
