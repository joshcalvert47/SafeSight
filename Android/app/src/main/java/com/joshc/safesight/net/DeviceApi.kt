package com.joshc.safesight.net

import android.os.Build
import com.google.firebase.firestore.ListenerRegistration
import com.joshc.safesight.data.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Device side of the parental controls, straight against Firestore (the
 * contract is firestore.rules): pairing-code redemption, policy pull and
 * unlock requests. No HTTP worker calls left here. Every path degrades —
 * without a Firebase config the last cached policy still applies, so a paired
 * device keeps enforcing the rules it saw.
 */
object DeviceApi {

    sealed class RedeemResult {
        data class Success(
            val familyId: String,
            val childId: String,
            val childName: String?,
        ) : RedeemResult()

        data class Failure(val error: String) : RedeemResult()
        data class Network(val message: String) : RedeemResult()
    }

    sealed class PolicyResult {
        data class Success(val raw: String, val fromCache: Boolean) : PolicyResult()
        data class Failure(val error: String) : PolicyResult()
        data class Network(val message: String) : PolicyResult()
    }

    private const val UNLOCK_TIMEOUT_MS = 30_000L

    /**
     * Redeem a 6-char pairing code: pairingCodes/{code} → claim it →
     * devices/{uid} → children/{childId} (the rules only let a device read
     * its own child profile once devices/{uid} exists).
     */
    suspend fun redeem(
        code: String,
        device: String,
        version: String,
        platform: String,
        deviceId: String,
    ): RedeemResult = withContext(Dispatchers.IO) {
        val uid = FirebaseIdentity.uid ?: return@withContext RedeemResult.Failure("not_signed_in")
        val db = firestore() ?: return@withContext RedeemResult.Failure("not_signed_in")
        val pairCode = code.trim().uppercase()
        firestoreOp {
            val codeRef = db.collection("pairingCodes").document(pairCode)
            val codeSnap = codeRef.get().await()
            val familyId = codeSnap.getString("familyId")
            val childId = codeSnap.getString("childId")
            val usedBy = codeSnap.getString("usedBy")
            val expiresAt = codeSnap.getLong("expiresAt") ?: 0L
            val now = System.currentTimeMillis()
            if (!codeSnap.exists() || familyId.isNullOrEmpty() || childId.isNullOrEmpty()) {
                throw ApiException("invalid_code")
            }
            if (expiresAt < now) throw ApiException("invalid_code")
            if (usedBy != null && usedBy != uid) throw ApiException("invalid_code")

            // Claim: rules allow flipping usedBy/usedAt once, nothing else.
            if (usedBy == null) {
                codeRef.update(mapOf("usedBy" to uid, "usedAt" to now)).await()
            }

            val deviceRef = db.collection("devices").document(uid)
            val known = deviceRef.get().await()
            if (known.exists()) {
                // An existing device may only refresh its heartbeat — rules
                // reject re-parenting it into a different family/child.
                val sameFamily = known.getString("familyId") == familyId &&
                    known.getString("childId") == childId
                if (!sameFamily) throw ApiException("device_already_paired")
                deviceRef.update(
                    mapOf("lastSeen" to now, "device" to device, "version" to version),
                ).await()
            } else {
                deviceRef.set(
                    mapOf(
                        "uid" to uid,
                        "familyId" to familyId,
                        "childId" to childId,
                        "pairCode" to pairCode,
                        "device" to device,
                        "version" to version,
                        "platform" to platform,
                        "deviceId" to deviceId,
                        "ip" to "",
                        "createdAt" to now,
                        "lastSeen" to now,
                    ),
                ).await()
            }

            val childSnap = db.collection("children").document(childId).get().await()
            if (!childSnap.exists()) throw ApiException("unknown_child")
            RedeemResult.Success(
                familyId = familyId,
                childId = childId,
                childName = childSnap.getString("name"),
            )
        }.fold(
            onSuccess = { it },
            onFailure = { it.toRedeem() },
        )
    }

    /**
     * Pulls children/{childId}.policy and caches it in SettingsStore. The
     * stored copy is the offline fallback (and the only option when Firebase
     * is not configured), exactly like the old /api/policy cache.
     */
    suspend fun policy(store: SettingsStore): PolicyResult = withContext(Dispatchers.IO) {
        val cached = store.policyCache()
        val uid = FirebaseIdentity.uid
        val db = firestore()
        if (db == null || uid == null) {
            return@withContext cached?.let { PolicyResult.Success(it, fromCache = true) }
                ?: PolicyResult.Failure("not_signed_in")
        }
        val childId = runCatching { store.pairedChildId.first() }.getOrNull().orEmpty()
        if (childId.isEmpty()) {
            return@withContext cached?.let { PolicyResult.Success(it, fromCache = true) }
                ?: PolicyResult.Failure("unknown_child")
        }
        firestoreOp {
            val snap = db.collection("children").document(childId).get().await()
            if (!snap.exists()) throw ApiException("unknown_child")
            val raw = policyRaw(
                childName = snap.getString("name") ?: "",
                policy = snap.get("policy") as? Map<*, *>,
            )
            store.savePolicy(raw)
            // Best-effort heartbeat: rules let a device touch only its own lastSeen.
            runCatching {
                db.collection("devices").document(uid)
                    .update("lastSeen", System.currentTimeMillis())
            }
            raw
        }.fold(
            onSuccess = { PolicyResult.Success(it, fromCache = false) },
            onFailure = { t ->
                cached?.let { PolicyResult.Success(it, fromCache = true) }
                    ?: when (t.apiCode()) {
                        "unauthorized" -> PolicyResult.Failure("unauthorized")
                        "unknown_child" -> PolicyResult.Failure("unknown_child")
                        else -> PolicyResult.Network(t.message ?: "network error")
                    }
            },
        )
    }

