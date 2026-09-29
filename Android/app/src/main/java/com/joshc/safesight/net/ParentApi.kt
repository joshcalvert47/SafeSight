package com.joshc.safesight.net

import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/**
 * Parent half of the app, straight against Firestore (the contract is
 * firestore.rules): the Google-account bootstrap plus the family/children/
 * devices/unlock reads the dashboard needs. Every query uses a single
 * `where("familyId", == myFamilyId)` clause — no composite indexes — and all
 * sorting/filtering happens on this client.
 */
object ParentApi {

    data class Session(
        val uid: String,
        val email: String,
        val name: String,
        val role: String,
        val familyId: String,
    )

    data class Child(
        val id: String,
        val name: String,
        val ageBand: String,
        /** children/{id}.policy — what the editor loads and saves back. */
        val policy: Map<String, Any?>,
    )

    data class DeviceRef(
        val uid: String,
        val childId: String,
        val device: String,
        val lastSeen: Long,
    )

    data class UnlockRequest(
        val id: String,
        val childId: String,
        val device: String,
        val action: String,
        val detail: String,
        val at: Long,
    )

    data class PairCode(val code: String, val expiresAt: Long, val childName: String)

    data class Me(
        val userName: String,
        val userEmail: String,
        val familyId: String,
        val children: List<Child>,
        val devices: List<DeviceRef>,
        val unlockRequests: List<UnlockRequest>,
    )

    sealed class AuthResult {
        data class Success(val session: Session) : AuthResult()
        data class Failure(val error: String) : AuthResult()
        data class Network(val message: String) : AuthResult()
    }

    sealed class MeResult {
        data class Success(val me: Me) : MeResult()
        data object Unauthorized : MeResult()
        data class Failure(val error: String) : MeResult()
        data class Network(val message: String) : MeResult()
    }

    sealed class PairResult {
        data class Success(val pairCode: PairCode) : PairResult()
        data class Failure(val error: String) : PairResult()
        data class Network(val message: String) : PairResult()
    }

    sealed class OpResult {
        data object Ok : OpResult()
        data class Failure(val error: String) : OpResult()
        data class Network(val message: String) : OpResult()
    }

    /** A-Z minus 0/O/1/I, 32 symbols — same shape the extensions show. */
    private const val CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    /** Rules cap a new code at 10 minutes; we write exactly that. */
    private const val PAIR_TTL_MS = 600_000L

    /**
     * First Google sign-in bootstraps the account: families/{id} first (the
     * users/{uid} rules require the family to exist), then users/{uid}.
     */
    suspend fun googleSignIn(): AuthResult = withContext(Dispatchers.IO) {
        val profile = FirebaseIdentity.profile
            ?: return@withContext AuthResult.Failure("not_signed_in")
        val db = firestore() ?: return@withContext AuthResult.Failure("not_signed_in")
        firestoreOp { ensureProfile(db, profile) }.fold(
            onSuccess = { AuthResult.Success(it) },
            onFailure = { it.toAuth() },
        )
    }

    /** The family, children, devices and pending unlock requests, for the dashboard. */
    suspend fun me(): MeResult = withContext(Dispatchers.IO) {
        val profile = FirebaseIdentity.profile ?: return@withContext MeResult.Unauthorized
        val db = firestore() ?: return@withContext MeResult.Unauthorized
        firestoreOp {
            val session = ensureProfile(db, profile)
            val familyId = session.familyId
            val children = db.collection("children")
                .whereEqualTo("familyId", familyId)
                .get()
                .await()
            val devices = db.collection("devices")
                .whereEqualTo("familyId", familyId)
                .get()
                .await()
            val unlocks = db.collection("unlockRequests")
                .whereEqualTo("familyId", familyId)
                .get()
                .await()
            Me(
                userName = session.name,
                userEmail = session.email,
                familyId = familyId,
                children = children.documents.map {
                    Child(
                        id = it.id,
                        name = it.getString("name") ?: "",
                        ageBand = it.getString("ageBand") ?: "",
                        policy = policyMap(it.get("policy")),
                    )
                }.sortedBy { it.name.lowercase() },
                devices = devices.documents.map {
                    DeviceRef(
                        uid = it.id,
                        childId = it.getString("childId") ?: "",
                        device = it.getString("device") ?: "",
                        lastSeen = it.getLong("lastSeen") ?: 0L,
                    )
                }.sortedByDescending { it.lastSeen },
                unlockRequests = unlocks.documents
                    .mapNotNull { unlockRequest(it.id, it) }
                    .sortedByDescending { it.at },
            )
        }.fold(
            onSuccess = { MeResult.Success(it) },
            onFailure = { it.toMe() },
        )
    }

