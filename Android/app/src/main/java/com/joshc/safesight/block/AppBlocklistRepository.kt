package com.joshc.safesight.block

import android.content.Context
import com.joshc.safesight.data.SettingsStore
import kotlinx.coroutines.flow.first

/** One row of assets/blocklist_apps.json. */
data class AppBlocklistEntry(
    val name: String,
    val tier: String,
    val androidPackage: String,
    val iosBundleId: String,
    val iosScheme: String,
) {
    /** "default" rows are auto-blocked; anything else is a recommendation only. */
    val isDefault: Boolean get() = tier == "default"
}

/**
 * App counterpart of BlocklistRepository: defaults ship in
 * assets/blocklist_apps.json, so a shipped list of apps is blocked the moment
 * it is installed — no manual picking required.
 *
 *  - tier "default": merged into the blocked-apps list while the file's
 *    "enabled" flag is true. Removing one is PIN-guarded and remembered in
 *    blockedAppsRemoved, so it is never re-added behind the user's back.
 *  - tier "optional": never blocked here; surfaced as recommendations.
 */
class AppBlocklistRepository(
    context: Context,
    private val store: SettingsStore,
) {
    private val appContext = context.applicationContext

    @Volatile
    private var entriesCache: List<AppBlocklistEntry>? = null

    @Volatile
    private var enabledCache: Boolean? = null

    /** Every row of the shipped file, in file order. */
    fun entries(): List<AppBlocklistEntry> {
        entriesCache?.let { return it }
        val parsed = runCatching {
            appContext.assets.open("blocklist_apps.json").bufferedReader().readText()
                .let { org.json.JSONObject(it) }
                .let { json ->
                    val arr = json.optJSONArray("apps") ?: org.json.JSONArray()
                    (0 until arr.length()).mapNotNull { i ->
                        val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                        val pkg = obj.optString("android").trim()
                        val name = obj.optString("name").trim().ifEmpty { pkg }
                        if (pkg.isEmpty()) return@mapNotNull null
                        AppBlocklistEntry(
                            name = name,
                            tier = obj.optString("tier").trim().ifEmpty { "optional" },
                            androidPackage = pkg,
                            iosBundleId = obj.optString("ios").trim(),
                            iosScheme = obj.optString("scheme").trim(),
                        )
                    }
                }
        }.getOrDefault(emptyList())
        entriesCache = parsed
        return parsed
    }

    /** The file-level "enabled" switch — false stops all automatic blocking. */
    fun isEnabled(): Boolean {
        enabledCache?.let { return it }
        val enabled = runCatching {
            appContext.assets.open("blocklist_apps.json").bufferedReader().readText()
                .let { org.json.JSONObject(it) }
                .optBoolean("enabled", true)
        }.getOrDefault(true)
        enabledCache = enabled
        return enabled
    }

    /** Shipped defaults the shield should cover automatically. */
    fun defaults(): List<AppBlocklistEntry> = entries().filter { it.isDefault }

    /** Shipped entries that are only ever recommendations. */
    fun optional(): List<AppBlocklistEntry> = entries().filterNot { it.isDefault }

    fun isDefaultPackage(pkg: String): Boolean = defaults().any { it.androidPackage == pkg }

    fun isInstalled(pkg: String): Boolean = runCatching {
        appContext.packageManager.getPackageInfo(pkg, 0)
    }.isSuccess

    /**
     * Installed recommendations that are neither blocked nor remembered as
     * removed — what the UI offers as one-tap adds.
     */
    fun recommended(blocked: List<String>, removed: List<String>): List<AppBlocklistEntry> =
        optional().filter {
            it.androidPackage !in blocked &&
                it.androidPackage !in removed &&
                isInstalled(it.androidPackage)
        }

    /**
     * Merge installed shipped defaults into the blocked-apps list. Called at
     * launch, whenever the App Blocking screen opens, and from the shield
     * service — so a freshly installed default app is covered without the user
     * ever opening the picker.
     */
    suspend fun syncDefaults() {
        if (!isEnabled()) return
        val removed = store.blockedAppsRemoved.first().toSet()
        val current = store.blockedApps.first()
        val missing = defaults()
            .map { it.androidPackage }
            .filter { it !in removed && it !in current && isInstalled(it) }
        if (missing.isNotEmpty()) {
            store.setBlockedApps((current + missing).distinct())
        }
    }
}
