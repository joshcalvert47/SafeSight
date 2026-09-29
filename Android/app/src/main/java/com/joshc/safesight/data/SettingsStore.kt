package com.joshc.safesight.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "safesight")

/**
 * Settings parity with the extensions' chrome.storage.local keys — the same
 * names are used deliberately (skinFilter, blurAll, sensitivity,
 * blocklistDefaults/User/Removed, scannedCount, blockedCount, accountReady)
 * so values map 1:1 between platforms.
 */
class SettingsStore(private val context: Context) {

    private object Keys {
        val SKIN_FILTER = booleanPreferencesKey("skinFilter")
        val BLUR_ALL = booleanPreferencesKey("blurAll")
        val SENSITIVITY = intPreferencesKey("sensitivity")
        val BLOCKED_SITES = stringPreferencesKey("blockedSites")
        val ALLOWED_SITES = stringPreferencesKey("allowedSites")
        val BLOCKED_APPS = stringPreferencesKey("blockedApps")
        val BLOCKED_APPS_REMOVED = stringPreferencesKey("blockedAppsRemoved")
        val BLOCKLIST_DEFAULTS = stringPreferencesKey("blocklistDefaults")
        val BLOCKLIST_USER = stringPreferencesKey("blocklistUser")
        val BLOCKLIST_REMOVED = stringPreferencesKey("blocklistRemoved")
        val SCANNED_COUNT = intPreferencesKey("scannedCount")
        val BLOCKED_COUNT = intPreferencesKey("blockedCount")
        val ACCOUNT_READY = booleanPreferencesKey("accountReady")
        val DNS_BLOCKING = booleanPreferencesKey("dnsBlocking")
        val CLIENT_ID = stringPreferencesKey("clientId")
        val DEVICE_ID = stringPreferencesKey("deviceId")
        val ACCOUNT_EMAIL = stringPreferencesKey("accountEmail")
        val ACCOUNT_NAME = stringPreferencesKey("accountName")
        /** "pending" until the admin approves — the app stays locked. */
        val ACCOUNT_STATUS = stringPreferencesKey("accountStatus")
        val PAIRED_FAMILY_ID = stringPreferencesKey("pairedFamilyId")
        val PAIRED_CHILD_ID = stringPreferencesKey("pairedChildId")
        val CHILD_NAME = stringPreferencesKey("childName")
        val POLICY_CACHE = stringPreferencesKey("policyCache")
        /** Parent (Google) mode — independent of this device being paired. */
        val PARENT_MODE = booleanPreferencesKey("parentMode")
    }

    val skinFilter: Flow<Boolean> = context.dataStore.data.map { it[Keys.SKIN_FILTER] ?: false }
    val blurAll: Flow<Boolean> = context.dataStore.data.map { it[Keys.BLUR_ALL] ?: false }
    val sensitivity: Flow<Int> = context.dataStore.data.map { it[Keys.SENSITIVITY] ?: 4 }
    val scannedCount: Flow<Int> = context.dataStore.data.map { it[Keys.SCANNED_COUNT] ?: 0 }
    val blockedCount: Flow<Int> = context.dataStore.data.map { it[Keys.BLOCKED_COUNT] ?: 0 }
    val accountReady: Flow<Boolean> = context.dataStore.data.map { it[Keys.ACCOUNT_READY] ?: false }
    val dnsBlocking: Flow<Boolean> = context.dataStore.data.map { it[Keys.DNS_BLOCKING] ?: false }
    val accountEmail: Flow<String> = context.dataStore.data.map { it[Keys.ACCOUNT_EMAIL] ?: "" }
    val accountName: Flow<String> = context.dataStore.data.map { it[Keys.ACCOUNT_NAME] ?: "" }
    /** Defaults to "approved" so accounts registered before approval keep working. */
    val accountStatus: Flow<String> =
        context.dataStore.data.map { it[Keys.ACCOUNT_STATUS] ?: "approved" }
    val blockedSites: Flow<List<String>> = listFlow(Keys.BLOCKED_SITES)
    val allowedSites: Flow<List<String>> = listFlow(Keys.ALLOWED_SITES)
    val blockedApps: Flow<List<String>> = listFlow(Keys.BLOCKED_APPS)
    /** Shipped defaults the user removed — never re-added by the sync. */
    val blockedAppsRemoved: Flow<List<String>> = listFlow(Keys.BLOCKED_APPS_REMOVED)
    val blocklistUser: Flow<List<String>> = listFlow(Keys.BLOCKLIST_USER)
    val blocklistRemoved: Flow<List<String>> = listFlow(Keys.BLOCKLIST_REMOVED)

