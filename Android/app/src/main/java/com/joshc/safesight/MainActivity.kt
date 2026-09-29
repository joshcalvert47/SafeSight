package com.joshc.safesight

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.joshc.safesight.ui.MainScreen
import com.joshc.safesight.ui.OnboardingScreen
import com.joshc.safesight.ui.PairingScreen
import com.joshc.safesight.ui.ParentGate
import com.joshc.safesight.ui.SafeSightViewModel
import com.joshc.safesight.ui.theme.SafeSightTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SafeSightTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SafeSightRoot()
                }
            }
        }
    }
}

@Composable
private fun SafeSightRoot(viewModel: SafeSightViewModel = viewModel()) {
    val parentMode by viewModel.parentMode.collectAsState()
    val paired by viewModel.pairedChildId.collectAsState(initial = null)
    val registerState by viewModel.registerState.collectAsState()
    val inCreatedState = registerState is SafeSightViewModel.RegisterState.Created

    // Parent mode and child pairing are independent; a saved parent session
    // takes precedence on launch and is verified against GET /api/me.
    when (parentMode) {
        null -> Unit
        true -> ParentGate(viewModel)
        false -> when (paired) {
            null -> Unit
            "" -> PairingScreen(viewModel, onDone = {})
            else -> when {
                // Keep the one-time PIN screen up even though registration already saved.
                inCreatedState -> OnboardingScreen(viewModel, onDone = {})
                else -> MainScreen(viewModel)
            }
        }
    }
}