    /**
     * Live children/{childId} listener: every policy snapshot is rendered into
     * the same {childName, policy} shape as [policy] and handed to [onChange]
     * (which caches it via SettingsStore.savePolicy). Also refreshes the
     * device heartbeat while the listener runs. Returns a stop function.
     */
    fun listenPolicy(childId: String, onChange: (String) -> Unit): (() -> Unit)? {
        if (childId.isEmpty()) return null
        val uid = FirebaseIdentity.uid ?: return null
        val db = firestore() ?: return null
        val registration = db.collection("children").document(childId)
            .addSnapshotListener { snap, error ->
                if (error != null || snap == null || !snap.exists()) return@addSnapshotListener
                onChange(
                    policyRaw(
                        childName = snap.getString("name") ?: "",
                        policy = snap.get("policy") as? Map<*, *>,
                    ),
                )
                // Best-effort heartbeat: rules let a device touch only its own lastSeen.
                runCatching {
                    db.collection("devices").document(uid)
                        .update("lastSeen", System.currentTimeMillis())
                }
            }
        return { registration.remove() }
    }

    /**
     * Files an unlockRequests/{id} document (status "pending") and returns its
     * id, or null when this install cannot ask (unpaired / no Firebase).
     */
    suspend fun unlockRequest(action: String, detail: String): String? =
        withContext(Dispatchers.IO) {
            val uid = FirebaseIdentity.uid ?: return@withContext null
            val db = firestore() ?: return@withContext null
            firestoreOp {
                val deviceSnap = db.collection("devices").document(uid).get().await()
                val familyId = deviceSnap.getString("familyId") ?: throw ApiException("unpaired")
                val childId = deviceSnap.getString("childId") ?: throw ApiException("unpaired")
                val ref = db.collection("unlockRequests").document()
                ref.set(
                    mapOf(
                        "familyId" to familyId,
                        "childId" to childId,
                        "deviceUid" to uid,
                        "device" to deviceLabel(),
                        "action" to action,
                        "detail" to detail,
                        "status" to "pending",
                        "at" to System.currentTimeMillis(),
                    ),
                ).await()
                ref.id
            }.getOrNull()
        }

    /** One-shot read: "pending" | "approved" | "denied" | "unknown". */
    suspend fun unlockStatus(id: String): String = withContext(Dispatchers.IO) {
        val db = firestore() ?: return@withContext "unknown"
        firestoreOp {
            val snap = db.collection("unlockRequests").document(id).get().await()
            if (!snap.exists()) "unknown" else snap.getString("status") ?: "unknown"
        }.getOrDefault("unknown")
    }

    /**
     * Waits for the parent's decision via an addSnapshotListener (no polling)
     * and gives up after [timeoutMs], returning "timeout".
     */
    suspend fun awaitUnlockStatus(
        id: String,
        timeoutMs: Long = UNLOCK_TIMEOUT_MS,
    ): String = withContext(Dispatchers.IO) {
        val db = firestore() ?: return@withContext "unknown"
        withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine<String> { cont ->
                val resumed = AtomicBoolean(false)
                var registration: ListenerRegistration? = null
                registration = db.collection("unlockRequests").document(id)
                    .addSnapshotListener { snap, error ->
                        val status = when {
                            error != null -> "unknown"
                            snap == null || !snap.exists() -> "unknown"
                            else -> snap.getString("status") ?: "pending"
                        }
                        if (status != "pending" && resumed.compareAndSet(false, true)) {
                            registration?.remove()
                            if (cont.isActive) cont.resume(status)
                        }
                    }
                cont.invokeOnCancellation { registration?.remove() }
            }
        } ?: "timeout"
    }

    private fun Throwable.toRedeem(): RedeemResult = when (val code = apiCode()) {
        null, "offline", "timeout" -> RedeemResult.Network(message ?: "network error")
        "not_found" -> RedeemResult.Failure("invalid_code")
        else -> RedeemResult.Failure(code)
    }

    /**
     * Mirrors the worker's /api/policy body — {childName, policy{…}} — so
     * SettingsStore.savePolicy keeps parsing it verbatim.
     */
    private fun policyRaw(childName: String, policy: Map<*, *>?): String {
        val body = JSONObject()
        policy?.forEach { (key, value) -> if (key is String) body.put(key, jsonValue(value)) }
        return JSONObject()
            .put("childName", childName)
            .put("policy", body)
            .toString()
    }

    private fun jsonValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { o ->
            value.forEach { (k, v) -> o.put(k.toString(), jsonValue(v)) }
        }

        is List<*> -> JSONArray().also { arr -> value.forEach { arr.put(jsonValue(it)) } }

        else -> value
    }

    private fun deviceLabel(): String = "Android / ${Build.MANUFACTURER} ${Build.MODEL}"
}
