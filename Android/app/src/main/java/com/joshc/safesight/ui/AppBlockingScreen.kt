package com.joshc.safesight.ui

import android.content.ComponentName
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.joshc.safesight.block.BlockAccessibilityService

/**
 * Its own section (bottom-bar tab): the accessibility shield's status, the
 * system settings shortcut, and the block/unblock app picker. Adding is free,
 * removing an app is PIN-guarded through guardDestructive().
 */
@Composable
fun AppBlockingScreen(viewModel: SafeSightViewModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val blockedApps by viewModel.blockedApps.collectAsState(initial = emptyList())
    val removedApps by viewModel.blockedAppsRemoved.collectAsState(initial = emptyList())
    val appBlocklist = viewModel.appBlocklist
    val launcherApps = launcherAppList(context)
    val recommendedApps = remember(blockedApps, removedApps) {
        appBlocklist.recommended(blocked = blockedApps, removed = removedApps)
    }
    var shieldOn by remember { mutableStateOf(isShieldEnabled(context)) }
    var appPickerOpen by remember { mutableStateOf(false) }
    var pendingGuard by remember { mutableStateOf<PendingGuard?>(null) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                shieldOn = isShieldEnabled(context)
                // Picking up newly installed blocklist_apps.json defaults.
                viewModel.launch { appBlocklist.syncDefaults() }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

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
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text(
            "App blocking",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        Text(
            if (shieldOn) "Shield active — blocked apps show the SafeSight cover."
            else "Shield not enabled yet. Turn on SafeSight under system " +
                "Accessibility settings, then blocked apps are covered instantly.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = {
                context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }) { Text("Accessibility settings") }
            Spacer(Modifier.padding(horizontal = 6.dp))
            Button(onClick = { appPickerOpen = true }) { Text("Add app…") }
        }

        if (blockedApps.isEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text("No apps blocked yet.", style = MaterialTheme.typography.bodySmall)
        }
        blockedApps.forEach { pkg ->
            AppRow(
                label = appLabel(context, pkg),
                tag = if (appBlocklist.isDefaultPackage(pkg)) "Default" else null,
                actionLabel = "Remove",
                onAction = {
                    pendingGuard = PendingGuard("remove \"$pkg\" from app blocking") {
                        it.removeBlockedApp(pkg)
                    }
                },
            )
        }

        recommendedApps.forEach { entry ->
            AppRow(
                label = entry.name,
                tag = "Recommended",
                actionLabel = "Add",
                onAction = { viewModel.launch { addBlockedApp(entry.androidPackage) } },
            )
        }
        if (recommendedApps.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Recommended apps from blocklist_apps.json that are installed " +
                    "on this device but not blocked yet.",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        HorizontalDivider(Modifier.padding(vertical = 16.dp))
        Text(
            "Blocked apps come from blocklist_apps.json and the list above. " +
                "SafeSight never reads screen " +
                "contents — the shield appears purely from which app is in the " +
                "foreground.",
            style = MaterialTheme.typography.bodySmall,
        )

        if (appPickerOpen) {
            AlertDialog(
                onDismissRequest = { appPickerOpen = false },
                title = { Text("Block an app") },
                text = {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        launcherApps
                            .filter { (pkg, _) -> pkg !in blockedApps }
                            .forEach { (pkg, label) ->
                                Text(
                                    label,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            viewModel.launch { addBlockedApp(pkg) }
                                            appPickerOpen = false
                                        }
                                        .padding(vertical = 10.dp),
                                )
                            }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { appPickerOpen = false }) { Text("Done") }
                },
            )
        }
    }
}

@Composable
private fun AppRow(
    label: String,
    actionLabel: String,
    onAction: () -> Unit,
    tag: String? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        if (tag != null) {
            Text(
                tag,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .padding(end = 8.dp)
                    .background(
                        MaterialTheme.colorScheme.primaryContainer,
                        MaterialTheme.shapes.small,
                    )
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        TextButton(onClick = onAction) { Text(actionLabel) }
    }
}

private fun isShieldEnabled(context: android.content.Context): Boolean {
    val flat = ComponentName(
        context, BlockAccessibilityService::class.java,
    ).flattenToString()
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    return enabled.split(':').any { it.equals(flat, ignoreCase = true) }
}

private fun appLabel(context: android.content.Context, pkg: String): String = runCatching {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
}.getOrDefault(pkg)

@Composable
private fun launcherAppList(context: android.content.Context): List<Pair<String, String>> =
    remember(context) {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        context.packageManager.queryIntentActivities(intent, 0)
            .map {
                it.activityInfo.applicationInfo.packageName to
                    it.loadLabel(context.packageManager).toString()
            }
            .distinct()
            .filter { (pkg, _) -> !BlockAccessibilityService.isExempt(pkg) }
            .sortedBy { it.second.lowercase() }
    }
