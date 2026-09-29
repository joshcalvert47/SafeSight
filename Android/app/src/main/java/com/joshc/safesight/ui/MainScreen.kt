package com.joshc.safesight.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.joshc.safesight.browser.BrowserScreen

private enum class Tab(val label: String, val icon: ImageVector) {
    Browser("Browser", Icons.Filled.Shield),
    Apps("Apps", Icons.Filled.Apps),
    Settings("Settings", Icons.AutoMirrored.Filled.List),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(viewModel: SafeSightViewModel) {
    var tab by remember { mutableStateOf(Tab.Browser) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("SafeSight") }) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { innerPadding ->
        val accountStatus by viewModel.accountStatus.collectAsState(initial = "approved")
        val approvalNotice by viewModel.approvalNotice.collectAsState()

        approvalNotice?.let { message ->
            AlertDialog(
                onDismissRequest = { viewModel.dismissApprovalNotice() },
                title = { Text("Account approved") },
                text = { Text(message) },
                confirmButton = {
                    Button(onClick = { viewModel.dismissApprovalNotice() }) { Text("OK") }
                },
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            if (accountStatus != "approved") {
                PendingApprovalBanner()
            }
            when (tab) {
                Tab.Browser -> BrowserScreen(
                    viewModel = viewModel,
                    modifier = Modifier.fillMaxSize(),
                )
                Tab.Apps -> AppBlockingScreen(
                    viewModel = viewModel,
                    modifier = Modifier.fillMaxSize(),
                )
                Tab.Settings -> SettingsScreen(viewModel)
            }
        }
    }
}