    /** "" = not paired yet; declared nullable so callers can wait out the first read. */
    val pairedChildId: Flow<String?> =
        context.dataStore.data.map { it[Keys.PAIRED_CHILD_ID] ?: "" }

    /** Family of the paired child — written by setPaired during redemption. */
    val pairedFamilyId: Flow<String> =
        context.dataStore.data.map { it[Keys.PAIRED_FAMILY_ID] ?: "" }
    val childName: Flow<String> = context.dataStore.data.map { it[Keys.CHILD_NAME] ?: "" }
    val parentMode: Flow<Boolean> =
        context.dataStore.data.map { it[Keys.PARENT_MODE] ?: false }

    data class Account(
        val clientId: String,
        val deviceId: String,
        val email: String,
        val accountName: String,
    )

    val account: Flow<Account?> = context.dataStore.data.map { p ->
        val id = p[Keys.CLIENT_ID]
        if (id.isNullOrEmpty()) null else Account(
            clientId = id,
            deviceId = p[Keys.DEVICE_ID] ?: "",
            email = p[Keys.ACCOUNT_EMAIL] ?: "",
            accountName = p[Keys.ACCOUNT_NAME] ?: "",
        )
    }

    suspend fun setSkinFilter(value: Boolean) = edit { it[Keys.SKIN_FILTER] = value }
    suspend fun setBlurAll(value: Boolean) = edit { it[Keys.BLUR_ALL] = value }
    suspend fun setSensitivity(value: Int) =
        edit { it[Keys.SENSITIVITY] = value.coerceIn(1, 9) }
    suspend fun setDnsBlocking(value: Boolean) = edit { it[Keys.DNS_BLOCKING] = value }

    suspend fun setBlockedSites(value: List<String>) = setList(Keys.BLOCKED_SITES, value)
    suspend fun setAllowedSites(value: List<String>) = setList(Keys.ALLOWED_SITES, value)
    suspend fun setBlockedApps(value: List<String>) = setList(Keys.BLOCKED_APPS, value)
    suspend fun setBlockedAppsRemoved(value: List<String>) = setList(Keys.BLOCKED_APPS_REMOVED, value)
    suspend fun setBlocklistUser(value: List<String>) = setList(Keys.BLOCKLIST_USER, value)
    suspend fun setBlocklistRemoved(value: List<String>) = setList(Keys.BLOCKLIST_REMOVED, value)

    suspend fun resetStats() = edit {
        it[Keys.SCANNED_COUNT] = 0
        it[Keys.BLOCKED_COUNT] = 0
    }

    /**
     * Snapshot for the chrome.storage shim: same key names the content script
     * asks for. blocklistDefaults is intentionally omitted (null) so the page
     * falls back to fetching blocklist.json, exactly like the extension when
     * storage has not been seeded yet.
     */
    suspend fun getFor(keys: List<String>): Map<String, Any?> {
        val p = context.dataStore.data.first()
        return keys.associateWith { key ->
            when (key) {
                "skinFilter" -> p[Keys.SKIN_FILTER] ?: false
                "blurAll" -> p[Keys.BLUR_ALL] ?: false
                "sensitivity" -> p[Keys.SENSITIVITY] ?: 4
                "blockedSites" -> decodeList(p[Keys.BLOCKED_SITES])
                "allowedSites" -> decodeList(p[Keys.ALLOWED_SITES])
                "blocklistUser" -> decodeList(p[Keys.BLOCKLIST_USER])
                "blocklistRemoved" -> decodeList(p[Keys.BLOCKLIST_REMOVED])
                "blocklistDefaults" -> null
                "accountReady" -> p[Keys.ACCOUNT_READY] ?: false
                "accountStatus" -> p[Keys.ACCOUNT_STATUS] ?: "approved"
                "scannedCount" -> p[Keys.SCANNED_COUNT] ?: 0
                "blockedCount" -> p[Keys.BLOCKED_COUNT] ?: 0
                "clientId" -> p[Keys.CLIENT_ID] ?: ""
                "accountEmail" -> p[Keys.ACCOUNT_EMAIL] ?: ""
                "accountName" -> p[Keys.ACCOUNT_NAME] ?: ""
                else -> null
            }
        }
    }

