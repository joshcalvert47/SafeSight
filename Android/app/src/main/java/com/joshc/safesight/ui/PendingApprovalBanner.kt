package com.joshc.safesight.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Shown while the account is registered but not yet approved by the admin.
 * The server refuses every /api/verify in that state, so the app mirrors it by
 * locking anything that could weaken protection (see SettingsScreen).
 */
@Composable
fun PendingApprovalBanner(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0x1AFD7A00))
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            "⏳ Waiting for admin approval",
            color = Color(0xFFFDBA74),
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
        )
        Text(
            "This device stays locked — no setting can weaken SafeSight — " +
                "until the admin approves the account in the console.",
            color = Color(0xFFFDBA74),
            fontSize = 12.sp,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
