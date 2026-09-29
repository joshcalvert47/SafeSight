package com.joshc.safesight.net

import com.google.android.gms.tasks.Task
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Shared plumbing for the Firestore-backed DeviceApi/ParentApi (the contract
 * is firestore.rules). Everything degrades instead of throwing when Firebase
 * is not configured — a checkout without google-services.json still compiles
 * and the app falls back to its local cache.
 */

/** Longest one round-trip may take before the call reports a network failure. */
private const val OP_TIMEOUT_MS = 15_000L

/** Domain failure carrying a stable code the ViewModel maps to a message. */
internal class ApiException(val code: String) : Exception(code)

/** Firestore, or null when the Firebase app is not configured. */
internal fun firestore(): FirebaseFirestore? =
    runCatching { FirebaseFirestore.getInstance() }.getOrNull()

internal suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnSuccessListener { if (cont.isActive) cont.resume(it) }
    addOnFailureListener { if (cont.isActive) cont.resumeWithException(it) }
}

/** Runs one Firestore round-trip with a deadline; cancellation still propagates. */
internal suspend fun <T> firestoreOp(block: suspend () -> T): Result<T> = try {
    Result.success(withTimeout(OP_TIMEOUT_MS) { block() })
} catch (e: TimeoutCancellationException) {
    Result.failure(e)
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    Result.failure(e)
}

/**
 * A stable error code for a failure: ApiException codes verbatim, Firestore
 * codes normalised ("unauthorized", "not_found", "offline", "timeout", …),
 * null when the failure carries no useful code.
 */
internal fun Throwable.apiCode(): String? = when (this) {
    is ApiException -> code
    is TimeoutCancellationException -> "timeout"
    is FirebaseFirestoreException -> when (code) {
        FirebaseFirestoreException.Code.PERMISSION_DENIED -> "unauthorized"
        FirebaseFirestoreException.Code.UNAVAILABLE -> "offline"
        FirebaseFirestoreException.Code.DEADLINE_EXCEEDED -> "timeout"
        FirebaseFirestoreException.Code.NOT_FOUND -> "not_found"
        FirebaseFirestoreException.Code.ALREADY_EXISTS -> "already_exists"
        FirebaseFirestoreException.Code.INVALID_ARGUMENT -> "invalid_argument"
        else -> null
    }
    else -> null
}
