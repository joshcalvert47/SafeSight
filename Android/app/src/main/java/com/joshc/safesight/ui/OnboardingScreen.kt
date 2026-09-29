package com.joshc.safesight.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.joshc.safesight.net.WorkerClient

/**
 * First-run account registration — same flow as ensureRegistered() in
 * chrome/popup.js: one email covers up to WorkerClient.MAX_DEVICES devices
 * and they all share a single PIN.
 */
@Composable
fun OnboardingScreen(
    viewModel: SafeSightViewModel,
    onDone: () -> Unit,
) {
    val state by viewModel.registerState.collectAsState()

    var accountName by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var invite by remember { mutableStateOf("") }

    when (val s = state) {
        is SafeSightViewModel.RegisterState.Created -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("Account created", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(16.dp))
                Text("Your SafeSight PIN:")
                Spacer(Modifier.height(8.dp))
                Text(
                    s.pin,
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    "Write it down — it's required to turn filters off or remove blocked " +
                        "sites. The same PIN works on your other device.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = {
                    viewModel.resetRegisterState()
                    onDone()
                }) { Text("Continue") }
            }
        }

        is SafeSightViewModel.RegisterState.Joined -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("Device added", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(16.dp))
                Text(
                    "This device joined the account. Use the PIN you set up on your " +
                        "other device for protected changes.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = {
                    viewModel.resetRegisterState()
                    onDone()
                }) { Text("Continue") }
            }
        }

        is SafeSightViewModel.RegisterState.DeviceRequested -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(16.dp))
                Text(
                    "Request sent",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "This device (ticket #${s.ticket}) is waiting for the account " +
                        "admin to approve another slot in the SafeSight console.\n\n" +
                        "SafeSight will connect automatically once it's approved.",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = { viewModel.resetRegisterState() }) {
                    Text("Cancel")
                }
            }
        }

        is SafeSightViewModel.RegisterState.Pending -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(16.dp))
                Text(
                    "Waiting for approval",
                    style = MaterialTheme.typography.headlineSmall,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Your account was created and is waiting for the admin to approve " +
                        "it in the SafeSight console.\n\nSafeSight stays locked — no setting " +
                        "can weaken protection — until it's approved.",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(24.dp))
                Button(onClick = {
                    viewModel.resetRegisterState()
                    onDone()
                }) { Text("Continue (locked)") }
            }
        }

        else -> {
            val loading = s is SafeSightViewModel.RegisterState.Loading
            val err = s as? SafeSightViewModel.RegisterState.Error
            val error = err?.message

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("SafeSight", style = MaterialTheme.typography.headlineLarge)
                Spacer(Modifier.height(8.dp))
                Text(
                    "One account covers up to ${WorkerClient.MAX_DEVICES} devices — " +
                        "they all share the same PIN.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(24.dp))
                OutlinedTextField(
                    value = accountName,
                    onValueChange = { accountName = it },
                    label = { Text("Account name") },
                    singleLine = true,
                    enabled = !loading,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    enabled = !loading,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = invite,
                    onValueChange = { invite = it },
                    label = { Text("Invite code") },
                    supportingText = {
                        Text(
                            "One code creates one account. It stays locked until the " +
                                "admin approves it.",
                        )
                    },
                    singleLine = true,
                    enabled = !loading,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (error != null) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        error,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }
                if (err?.canRequestDevice == true) {
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(
                        enabled = !loading,
                        onClick = { viewModel.requestDevice() },
                    ) { Text("Request another device") }
                }
                Spacer(Modifier.height(24.dp))
                Button(
                    enabled = !loading &&
                        accountName.isNotBlank() && email.isNotBlank() && invite.isNotBlank(),
                    onClick = { viewModel.register(accountName, email, invite) },
                ) {
                    if (loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(20.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text("Create / join account")
                    }
                }
            }
        }
    }
}