    suspend fun incrementStats(scanned: Int = 0, blocked: Int = 0) = edit { p ->
        if (scanned > 0) p[Keys.SCANNED_COUNT] = (p[Keys.SCANNED_COUNT] ?: 0) + scanned
        if (blocked > 0) p[Keys.BLOCKED_COUNT] = (p[Keys.BLOCKED_COUNT] ?: 0) + blocked
    }

    /** Stable per-install id, same role as deviceId() in chrome/popup.js. */
    suspend fun deviceId(): String {
        val existing = context.dataStore.data.map { it[Keys.DEVICE_ID] ?: "" }.first()
        if (existing.isNotEmpty()) return existing
        val generated = java.util.UUID.randomUUID().toString()
        edit { it[Keys.DEVICE_ID] = generated }
        return generated
    }

    suspend fun setRegistered(
        clientId: String,
        deviceId: String,
        email: String,
        accountName: String,
        status: String = "approved",
    ) = edit {
        it[Keys.CLIENT_ID] = clientId
        it[Keys.DEVICE_ID] = deviceId
        it[Keys.ACCOUNT_EMAIL] = email
        it[Keys.ACCOUNT_NAME] = accountName
        it[Keys.ACCOUNT_STATUS] = status
        it[Keys.ACCOUNT_READY] = true
    }

    suspend fun setAccountStatus(status: String) = edit { it[Keys.ACCOUNT_STATUS] = status }

    suspend fun setPaired(familyId: String, childId: String, childName: String) = edit {
        it[Keys.PAIRED_FAMILY_ID] = familyId
        it[Keys.PAIRED_CHILD_ID] = childId
        it[Keys.CHILD_NAME] = childName
    }

    suspend fun setParentMode(value: Boolean) = edit { it[Keys.PARENT_MODE] = value }

    suspend fun policyCache(): String? =
        context.dataStore.data.map { it[Keys.POLICY_CACHE] }.first()

    /**
     * Keeps the last children/{id}.policy response verbatim — the offline
     * fallback for Firestore (and the only policy source when Firebase is not
     * configured) — and mirrors the enforced fields into their settings keys.
     */
    suspend fun savePolicy(raw: String) = edit { p ->
        p[Keys.POLICY_CACHE] = raw
        runCatching {
            val root = JSONObject(raw)
            if (!root.isNull("childName")) p[Keys.CHILD_NAME] = root.optString("childName")
            val policy = root.optJSONObject("policy") ?: return@runCatching
            if (policy.has("blockedSites")) {
                p[Keys.BLOCKED_SITES] = encodeList(arrToList(policy.optJSONArray("blockedSites")))
            }
            if (policy.has("allowedSites")) {
                p[Keys.ALLOWED_SITES] = encodeList(arrToList(policy.optJSONArray("allowedSites")))
            }
            if (policy.has("skinFilter")) p[Keys.SKIN_FILTER] = policy.optBoolean("skinFilter")
            if (policy.has("blurAll")) p[Keys.BLUR_ALL] = policy.optBoolean("blurAll")
            if (policy.has("sensitivity")) {
                p[Keys.SENSITIVITY] = policySensitivity(policy.optInt("sensitivity", 50))
            }
        }
    }

    private fun listFlow(key: Preferences.Key<String>): Flow<List<String>> =
        context.dataStore.data.map { p -> decodeList(p[key]) }

    private suspend fun setList(key: Preferences.Key<String>, value: List<String>) =
        edit { it[key] = encodeList(value) }

    /** Policy is 0-100 (parent console), the settings slider is 1-9. */
    private fun policySensitivity(value: Int): Int =
        ((value.coerceIn(0, 100) * 8 + 50) / 100 + 1).coerceIn(1, 9)

    private fun arrToList(arr: JSONArray?): List<String> =
        if (arr == null) {
            emptyList()
        } else {
            (0 until arr.length()).mapNotNull { i -> arr.optString(i).ifEmpty { null } }
        }

    private suspend fun edit(block: (MutablePreferences) -> Unit) {
        context.dataStore.edit(block)
    }

    companion object {
        fun encodeList(value: List<String>): String {
            val arr = JSONArray()
            value.forEach { arr.put(it) }
            return arr.toString()
        }

        fun decodeList(raw: String?): List<String> {
            if (raw.isNullOrEmpty()) return emptyList()
            return runCatching {
                val arr = JSONArray(raw)
                (0 until arr.length()).mapNotNull { i -> arr.optString(i).ifEmpty { null } }
            }.getOrDefault(emptyList())
        }
    }
}
