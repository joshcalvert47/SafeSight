package com.joshc.safesight.ui

import android.net.VpnService
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.joshc.safesight.block.BlocklistRepository
import com.joshc.safesight.net.WorkerClient

internal data class PendingGuard(
    val action: String,
    val apply: suspend (SafeSightViewModel) -> Unit,
)

/**
 * Extension popup parity: toggles that loosen filtering (skin filter off,
 * blur-all off) are PIN-gated through guardDestructive(), sensitivity is free
 * to change, and stats can be reset without a PIN — same as popup.js.
 */
@Composable
fun SettingsScreen(viewModel: SafeSightViewModel) {
    val skinFilter by viewModel.skinFilter.collectAsState(initial = false)
    val blurAll by viewModel.blurAll.collectAsState(initial = false)
    val sensitivity by viewModel.sensitivity.collectAsState(initial = 4)
    val scanned by viewModel.scannedCount.collectAsState(initial = 0)
    val blocked by viewModel.blockedCount.collectAsState(initial = 0)
    val email by viewModel.accountEmail.collectAsState(initial = "")
    val name by viewModel.accountName.collectAsState(initial = "")
    val accountStatus by viewModel.accountStatus.collectAsState(initial = "approved")
    val locked = accountStatus != "approved"
    val lockedMessage =
        "Locked: this account is waiting for admin approval — nothing that " +
            "weakens SafeSight can change until the admin approves it."

    // Paired to a child profile: the parent owns these controls. The only way
    // through is ask → unlockRequests/{id} → 10-minute grace on approval.
    val parentManaged by viewModel.parentManaged.collectAsState()
    val editingAllowed by viewModel.policyEditingAllowed.collectAsState()
    val askState by viewModel.askState.collectAsState()
    val parentLocked = parentManaged && !editingAllowed
    val parentLockedMessage =
        "Managed by your parent — ask for permission to change these settings."

    var pendingGuard by remember { mutableStateOf<PendingGuard?>(null) }
    var sensitivityDraft by remember { mutableStateOf<Int?>(null) }
    var addHint by remember { mutableStateOf<String?>(null) }
    val shownSensitivity = sensitivityDraft ?: sensitivity

    pendingGuard?.let { guard ->
        PinDialog(
            action = guard.action,
            verify = { pin -> viewModel.guardDestructive(guard.action, pin) },
            onDismiss = { pendingGuard = null },
            onGranted = {
                viewModel.launch { guard.apply(viewModel) }
                pendingGuard = null
            },
        )
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        SectionTitle("Filtering")

        ToggleRow(
            title = "Skin filter",
            subtitle = "Overlay skin-tone regions on flagged images",
            checked = skinFilter,
            onCheckedChange = { want ->
                if (parentLocked) {
                    addHint = parentLockedMessage
                } else if (want) {
                    viewModel.launch { setSkinFilter(true) }
                } else if (locked) {
                    addHint = lockedMessage
                } else {
                    pendingGuard = PendingGuard("disable the skin filter") {
                        it.setSkinFilter(false)
                    }
                }
            },
        )

        ToggleRow(
            title = "Blur all",
            subtitle = "Blur every image without running the model",
            checked = blurAll,
            onCheckedChange = { want ->
                if (parentLocked) {
                    addHint = parentLockedMessage
                } else if (want) {
                    viewModel.launch { setBlurAll(true) }
                } else if (locked) {
                    addHint = lockedMessage
                } else {
                    pendingGuard = PendingGuard("disable blur-all") { it.setBlurAll(false) }
                }
            },
        )

        Spacer(Modifier.height(16.dp))
        Text("Sensitivity: ${SafeSightViewModel.sensitivityLabel(shownSensitivity)}")
        when {
            locked -> Text(
                "Locked until the account is approved.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )

            parentLocked -> Text(
                parentLockedMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Slider(
            value = shownSensitivity.toFloat(),
            onValueChange = { sensitivityDraft = it.toInt() },
            onValueChangeFinished = {
                sensitivityDraft?.let { v -> viewModel.launch { setSensitivity(v) } }
                sensitivityDraft = null
            },
            valueRange = 1f..9f,
            steps = 7,
            enabled = !locked && !parentLocked,
        )

        if (parentManaged) {
            Spacer(Modifier.height(8.dp))
            AskParentSection(viewModel, askState, parentLocked, editingAllowed)
        }

        HorizontalDivider(Modifier.padding(vertical = 16.dp))

        SectionTitle("Statistics")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Scanned: $scanned")
            Spacer(Modifier.padding(horizontal = 12.dp))
            Text("Blocked: $blocked")
            Spacer(Modifier.weight(1f))
            Button(onClick = { viewModel.launch { resetStats() } }) { Text("Reset") }
        }

        HorizontalDivider(Modifier.padding(vertical = 16.dp))

        SectionTitle("Account")
        Text(name, style = MaterialTheme.typography.titleMedium)
        Text(email, style = MaterialTheme.typography.bodyMedium)
        Text(
            "Up to ${WorkerClient.MAX_DEVICES} devices share this account's PIN.",
            style = MaterialTheme.typography.bodySmall,
        )

        HorizontalDivider(Modifier.padding(vertical = 16.dp))

        SectionTitle("Blocked sites")
        val blocklistUser by viewModel.store.blocklistUser.collectAsState(initial = emptyList())
        Text(
            "${viewModel.blocklist.defaultCount()} default site(s) enforced from " +
                "blocklist.json — not shown here. Sites you add below are PIN-protected.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(8.dp))
        AddSiteRow(
            onAdd = { raw ->
                viewModel.launch {
                    addHint = when (addBlockSite(raw)) {
                        SafeSightViewModel.AddSiteResult.Added ->
                            "\"${BlocklistRepository.normalizeSite(raw)}\" blocked."

                        SafeSightViewModel.AddSiteResult.AlreadyBlocked ->
                            "That site is already blocked."

                        SafeSightViewModel.AddSiteResult.Invalid ->
                            "Enter a domain like example.com."
                    }
                }
            },
        )
        addHint?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        Spacer(Modifier.height(8.dp))
        if (blocklistUser.isEmpty()) {
            Text("No extra sites added yet.", style = MaterialTheme.typography.bodySmall)
        }
        blocklistUser.forEach { site ->
            SiteRow(
                site = site,
                onRemove = {
                    if (locked) {
                        addHint = lockedMessage
                    } else {
                        pendingGuard = PendingGuard("remove \"$site\" from the block list") {
                            it.removeBlockSite(site)
                        }
                    }
                },
            )
        }

        HorizontalDivider(Modifier.padding(vertical = 16.dp))
        SectionTitle("Device-wide blocking")
        val dnsBlocking by viewModel.dnsBlocking.collectAsState(initial = false)
        val context = LocalContext.current
        val vpnLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) {
            if (VpnService.prepare(context) == null) {
                viewModel.launch { setDnsBlocking(true) }
                viewModel.startVpnService()
            }
        }
        ToggleRow(
            title = "DNS firewall (VPN)",
            subtitle = "Sinkhole blocked domains for every app on this device",
            checked = dnsBlocking,
            onCheckedChange = { want ->
                if (want) {
                    val prep = VpnService.prepare(context)
                    if (prep == null) {
                        viewModel.launch { setDnsBlocking(true) }
                        viewModel.startVpnService()
                    } else {
                        vpnLauncher.launch(prep)
                    }
                } else if (locked) {
                    addHint = lockedMessage
                } else {
                    pendingGuard = PendingGuard("disable device-wide blocking") {
                        it.setDnsBlocking(false)
                        it.stopVpnService()
                    }
                }
            },
        )
        Text(
            "DNS-level only: apps that override system DNS (DoH / Private DNS) " +
                "can bypass it — see android/PLAN.md.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun AskParentSection(
    viewModel: SafeSightViewModel,
    askState: SafeSightViewModel.AskState,
    parentLocked: Boolean,
    editingAllowed: Boolean,
) {
    SectionTitle("Ask your parent")
    when (askState) {
        SafeSightViewModel.AskState.Waiting -> Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(Modifier.height(18.dp))
            Spacer(Modifier.padding(horizontal = 8.dp))
            Text("Waiting for your parent…", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { viewModel.cancelAsk() }) { Text("Cancel") }
        }

        SafeSightViewModel.AskState.Approved -> Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Approved — you can edit these settings for the next 10 minutes.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { viewModel.dismissAsk() }) { Text("Got it") }
        }

        is SafeSightViewModel.AskState.Denied -> Text(
            askState.message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )

        is SafeSightViewModel.AskState.Failed -> Text(
            askState.message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )

        SafeSightViewModel.AskState.Idle -> {
            if (editingAllowed) {
                Text(
                    "Your parent approved editing — changes lock again after 10 minutes.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            } else {
                Text(
                    "Your parent manages the filter settings" +
                        if (parentLocked) "." else " — ask before changing them.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        viewModel.askToChangePolicy(
                            "change web filter options",
                            "Skin filter, blur or sensitivity",
                        )
                    },
                ) { Text("Ask to change filter options") }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun AddSiteRow(onAdd: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            singleLine = true,
            placeholder = { Text("example.com") },
            modifier = Modifier.weight(1f),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = {
                if (draft.isNotBlank()) {
                    onAdd(draft)
                    draft = ""
                }
            }),
        )
        Spacer(Modifier.padding(horizontal = 4.dp))
        Button(
            onClick = {
                if (draft.isNotBlank()) {
                    onAdd(draft)
                    draft = ""
                }
            },
        ) { Text("Add") }
    }
}

@Composable
private fun SiteRow(site: String, onRemove: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(site, modifier = Modifier.weight(1f))
        IconButton(onClick = onRemove) {
            Icon(Icons.Default.Close, contentDescription = "Remove $site")
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