    /** Create when [id] is empty, update otherwise. */
    suspend fun saveChild(id: String?, name: String, ageBand: String): OpResult {
        // Rules cap children.name at 80 chars; worker.js caps ageBand at 20.
        val trimmed = name.trim().take(80)
        val band = ageBand.trim().take(20)
        if (trimmed.isEmpty()) return OpResult.Failure("name_required")
        val profile = FirebaseIdentity.profile ?: return OpResult.Failure("not_signed_in")
        val db = firestore() ?: return OpResult.Failure("not_signed_in")
        return withContext(Dispatchers.IO) {
            firestoreOp {
                val familyId = ensureProfile(db, profile).familyId
                val now = System.currentTimeMillis()
                if (id.isNullOrEmpty()) {
                    db.collection("children").document().set(
                        mapOf(
                            "familyId" to familyId,
                            "name" to trimmed,
                            "ageBand" to band,
                            "policy" to defaultPolicy(),
                            "createdAt" to now,
                            "updatedAt" to now,
                        ),
                    ).await()
                } else {
                    db.collection("children").document(id).update(
                        mapOf(
                            "name" to trimmed,
                            "ageBand" to band,
                            "updatedAt" to now,
                        ),
                    ).await()
                }
            }.fold(
                onSuccess = { OpResult.Ok },
                onFailure = { it.toOp() },
            )
        }
    }

    /** Removes the child profile and every device paired to it. */
    suspend fun deleteChild(id: String): OpResult = withContext(Dispatchers.IO) {
        val profile = FirebaseIdentity.profile ?: return@withContext OpResult.Failure("not_signed_in")
        val db = firestore() ?: return@withContext OpResult.Failure("not_signed_in")
        firestoreOp {
            val familyId = ensureProfile(db, profile).familyId
            db.collection("children").document(id).delete().await()
            // No composite index: query by familyId, filter by child here.
            val devices = db.collection("devices")
                .whereEqualTo("familyId", familyId)
                .get()
                .await()
            devices.documents
                .filter { it.getString("childId") == id }
                .forEach { db.collection("devices").document(it.id).delete().await() }
        }.fold(
            onSuccess = { OpResult.Ok },
            onFailure = { it.toOp() },
        )
    }

    /** A client-generated 6-char code whose document id *is* the code. */
    suspend fun createPairingCode(childId: String): PairResult = withContext(Dispatchers.IO) {
        val profile = FirebaseIdentity.profile
            ?: return@withContext PairResult.Failure("not_signed_in")
        val db = firestore() ?: return@withContext PairResult.Failure("not_signed_in")
        firestoreOp {
            val session = ensureProfile(db, profile)
            newPairingCode(db, session.familyId, childId)
        }.fold(
            onSuccess = { PairResult.Success(it) },
            onFailure = { it.toPair() },
        )
    }

