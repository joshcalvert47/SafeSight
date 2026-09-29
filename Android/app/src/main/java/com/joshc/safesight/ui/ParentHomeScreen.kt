package com.joshc.safesight.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.joshc.safesight.net.ParentApi
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Launch gate: restores the saved parent session before the dashboard. */
@Composable
fun ParentGate(viewModel: SafeSightViewModel) {
    val state by viewModel.parentState.collectAsState()

    LaunchedEffect(Unit) { viewModel.verifyParent() }

    when (val s = state) {
        is SafeSightViewModel.ParentState.Ready -> ParentHomeScreen(viewModel, s.me)

        SafeSightViewModel.ParentState.Loading -> Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            CircularProgressIndicator()
            Spacer(Modifier.height(16.dp))
            Text("Loading your family…", style = MaterialTheme.typography.bodyLarge)
        }

        is SafeSightViewModel.ParentState.Error -> Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                s.message,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))
            Button(onClick = { viewModel.refreshParent() }) { Text("Retry") }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = { viewModel.signOutParent() }) { Text("Sign out") }
        }

        SafeSightViewModel.ParentState.Unauthorized -> Unit
    }
}

@Composable
fun ParentHomeScreen(viewModel: SafeSightViewModel, me: ParentApi.Me) {
    val busy by viewModel.parentBusy.collectAsState()
    val error by viewModel.parentError.collectAsState()
    val pairCode by viewModel.pairCode.collectAsState()
    // Live listener output overrides the one-shot me() snapshot as soon as
    // it speaks (key present = listener active for that child).
    val liveUnlocks by viewModel.pendingUnlocks.collectAsState()
    val unlocksLive by viewModel.unlockListenerActive.collectAsState()
    var showAddChild by remember { mutableStateOf(false) }
    var childToDelete by remember { mutableStateOf<ParentApi.Child?>(null) }
    var childToEdit by remember { mutableStateOf<ParentApi.Child?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    me.userName.ifEmpty { "Parent" },
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    me.userEmail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (busy) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            IconButton(onClick = { viewModel.refreshParent() }) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh")
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { viewModel.signOutParent() }) { Text("Sign out") }

        error?.let {
            Spacer(Modifier.height(12.dp))
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Spacer(Modifier.height(24.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Children",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { showAddChild = true }) {
                Icon(Icons.Default.Add, contentDescription = null, Modifier.size(18.dp))
                Spacer(Modifier.size(4.dp))
                Text("Add child")
            }
        }
        Spacer(Modifier.height(12.dp))

        if (me.children.isEmpty()) {
            EmptyChildren()
        } else {
            me.children.forEach { child ->
                ChildCard(
                    viewModel = viewModel,
                    child = child,
                    devices = me.devices.filter { it.childId == child.id },
                    requests = if (unlocksLive) {
                        liveUnlocks[child.id] ?: emptyList()
                    } else {
                        me.unlockRequests.filter { it.childId == child.id }
                    },
                    onEditPolicy = { childToEdit = child },
                    onDelete = { childToDelete = child },
                )
                Spacer(Modifier.height(12.dp))
            }
        }
        Spacer(Modifier.height(24.dp))
    }

    if (showAddChild) {
        AddChildDialog(
            onDismiss = { showAddChild = false },
            onConfirm = { name, ageBand ->
                showAddChild = false
                viewModel.addChild(name, ageBand)
            },
        )
    }

    childToDelete?.let { child ->
        AlertDialog(
            onDismissRequest = { childToDelete = null },
            title = { Text("Delete ${child.name}?") },
            text = {
                Text("Their profile and paired devices are removed. Pairing codes for " +
                    "this child stop working.")
            },
            confirmButton = {
                Button(onClick = {
                    childToDelete = null
                    viewModel.deleteChild(child.id)
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { childToDelete = null }) { Text("Cancel") }
            },
        )
    }

    childToEdit?.let { child ->
        val entries = remember { viewModel.appBlocklist.entries() }
        PolicyEditorDialog(
            child = child,
            entries = entries,
            onDismiss = { childToEdit = null },
            onSave = { policy ->
                childToEdit = null
                viewModel.saveChildPolicy(child.id, policy)
            },
        )
    }

    pairCode?.let { code ->
        PairCodeDialog(code = code, onClose = { viewModel.clearPairCode() })
    }
}

@Composable
private fun ChildCard(
    viewModel: SafeSightViewModel,
    child: ParentApi.Child,
    devices: List<ParentApi.DeviceRef>,
    requests: List<ParentApi.UnlockRequest>,
    onEditPolicy: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    child.name,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDelete) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Delete ${child.name}",
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (child.ageBand.isNotEmpty()) Pill("ages ${child.ageBand}")
                Pill("${devices.size} device${if (devices.size == 1) "" else "s"}")
                if (requests.isNotEmpty()) {
                    Pill(
                        "${requests.size} unlock request${if (requests.size == 1) "" else "s"}",
                        alert = true,
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { viewModel.requestPairCode(child.id) }) {
                    Text("Pair device")
                }
                OutlinedButton(onClick = onEditPolicy) { Text("Edit policy") }
            }

            if (devices.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "No paired devices — tap Pair device and enter the code in " +
                        "the child's app.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Spacer(Modifier.height(4.dp))
                devices.forEach { device ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                device.device.ifEmpty { "Device" },
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                "last seen ${formatTime(device.lastSeen)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = { viewModel.deleteDevice(device.uid) }) {
                            Text("Unpair")
                        }
                    }
                }
            }

            requests.forEach { request ->
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            request.action,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            listOfNotNull(
                                request.detail.ifEmpty { null },
                                request.device.ifEmpty { null },
                                formatTime(request.at),
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = { viewModel.decideUnlock(request.id, "deny") }) {
                        Text("Deny")
                    }
                    Button(onClick = { viewModel.decideUnlock(request.id, "approve") }) {
                        Text("Approve")
                    }
                }
            }
        }
    }
}

