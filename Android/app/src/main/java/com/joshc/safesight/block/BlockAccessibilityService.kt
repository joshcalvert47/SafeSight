package com.joshc.safesight.block

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.toColorInt
import com.joshc.safesight.R
import com.joshc.safesight.data.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground-app shield: watches TYPE_WINDOW_STATE_CHANGED and raises a
 * full-screen overlay (TYPE_ACCESSIBILITY_OVERLAY) whenever the foreground
 * package is in the user's blocked-apps list — the Android counterpart of
 * safari's AppBlockingManager.
 */
class BlockAccessibilityService : AccessibilityService() {

    private lateinit var windowManager: WindowManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var shield: View? = null

    @Volatile
    private var blockedApps: Set<String> = emptySet()

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val store = SettingsStore(this)
        scope.launch {
            // The shield is the enforcement point, so it also pulls in any
            // blocklist_apps.json defaults the app hasn't synced yet.
            AppBlocklistRepository(this@BlockAccessibilityService, store).syncDefaults()
            store.blockedApps.collect { blockedApps = it.toSet() }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        when {
            // Transient system windows (shade, recents) must not dismiss the
            // shield — otherwise the blocked app peeks through.
            pkg == SYSTEM_UI -> return

            // Our own windows: raising the overlay dispatches an event for
            // our package; toggling on it would loop show/hide forever.
            // Only MainActivity coming to the foreground dismisses it.
            pkg == packageName -> {
                if (event.className?.toString()?.endsWith("MainActivity") == true) {
                    hideShield()
                }
                return
            }

            pkg in blockedApps -> if (shield == null) showShield(pkg)

            else -> if (shield != null) hideShield()
        }
    }

    override fun onInterrupt() = hideShield()

    override fun onDestroy() {
        hideShield()
        scope.cancel()
        super.onDestroy()
    }

    private fun showShield(pkg: String) {
        val label = runCatching {
            packageManager.getApplicationLabel(
                packageManager.getApplicationInfo(pkg, 0),
            ).toString()
        }.getOrDefault(pkg)

        val view = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            // Fully opaque — the blocked app must not show through at all.
            setBackgroundColor("#FF0F172A".toColorInt())
            setPadding(64, 64, 64, 64)
            addView(
                TextView(this@BlockAccessibilityService).apply {
                    text = getString(R.string.shield_message, label)
                    setTextColor(Color.WHITE)
                    textSize = 22f
                    gravity = Gravity.CENTER
                },
            )
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            // Non-focusable: never steal focus from the foreground app, so it
            // doesn't re-dispatch window events and churn the shield.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.OPAQUE,
        ).apply { gravity = Gravity.CENTER }

        // Only record the shield once it's really attached, so a failed
        // addView can't leave us thinking it's showing.
        runCatching { windowManager.addView(view, params) }
            .onSuccess { shield = view }
    }

    private fun hideShield() {
        shield?.let { runCatching { windowManager.removeView(it) } }
        shield = null
    }

    companion object {
        private const val SYSTEM_UI = "com.android.systemui"

        /** Never shield ourselves, the system UI, the launcher, Settings or Android. */
        private val EXEMPT = setOf(
            "android",
            "com.android.systemui",
            "com.android.settings",
            "com.joshc.safesight",
        )

        fun isExempt(pkg: String): Boolean =
            pkg in EXEMPT || pkg.startsWith("com.android.launcher") ||
                pkg.startsWith("com.google.android.apps.nexuslauncher")
    }
}