    /**
     * Picks a fresh code, verifies the document id is free (rules also reject
     * an overwrite, so a collision just costs one attempt) and writes it with
     * a 10-minute TTL.
     */
    private suspend fun newPairingCode(
        db: FirebaseFirestore,
        familyId: String,
        childId: String,
    ): PairCode {
        val childSnap = db.collection("children").document(childId).get().await()
        if (!childSnap.exists()) throw ApiException("unknown_child")
        val childName = childSnap.getString("name") ?: ""
        var lastFailure: Exception? = null
        repeat(5) {
            val code = generateCode()
            val now = System.currentTimeMillis()
            val expiresAt = now + PAIR_TTL_MS
            val ref = db.collection("pairingCodes").document(code)
            if (ref.get().await().exists()) return@repeat
            try {
                ref.set(
                    mapOf(
                        "code" to code,
                        "familyId" to familyId,
                        "childId" to childId,
                        "createdAt" to now,
                        "expiresAt" to expiresAt,
                        "usedBy" to null,
                        "usedAt" to null,
                    ),
                ).await()
                return PairCode(code = code, expiresAt = expiresAt, childName = childName)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lastFailure = e
            }
        }
        throw lastFailure ?: ApiException("code_unavailable")
    }

    /** decision: "approve" | "deny" — rules allow touching status/decidedAt only. */
    suspend fun unlockDecide(id: String, decision: String): OpResult =
        withContext(Dispatchers.IO) {
            val db = firestore() ?: return@withContext OpResult.Failure("not_signed_in")
            firestoreOp {
                val status = if (decision.startsWith("deny")) "denied" else "approved"
                db.collection("unlockRequests").document(id).update(
                    mapOf(
                        "status" to status,
                        "decidedAt" to System.currentTimeMillis(),
                    ),
                ).await()
            }.fold(
                onSuccess = { OpResult.Ok },
                onFailure = { it.toOp(notFound = "unknown_request") },
            )
        }

    suspend fun deleteDevice(uid: String): OpResult = withContext(Dispatchers.IO) {
        val db = firestore() ?: return@withContext OpResult.Failure("not_signed_in")
        firestoreOp {
            db.collection("devices").document(uid).delete().await()
        }.fold(
            onSuccess = { OpResult.Ok },
            onFailure = { it.toOp(notFound = "unknown_device") },
        )
    }

    /**
     * Writes children/{childId}.policy wholesale (every DevicePolicy key) plus
     * updatedAt. Rules allow any keys on a same-family child update; the map
     * always includes the full key set, so Firestore's nested-map merge is a
     * replace in practice.
     */
    suspend fun updatePolicy(childId: String, policy: Map<String, Any?>): OpResult =
        withContext(Dispatchers.IO) {
            val profile = FirebaseIdentity.profile
                ?: return@withContext OpResult.Failure("not_signed_in")
            val db = firestore() ?: return@withContext OpResult.Failure("not_signed_in")
            firestoreOp {
                ensureProfile(db, profile)
                db.collection("children").document(childId).update(
                    mapOf(
                        "policy" to policy,
                        "updatedAt" to System.currentTimeMillis(),
                    ),
                ).await()
            }.fold(
                onSuccess = { OpResult.Ok },
                onFailure = { it.toOp(notFound = "unknown_child") },
            )
        }

    /**
     * Live pending unlockRequests for the family (single familyId query, no
     * composite index). Returns a stop function; callers must stop it when
     * the parent session ends.
     */
    fun listenUnlockRequests(
        familyId: String,
        onChange: (List<UnlockRequest>) -> Unit,
    ): (() -> Unit)? {
        if (familyId.isEmpty()) return null
        val db = firestore() ?: return null
        val registration = db.collection("unlockRequests")
            .whereEqualTo("familyId", familyId)
            .addSnapshotListener { snap, error ->
                if (error != null || snap == null) return@addSnapshotListener
                onChange(
                    snap.documents
                        .mapNotNull { unlockRequest(it.id, it) }
                        .sortedByDescending { it.at },
                )
            }
        return { registration.remove() }
    }

