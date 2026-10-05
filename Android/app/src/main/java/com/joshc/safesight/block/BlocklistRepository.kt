package com.joshc.safesight.block

import android.content.Context
import com.joshc.safesight.data.SettingsStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

/**
 * In-app site blocklist, ported from the extensions:
 *  - defaults ship in assets/blocklist.json (locked, never removable)
 *  - user additions live in blocklistUser, user removals of defaults in
 *    blocklistRemoved (chrome.storage keys, unchanged)
 *  - normalizeSite() is a line-for-line port of service-worker.js
 */
class BlocklistRepository(
    context: Context,
    private val store: SettingsStore,
) {
    private val assetContext = context.applicationContext

    @Volatile
    private var defaultsCache: List<String>? = null

    /** defaults (minus user removals) + user additions, deduped. */
    val effective: Flow<List<String>> = combine(
        store.blocklistUser,
        store.blocklistRemoved,
    ) { user, removed ->
        val kept = defaults().filter { it !in removed }
        (kept + user).distinct()
    }

    fun defaults(): List<String> {
        defaultsCache?.let { return it }
        val parsed = runCatching {
            assetContext.assets.open("blocklist.json").bufferedReader().readText()
                .let { org.json.JSONObject(it) }
                .let { json ->
                    val arr = json.optJSONArray("sites") ?: org.json.JSONArray()
                    (0 until arr.length()).mapNotNull { i -> normalizeSite(arr.optString(i)) }
                }
                .distinct()
        }.getOrDefault(emptyList())
        defaultsCache = parsed
        return parsed
    }

    fun defaultCount(): Int = defaults().size

    companion object {
        /** Port of normalizeSite() — service-worker.js lines 205-219. */
        fun normalizeSite(entry: String): String? {
            var s = entry.trim().lowercase()
            if (s.isEmpty()) return null
            s = s.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
                .split(Regex("[/?#]")).firstOrNull().orEmpty()
            s = s.substringAfterLast('@').substringBefore(':')
            s = s.removePrefix("*.").removePrefix("www.").removeSuffix(".")
            return s.ifEmpty { null }?.takeIf { it.contains('.') }
        }

        /** hostMatchesSite() from content.js/service-worker.js. */
        fun matches(host: String, sites: List<String>): Boolean {
            val h = host.lowercase().removePrefix("www.")
            return sites.any { h == it || h.endsWith(".$it") }
        }

        fun blockedPageUrl(url: String, site: String): String =
            "file:///android_asset/blocked.html" +
                "?url=" + java.net.URLEncoder.encode(url, "UTF-8") +
                "&site=" + java.net.URLEncoder.encode(site, "UTF-8")
    }
}
