package com.sugarscratchie.smoke

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.sugarscratchie.smoke.ui.LoginScreen
import com.sugarscratchie.smoke.ui.SessionScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = lightColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SmokeApp()
                }
            }
        }
    }
}

@Composable
private fun SmokeApp(vm: SmokeViewModel = viewModel()) {
    val state by vm.state.collectAsState()

    LaunchedEffect(Unit) {
        vm.bootstrap()
    }

    when (val screen = state.screen) {
        SmokeScreen.Boot -> {
            // brief blank while restoring cookie session
        }
        SmokeScreen.Login -> {
            LoginScreen(
                email = state.email,
                password = state.password,
                registerMode = state.registerMode,
                loading = state.loading,
                error = state.error,
                onEmailChange = vm::onEmailChange,
                onPasswordChange = vm::onPasswordChange,
                onToggleMode = vm::toggleRegisterMode,
                onSubmit = vm::submitAuth,
            )
        }
        is SmokeScreen.Session -> {
            SessionScreen(
                user = screen.user,
                wallet = state.wallet,
                card = state.card,
                backgroundUrl = state.backgroundUrl,
                foregroundUrl = state.foregroundUrl,
                handId = state.handId,
                lastClaimMessage = state.lastClaimMessage,
                loading = state.loading,
                error = state.error,
                onStartHand = vm::startHand,
                onClaimMilestone = vm::claimMilestone,
                onLogout = vm::logout,
            )
        }
    }
}