    /** Pending unlock doc → model; null once decided (or not an unlock doc). */
    private fun unlockRequest(id: String, doc: com.google.firebase.firestore.DocumentSnapshot): UnlockRequest? {
        if (doc.getString("status") != "pending") return null
        return UnlockRequest(
            id = id,
            childId = doc.getString("childId") ?: "",
            device = doc.getString("device") ?: "",
            action = doc.getString("action") ?: "",
            detail = doc.getString("detail") ?: "",
            at = doc.getLong("at") ?: 0L,
        )
    }

    /** Firestore value (policy sub-map) → plain Kotlin map for the editor. */
    private fun policyMap(value: Any?): Map<String, Any?> =
        (value as? Map<*, *>)
            ?.entries
            ?.associate { (k, v) -> k.toString() to v }
            ?: emptyMap()

    /**
     * users/{uid} for this Google account, creating family + profile on first
     * sign-in. The family document must exist before the profile: the rules
     * check `families/{familyId}.ownerUid` on users create.
     */
    private suspend fun ensureProfile(
        db: FirebaseFirestore,
        profile: FirebaseIdentity.Profile,
    ): Session {
        val userRef = db.collection("users").document(profile.uid)
        val snap = userRef.get().await()
        val familyId = snap.getString("familyId")
        if (snap.exists() && !familyId.isNullOrEmpty()) {
            return Session(
                uid = profile.uid,
                email = snap.getString("email") ?: profile.email,
                name = snap.getString("name") ?: profile.name,
                role = snap.getString("role") ?: "parent",
                familyId = familyId,
            )
        }
        if (snap.exists()) throw ApiException("no_family")

        val familyRef = db.collection("families").document()
        val now = System.currentTimeMillis()
        familyRef.set(
            mapOf(
                "id" to familyRef.id,
                "name" to "Family",
                "ownerUid" to profile.uid,
                "memberUids" to listOf(profile.uid),
                "createdAt" to now,
                "settings" to emptyMap<String, Any>(),
            ),
        ).await()
        userRef.set(
            mapOf(
                "uid" to profile.uid,
                "email" to profile.email,
                "name" to profile.name,
                "picture" to (profile.picture ?: ""),
                "role" to "parent",
                "familyId" to familyRef.id,
            ),
        ).await()
        return Session(
            uid = profile.uid,
            email = profile.email,
            name = profile.name,
            role = "parent",
            familyId = familyRef.id,
        )
    }

    /** Same defaults worker.js defaultPolicy() ships with (+ blockedApps). */
    private fun defaultPolicy(): Map<String, Any?> = mapOf(
        "blockedSites" to emptyList<String>(),
        "allowedSites" to emptyList<String>(),
        "sensitivity" to 50,
        "skinFilter" to true,
        "blurAll" to false,
        "screenTimeMinutes" to 0,
        "schedule" to null,
        "blockedApps" to emptyList<String>(),
    )

    private fun generateCode(): String = buildString(6) {
        val random = java.security.SecureRandom()
        repeat(6) { append(CODE_ALPHABET[random.nextInt(CODE_ALPHABET.length)]) }
    }

    private fun Throwable.toAuth(): AuthResult = when (val code = apiCode()) {
        null, "offline", "timeout" -> AuthResult.Network(message ?: "network error")
        else -> AuthResult.Failure(code)
    }

    private fun Throwable.toMe(): MeResult = when (val code = apiCode()) {
        "unauthorized" -> MeResult.Unauthorized
        null, "offline", "timeout" -> MeResult.Network(message ?: "network error")
        else -> MeResult.Failure(code)
    }

    private fun Throwable.toPair(): PairResult = when (val code = apiCode()) {
        null, "offline", "timeout" -> PairResult.Network(message ?: "network error")
        else -> PairResult.Failure(code)
    }

    private fun Throwable.toOp(notFound: String = "not_found"): OpResult =
        when (val code = apiCode()) {
            "not_found" -> OpResult.Failure(notFound)
            null, "offline", "timeout" -> OpResult.Network(message ?: "network error")
            else -> OpResult.Failure(code)
        }
}
