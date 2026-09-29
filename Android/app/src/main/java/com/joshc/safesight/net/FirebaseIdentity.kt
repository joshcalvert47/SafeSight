package com.joshc.safesight.net

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.tasks.Task
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Firebase Auth is identity only (worker/worker.js): anonymous for child
 * devices, Google for parents. Every call returns null instead of throwing
 * when Firebase is not configured (missing google-services.json), so the app
 * still builds and runs without it.
 */
object FirebaseIdentity {

    /**
     * True when google-services.json contributed a web OAuth client id — the
     * Google Sign-In flow cannot run without it.
     */
    fun isGoogleSigninAvailable(context: Context): Boolean = webClientId(context) != null

    /** A signed-in Firebase user that authenticated with Google. */
    val hasGoogleUser: Boolean
        get() = runCatching {
            auth()?.currentUser?.providerData
                ?.any { it.providerId == GoogleAuthProvider.PROVIDER_ID } == true
        }.getOrDefault(false)

    private fun auth(): FirebaseAuth? = runCatching { FirebaseAuth.getInstance() }.getOrNull()

    val isSignedIn: Boolean get() = runCatching { auth()?.currentUser != null }.getOrDefault(false)

    suspend fun signInAnonymously(): String? = runCatching {
        val a = auth() ?: return@runCatching null
        if (a.currentUser == null) awaitTask(a.signInAnonymously())
        tokenOf(a)
    }.getOrNull()

    /** Pass an ID token from the Google Sign-In flow; null when unavailable. */
    suspend fun signInWithGoogle(idToken: String? = null): String? = runCatching {
        if (idToken.isNullOrEmpty()) return@runCatching null
        val a = auth() ?: return@runCatching null
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        awaitTask(a.signInWithCredential(credential))
        tokenOf(a)
    }.getOrNull()

    /**
     * Full parent flow: Google account picker → Firebase credential exchange.
     * Returns the Firebase ID token (or null when sign-in is unavailable,
     * cancelled or the web client id is missing).
     */
    suspend fun signInWithGoogle(activity: Activity): String? = runCatching {
        val clientId = webClientId(activity) ?: return@runCatching null
        val host = activity as? ComponentActivity ?: return@runCatching null
        val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(clientId)
            .requestEmail()
            .build()
        // App context keeps the client out of the activity lifecycle.
        val client = GoogleSignIn.getClient(activity.applicationContext, options)
        googleClient = client
        val intent = client.signInIntent
        val googleToken = withContext(Dispatchers.Main) { awaitGoogleResult(host, intent) }
            ?: return@runCatching null
        signInWithGoogle(googleToken)
    }.getOrNull()

    suspend fun currentToken(): String? = runCatching {
        val a = auth() ?: return@runCatching null
        tokenOf(a)
    }.getOrNull()

    /** Firebase uid of the signed-in user (parent or paired device), else null. */
    val uid: String?
        get() = runCatching { auth()?.currentUser?.uid }.getOrNull()

    /** Account fields the users/{uid} profile document is written from. */
    data class Profile(
        val uid: String,
        val email: String,
        val name: String,
        val picture: String?,
    )

    val profile: Profile?
        get() = runCatching {
            val user = auth()?.currentUser ?: return null
            Profile(
                uid = user.uid,
                email = user.email ?: "",
                name = user.displayName ?: "",
                picture = user.photoUrl?.toString(),
            )
        }.getOrNull()

    fun signOut() {
        runCatching { googleClient?.signOut() }
        runCatching { auth()?.signOut() }
    }

    // Held only to sign the picker session out; always built from the app
    // context, so nothing activity-sized is retained.
    @Suppress("StaticFieldLeak")
    private var googleClient: GoogleSignInClient? = null

    /** The google-services plugin generates string "default_web_client_id". */
    @Suppress("DiscouragedApi")
    private fun webClientId(context: Context): String? = runCatching {
        val id = context.resources
            .getIdentifier("default_web_client_id", "string", context.packageName)
        if (id == 0) null else context.resources.getString(id).takeIf { it.isNotBlank() }
    }.getOrNull()

    /** Awaits the Google account picker; null when cancelled or no idToken. */
    private suspend fun awaitGoogleResult(
        activity: ComponentActivity,
        intent: Intent,
    ): String? = suspendCancellableCoroutine { cont ->
        runCatching {
            val launcher = activity.registerForActivityResult(
                ActivityResultContracts.StartActivityForResult(),
            ) { result ->
                val task = runCatching {
                    GoogleSignIn.getSignedInAccountFromIntent(result.data)
                }.getOrNull()
                if (task == null) {
                    if (cont.isActive) cont.resume(null)
                } else {
                    task.addOnSuccessListener { if (cont.isActive) cont.resume(it.idToken) }
                    task.addOnFailureListener { if (cont.isActive) cont.resume(null) }
                }
            }
            cont.invokeOnCancellation { runCatching { launcher.unregister() } }
            launcher.launch(intent)
        }.onFailure {
            if (cont.isActive) cont.resume(null)
        }
    }

    private suspend fun tokenOf(a: FirebaseAuth): String? = runCatching {
        val user = a.currentUser ?: return@runCatching null
        awaitTask(user.getIdToken(false))?.token
    }.getOrNull()

    private suspend fun <T> awaitTask(task: Task<T>): T = suspendCancellableCoroutine { cont ->
        task.addOnSuccessListener { cont.resume(it) }
        task.addOnFailureListener { cont.resumeWithException(it) }
    }
}
