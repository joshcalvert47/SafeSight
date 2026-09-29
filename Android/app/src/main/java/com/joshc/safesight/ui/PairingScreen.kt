package com.joshc.safesight.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import com.joshc.safesight.net.FirebaseIdentity
import com.joshc.safesight.net.ParentApi
import kotlinx.coroutines.launch

/**
 * First screen picks the role: a child device redeems the 6-char code from
 * the parent console, a parent signs in with Google and gets the family
 * dashboard. Redeeming binds the install to a child profile and pulls their
 * policy before the main screen takes over.
 */
@Composable
fun PairingScreen(
    viewModel: SafeSightViewModel,
    onDone: () -> Unit,
) {
    val state by viewModel.pairState.collectAsState()
    val parentNotice by viewModel.parentNotice.collectAsState()
    val context = LocalContext.current
    var codeEntered by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var parentBusy by remember { mutableStateOf(false) }
    var parentFailure by remember { mutableStateOf<String?>(null) }
    val googleAvailable = remember { FirebaseIdentity.isGoogleSigninAvailable(context) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("SafeSight", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(8.dp))

        when (val s = state) {
            is SafeSightViewModel.PairState.Ready -> {
                LaunchedEffect(Unit) { onDone() }
                Working("Finishing setup…")
            }

            is SafeSightViewModel.PairState.Loading -> Working("Pairing this device…")

            is SafeSightViewModel.PairState.Linked -> {
                Text(
                    s.childName?.let { "Paired with $it." } ?: "Device paired.",
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(12.dp))
                Working("Fetching the family policy…")
            }

            is SafeSightViewModel.PairState.Error -> {
                Text(
                    s.message,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
                if (s.canFinish) {
                    Button(onClick = { viewModel.retryPolicy() }) { Text("Retry sync") }
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = { viewModel.finishPairing() }) {
                        Text("Continue anyway")
                    }
                } else {
                    Button(onClick = { viewModel.resetPairState() }) { Text("Back") }
                }
            }

            is SafeSightViewModel.PairState.Idle -> {
                if (!codeEntered) {
                    Text(
                        "Pair this device with your family, or manage it as a parent.",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                    (parentNotice ?: note)?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )
                    }
                    Spacer(Modifier.height(24.dp))

                    Text(
                        "This is my child's device",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !parentBusy,
                        onClick = {
                            scope.launch {
                                if (FirebaseIdentity.signInAnonymously() == null) {
                                    note = "Device sign-in is unavailable — pairing will fail " +
                                        "until Firebase is configured."
                                } else {
                                    note = null
                                }
                                codeEntered = true
                            }
                        },
                    ) { Text("Continue") }

                    Spacer(Modifier.height(24.dp))
                    Text("I'm a parent", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !parentBusy,
                        onClick = {
                            scope.launch {
                                parentBusy = true
                                parentFailure = signInAsParent(viewModel, context)
                                parentBusy = false
                            }
                        },
                    ) { Text("Sign in with Google") }

                    if (parentBusy) {
                        Spacer(Modifier.height(16.dp))
                        Working("Signing you in…")
                    }

                    if (!googleAvailable || parentFailure != null) {
                        Spacer(Modifier.height(16.dp))
                        Text(
                            parentFailure ?: "Google sign-in isn't available on this device.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { openWeb(context) }) {
                            Text("Open safesight.funbyte.net")
                        }
                    }
                } else {
                    Text(
                        "Enter the 6-character code shown in the parent console.",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                    note?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Center,
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    OutlinedTextField(
                        value = code,
                        onValueChange = { input ->
                            code = input.filter { it.isLetterOrDigit() }.uppercase().take(6)
                        },
                        label = { Text("Pairing code") },
                        placeholder = { Text("ABC123", fontFamily = FontFamily.Monospace) },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            fontFamily = FontFamily.Monospace,
                            letterSpacing = 6.sp,
                            textAlign = TextAlign.Center,
                        ),
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Ascii,
                            capitalization = KeyboardCapitalization.Characters,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(24.dp))
                    Button(
                        enabled = code.length == 6,
                        onClick = { viewModel.pairWithCode(code) },
                    ) { Text("Pair") }
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = { codeEntered = false }) { Text("Back") }
                }
            }
        }
    }
}

/**
 * Google picker → Firebase credential → ParentApi.googleSignIn(), which
 * bootstraps users/{uid} + families/{id} on first sign-in. Returns the
 * failure message, or null on success.
 */
private suspend fun signInAsParent(
    viewModel: SafeSightViewModel,
    context: Context,
): String? {
    val activity = context as? Activity
        ?: return "Google sign-in is unavailable on this device."
    if (FirebaseIdentity.signInWithGoogle(activity) == null) {
        return "Google sign-in isn't available in this build — finish setup on the web."
    }
    return when (val result = ParentApi.googleSignIn()) {
        is ParentApi.AuthResult.Success -> {
            viewModel.enterParentMode()
            null
        }

        is ParentApi.AuthResult.Failure -> when (result.error) {
            "no_family" ->
                "This account has no family yet — finish setup on the web."
            "not_signed_in" -> "Sign-in is unavailable — check that Firebase is set up."
            "unauthorized" -> "Firebase rejected sign-in — check that Firestore rules are deployed."
            else -> "Sign-in failed (${result.error})."
        }

        is ParentApi.AuthResult.Network ->
            "Could not reach Firebase — check your connection and try again."
    }
}

private fun openWeb(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, "https://safesight.funbyte.net".toUri()),
        )
    }
}

@Composable
private fun Working(message: String) {
    CircularProgressIndicator()
    Spacer(Modifier.height(16.dp))
    Text(message, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
}