@Composable
private fun Pill(text: String, alert: Boolean = false) {
    Surface(
        shape = RoundedCornerShape(50),
        color = if (alert) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.secondaryContainer
        },
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = if (alert) {
                MaterialTheme.colorScheme.onErrorContainer
            } else {
                MaterialTheme.colorScheme.onSecondaryContainer
            },
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun EmptyChildren() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("No children yet", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Add a child, then pair their device with a code.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * The parent's control panel for one child: everything the child's devices
 * enforce (web filter options, screen time, schedule, app blocks). One flat
 * map out — every DevicePolicy key — so the child decodes it verbatim.
 */
@Composable
private fun PolicyEditorDialog(
    child: ParentApi.Child,
    entries: List<com.joshc.safesight.block.AppBlocklistEntry>,
    onDismiss: () -> Unit,
    onSave: (Map<String, Any?>) -> Unit,
) {
    val p = child.policy
    var blockedSites by remember(child.id) {
        mutableStateOf(policyList(p["blockedSites"]))
    }
    var newSite by remember(child.id) { mutableStateOf("") }
    var sensitivity by remember(child.id) {
        mutableStateOf(policyInt(p["sensitivity"], 50).coerceIn(0, 100))
    }
    var skinFilter by remember(child.id) { mutableStateOf(policyBool(p["skinFilter"], true)) }
    var blurAll by remember(child.id) { mutableStateOf(policyBool(p["blurAll"], false)) }
    var screenTime by remember(child.id) {
        mutableStateOf(policyInt(p["screenTimeMinutes"], 0).coerceAtLeast(0).toString())
    }
    var scheduleStart by remember(child.id) { mutableStateOf(policySchedule(p["schedule"], "start")) }
    var scheduleEnd by remember(child.id) { mutableStateOf(policySchedule(p["schedule"], "end")) }
    var blockedApps by remember(child.id) {
        mutableStateOf(policyList(p["blockedApps"]).toSet())
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Policy for ${child.name}") },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 440.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Blocked sites", style = MaterialTheme.typography.titleSmall)
                blockedSites.forEach { site ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(site, modifier = Modifier.weight(1f))
                        IconButton(onClick = { blockedSites = blockedSites - site }) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "Remove $site",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = newSite,
                        onValueChange = { newSite = it },
                        singleLine = true,
                        placeholder = { Text("example.com") },
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.size(8.dp))
                    Button(
                        enabled = newSite.isNotBlank(),
                        onClick = {
                            val site = newSite.trim().lowercase().removePrefix("https://")
                                .removePrefix("http://").removePrefix("www.")
                            if (site.isNotEmpty()) blockedSites = blockedSites + site
                            newSite = ""
                        },
                    ) { Text("Add") }
                }

                Text(
                    "Sensitivity: $sensitivity/100",
                    style = MaterialTheme.typography.titleSmall,
                )
                Slider(
                    value = sensitivity.toFloat(),
                    onValueChange = { sensitivity = it.toInt() },
                    valueRange = 0f..100f,
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Skin filter", Modifier.weight(1f))
                    Switch(checked = skinFilter, onCheckedChange = { skinFilter = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Blur all", Modifier.weight(1f))
                    Switch(checked = blurAll, onCheckedChange = { blurAll = it })
                }

                Text("Daily screen time", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(
                    value = screenTime,
                    onValueChange = { screenTime = it.filter(Char::isDigit).take(4) },
                    label = { Text("Minutes per day (0 = unlimited)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )

                Text("Schedule (24h, blank = off)", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = scheduleStart,
                        onValueChange = { scheduleStart = it.take(5) },
                        label = { Text("Start (HH:MM)") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedTextField(
                        value = scheduleEnd,
                        onValueChange = { scheduleEnd = it.take(5) },
                        label = { Text("End (HH:MM)") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }

                Text("Blocked apps", style = MaterialTheme.typography.titleSmall)
                entries.forEach { entry ->
                    val checked = entry.androidPackage in blockedApps
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Checkbox(
                            checked = checked,
                            onCheckedChange = { want ->
                                blockedApps = if (want) {
                                    blockedApps + entry.androidPackage
                                } else {
                                    blockedApps - entry.androidPackage
                                }
                            },
                        )
                        Text(
                            entry.name,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (entry.isDefault) {
                            Pill("default")
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val start = scheduleStart.trim()
                val end = scheduleEnd.trim()
                onSave(
                    mapOf(
                        "blockedSites" to blockedSites.distinct(),
                        "allowedSites" to policyList(p["allowedSites"]),
                        "sensitivity" to sensitivity,
                        "skinFilter" to skinFilter,
                        "blurAll" to blurAll,
                        "screenTimeMinutes" to (screenTime.toIntOrNull() ?: 0),
                        "schedule" to if (start.isNotEmpty() && end.isNotEmpty()) {
                            mapOf("start" to start, "end" to end)
                        } else {
                            null
                        },
                        "blockedApps" to blockedApps.sorted(),
                    ),
                )
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

private fun policyList(value: Any?): List<String> =
    (value as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

private fun policyInt(value: Any?, default: Int): Int =
    (value as? Number)?.toInt() ?: default

private fun policyBool(value: Any?, default: Boolean): Boolean =
    value as? Boolean ?: default

private fun policySchedule(value: Any?, key: String): String =
    ((value as? Map<*, *>)?.get(key) as? String) ?: ""

@Composable
private fun AddChildDialog(onDismiss: () -> Unit, onConfirm: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var ageBand by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add child") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = ageBand,
                    onValueChange = { ageBand = it },
                    label = { Text("Age band (e.g. 8-12)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                enabled = name.isNotBlank(),
                onClick = { onConfirm(name.trim(), ageBand.trim()) },
            ) { Text("Add") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun PairCodeDialog(code: ParentApi.PairCode, onClose: () -> Unit) {
    val context = LocalContext.current
    var remaining by remember(code) {
        mutableLongStateOf(code.expiresAt - System.currentTimeMillis())
    }

    LaunchedEffect(code) {
        while (remaining > 0) {
            delay(1_000)
            remaining = code.expiresAt - System.currentTimeMillis()
        }
    }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Pair a device for ${code.childName}") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "Enter this code in the SafeSight app on the child's device.",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    code.code,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 40.sp,
                    letterSpacing = 8.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    if (remaining > 0) {
                        "Expires in ${formatCountdown(remaining)}"
                    } else {
                        "This code has expired — create a new one."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        },
        confirmButton = {},
        dismissButton = {
            Row {
                TextButton(onClick = {
                    val text = "SafeSight pairing code for ${code.childName}: ${code.code}"
                    runCatching {
                        val intent = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, text)
                        }
                        context.startActivity(
                            Intent.createChooser(intent, "Share pairing code"),
                        )
                    }
                }) {
                    Icon(Icons.Default.Share, contentDescription = null, Modifier.size(18.dp))
                    Spacer(Modifier.size(4.dp))
                    Text("Share")
                }
                Button(onClick = onClose) { Text("Done") }
            }
        },
    )
}

private fun formatCountdown(millis: Long): String {
    val total = (millis / 1000).coerceAtLeast(0)
    return "%d:%02d".format(total / 60, total % 60)
}

private fun formatTime(at: Long): String {
    if (at <= 0) return "unknown"
    return SimpleDateFormat("MMM d, HH:mm", Locale.getDefault()).format(Date(at))
}
