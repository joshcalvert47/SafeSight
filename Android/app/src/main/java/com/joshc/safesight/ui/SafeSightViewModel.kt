package com.joshc.safesight.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.joshc.safesight.R
import com.joshc.safesight.block.AppBlocklistRepository
import com.joshc.safesight.block.BlocklistRepository
import com.joshc.safesight.data.SettingsStore
import com.joshc.safesight.ml.NsfwClassifier
import com.joshc.safesight.net.DeviceApi
import com.joshc.safesight.net.FirebaseIdentity
import com.joshc.safesight.net.ParentApi
import com.joshc.safesight.net.WorkerClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SafeSightViewModel(app: Application) : AndroidViewModel(app) {

    val store = SettingsStore(app)

    /** Shared by every WebView bridge; loads nsfw.tflite on first analysis. */
    val classifier by lazy { NsfwClassifier(app) }

    val blocklist = BlocklistRepository(app, store)
    val appBlocklist = AppBlocklistRepository(app, store)

    init {
        // Shipped defaults from blocklist_apps.json are blocked as soon as the
        // app runs — no manual picking, and removals are remembered.
        launch { appBlocklist.syncDefaults() }
        // An account registered before the admin approved it stays locked:
        // keep polling until the approval lands.
        launch { pollAccountApprovalIfPending() }
        // Paired + not parent mode: follow the parent's policy live (a one-shot
        // pull only happened at pairing time, so this is what carries edits).
        launch {
            combine(store.pairedChildId, store.parentMode) { childId, parent ->
                (childId ?: "") to (parent == true)
            }.collect { (childId, isParent) ->
                if (childId.isNotEmpty() && !isParent) startPolicyListener(childId)
                else stopPolicyListener()
            }
        }
    }

    val account = store.account
    val accountReady = store.accountReady
    val pairedChildId = store.pairedChildId
    val childName = store.childName
    val accountEmail = store.accountEmail
    val accountName = store.accountName
    val accountStatus = store.accountStatus
    val skinFilter = store.skinFilter
    val blurAll = store.blurAll
    val sensitivity = store.sensitivity
    val blockedApps = store.blockedApps
    val blockedAppsRemoved = store.blockedAppsRemoved
    val scannedCount = store.scannedCount
    val blockedCount = store.blockedCount

    sealed class RegisterState {
        data object Idle : RegisterState()
        data object Loading : RegisterState()
        data class Error(val message: String, val canRequestDevice: Boolean = false) : RegisterState()
        /** New account: the PIN is shown exactly once, like the extension popup. */
        data class Created(val pin: String) : RegisterState()
        /** Existing device or joined device: PIN already exists elsewhere. */
        data object Joined : RegisterState()
        /** device_limit hit: request filed, polling the worker for approval. */
        data class DeviceRequested(val ticket: Long) : RegisterState()
        /** Registered with an invite, waiting for the admin to approve it. */
        data object Pending : RegisterState()
    }

    private val _registerState = MutableStateFlow<RegisterState>(RegisterState.Idle)
    val registerState: StateFlow<RegisterState> = _registerState

    /** One-shot notice when a pending account is approved (PIN included). */
    private val _approvalNotice = MutableStateFlow<String?>(null)
    val approvalNotice: StateFlow<String?> = _approvalNotice

    fun dismissApprovalNotice() {
        _approvalNotice.value = null
    }

    sealed class PairState {
        data object Idle : PairState()
        data object Loading : PairState()

        /** Redeemed — the child name is known, the policy pull is still running. */
        data class Linked(val childName: String?) : PairState()

        data object Ready : PairState()
        data class Error(val message: String, val canFinish: Boolean) : PairState()
    }

    private data class PendingPair(
        val familyId: String,
        val childId: String,
        val childName: String,
    )

    private val _pairState = MutableStateFlow<PairState>(PairState.Idle)
    val pairState: StateFlow<PairState> = _pairState
    private var pendingPair: PendingPair? = null

    fun pairWithCode(code: String) {
        if (_pairState.value is PairState.Loading) return
        _pairState.value = PairState.Loading
        viewModelScope.launch { doPair(code.trim().uppercase()) }
    }

    fun retryPolicy() {
        if (_pairState.value is PairState.Loading || pendingPair == null) return
        _pairState.value = PairState.Linked(pendingPair?.childName)
        viewModelScope.launch { syncPolicy() }
    }

    fun finishPairing() {
        if (pendingPair == null || _pairState.value is PairState.Loading) return
        viewModelScope.launch { completePairing() }
    }

    fun resetPairState() {
        _pairState.value = PairState.Idle
    }

    private suspend fun doPair(code: String) {
        when (
            val result = DeviceApi.redeem(
                code = code,
                device = deviceLabel(),
                version = appVersion(),
                platform = "android",
                deviceId = store.deviceId(),
            )
        ) {
            is DeviceApi.RedeemResult.Success -> {
                pendingPair = PendingPair(
                    familyId = result.familyId,
                    childId = result.childId,
                    childName = result.childName ?: "",
                )
                _pairState.value = PairState.Linked(result.childName)
                syncPolicy()
            }

            is DeviceApi.RedeemResult.Failure ->
                _pairState.value = PairState.Error(redeemError(result.error), canFinish = false)

            is DeviceApi.RedeemResult.Network ->
                _pairState.value = PairState.Error(
                    "Could not reach the SafeSight server — try again later.",
                    canFinish = false,
                )
        }
    }

    private suspend fun syncPolicy() {
        when (val result = DeviceApi.policy(store)) {
            is DeviceApi.PolicyResult.Success -> completePairing()

            is DeviceApi.PolicyResult.Failure ->
                _pairState.value = PairState.Error(policyError(result.error), canFinish = true)

            is DeviceApi.PolicyResult.Network ->
                _pairState.value = PairState.Error(
                    "Paired, but the policy could not be synced — check the connection.",
                    canFinish = true,
                )
        }
    }

    private suspend fun completePairing() {
        val pending = pendingPair ?: return
        store.setPaired(pending.familyId, pending.childId, pending.childName)
        pendingPair = null
        _pairState.value = PairState.Ready
    }

    private fun redeemError(error: String): String = when (error) {
        "invalid_code" -> "That pairing code is expired or already used — ask for a new one."
        "device_already_paired" ->
            "This device is already paired — unpair it from the parent dashboard first."

        "rate_limited" -> "Too many attempts from this network — try again in a few minutes."
        "not_signed_in" -> "Device sign-in is unavailable — check that Firebase is set up."
        "unauthorized" -> "Device sign-in was rejected — check that Firebase is set up."
        else -> "Pairing failed ($error)."
    }

    private fun policyError(error: String): String = when (error) {
        "unknown_child" -> "This child profile no longer exists — ask for a new pairing code."
        "not_signed_in" -> "Device sign-in is unavailable — check that Firebase is set up."
        "unauthorized" -> "Device sign-in was rejected — check that Firebase is set up."
        else -> "The policy could not be loaded ($error)."
    }

    // ---------------- parent mode (Google) ----------------

    /** Null until DataStore answers, so the root never flashes the wrong screen. */
    val parentMode: StateFlow<Boolean?> = store.parentMode
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    sealed class ParentState {
        data object Loading : ParentState()
        data class Ready(val me: ParentApi.Me) : ParentState()

        /** Flag cleared — the root falls back to the pairing screen. */
        data object Unauthorized : ParentState()

        data class Error(val message: String) : ParentState()
    }

    private val _parentState = MutableStateFlow<ParentState>(ParentState.Loading)
    val parentState: StateFlow<ParentState> = _parentState

    private val _parentBusy = MutableStateFlow(false)
    val parentBusy: StateFlow<Boolean> = _parentBusy

    private val _parentError = MutableStateFlow<String?>(null)
    val parentError: StateFlow<String?> = _parentError

    /** Explains why a saved parent session was dropped on launch. */
    private val _parentNotice = MutableStateFlow<String?>(null)
    val parentNotice: StateFlow<String?> = _parentNotice

    private val _pairCode = MutableStateFlow<ParentApi.PairCode?>(null)
    val pairCode: StateFlow<ParentApi.PairCode?> = _pairCode

    /** Pending unlock requests by childId, kept live by the family listener. */
    private val _pendingUnlocks =
        MutableStateFlow<Map<String, List<ParentApi.UnlockRequest>>>(emptyMap())
    val pendingUnlocks: StateFlow<Map<String, List<ParentApi.UnlockRequest>>> = _pendingUnlocks

    private var unlockStop: (() -> Unit)? = null
    private val seenUnlockIds = mutableSetOf<String>()

    /** True once the live listener owns pendingUnlocks (me() is only a seed). */
    private val _unlockListenerActive = MutableStateFlow(false)
    val unlockListenerActive: StateFlow<Boolean> = _unlockListenerActive

    fun enterParentMode() {
        _parentNotice.value = null
        viewModelScope.launch {
            store.setParentMode(true)
            verifyParent()
        }
    }

    /** Loads users/{uid} + the family — a rejected session drops back to pairing. */
    fun verifyParent() {
        if (!FirebaseIdentity.hasGoogleUser) {
            exitParentMode("Google sign-in is no longer available on this device.")
            return
        }
        _parentState.value = ParentState.Loading
        viewModelScope.launch {
            when (val r = ParentApi.me()) {
                is ParentApi.MeResult.Success -> {
                    startUnlockListener(r.me.familyId)
                    _parentState.value = ParentState.Ready(r.me)
                }

                ParentApi.MeResult.Unauthorized ->
                    exitParentMode("Your parent session expired — sign in again.")

                is ParentApi.MeResult.Network ->
                    // Offline: Firestore serves the last cached family, so only
                    // keep the dashboard in its retryable error state.
                    _parentState.value = ParentState.Error(
                        "Could not load your family — check your connection.",
                    )

                is ParentApi.MeResult.Failure ->
                    _parentState.value = ParentState.Error(
                        "Could not load the family (${r.error}).",
                    )
            }
        }
    }

    fun refreshParent() = verifyParent()

    private fun exitParentMode(message: String?) {
        _parentNotice.value = message
        _pairCode.value = null
        stopUnlockListener()
        _parentState.value = ParentState.Unauthorized
        viewModelScope.launch { store.setParentMode(false) }
    }

    private fun startUnlockListener(familyId: String) {
        if (familyId.isEmpty()) return
        stopUnlockListener()
        unlockStop = ParentApi.listenUnlockRequests(familyId) { requests ->
            _pendingUnlocks.value = requests.groupBy { it.childId }
            // First sight of a pending id → local notification (the flow keeps
            // the dashboard current while it's open; this covers background).
            requests.forEach { if (seenUnlockIds.add(it.id)) notifyUnlockRequest(it) }
        }
        _unlockListenerActive.value = unlockStop != null
    }

    private fun stopUnlockListener() {
        unlockStop?.invoke()
        unlockStop = null
        _unlockListenerActive.value = false
        _pendingUnlocks.value = emptyMap()
    }

    private fun notifyUnlockRequest(request: ParentApi.UnlockRequest) {
        val app = getApplication<Application>()
        if (Build.VERSION.SDK_INT >= 33 &&
            app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val manager = app.getSystemService(android.app.NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                android.app.NotificationChannel(
                    UNLOCK_CHANNEL_ID,
                    "Unlock requests",
                    android.app.NotificationManager.IMPORTANCE_HIGH,
                ),
            )
        }
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)?.apply {
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pendingIntent = android.app.PendingIntent.getActivity(
            app,
            request.id.hashCode(),
            intent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val text = listOfNotNull(
            request.detail.ifEmpty { null },
            request.device.ifEmpty { null },
        ).joinToString(" · ").ifEmpty { "Tap to review and decide." }
        manager.notify(
            request.id.hashCode(),
            androidx.core.app.NotificationCompat.Builder(app, UNLOCK_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Unlock request: ${request.action}")
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .build(),
        )
    }

    fun signOutParent() {
        FirebaseIdentity.signOut()
        exitParentMode(null)
    }

    fun clearParentNotice() {
        _parentNotice.value = null
    }

    fun clearPairCode() {
        _pairCode.value = null
    }

    fun addChild(name: String, ageBand: String) = parentOp {
        ParentApi.saveChild(id = null, name = name, ageBand = ageBand)
    }

    fun deleteChild(id: String) = parentOp { ParentApi.deleteChild(id) }

    fun decideUnlock(id: String, decision: String) =
        parentOp { ParentApi.unlockDecide(id, decision) }

    fun deleteDevice(uid: String) = parentOp { ParentApi.deleteDevice(uid) }

    fun saveChildPolicy(childId: String, policy: Map<String, Any?>) = parentOp {
        ParentApi.updatePolicy(childId, policy)
    }

    // ---------------- device unlock requests ----------------

    sealed class UnlockState {
        data object Idle : UnlockState()
        data object Asking : UnlockState()
        data object Approved : UnlockState()
        data object Denied : UnlockState()

        /** No decision within 30s — the snapshot listener is dropped. */
        data object TimedOut : UnlockState()

        data class Failed(val message: String) : UnlockState()
    }

    private val _unlockState = MutableStateFlow<UnlockState>(UnlockState.Idle)
    val unlockState: StateFlow<UnlockState> = _unlockState

    /**
     * Files an unlockRequests/{id} document and waits for the parent's
     * decision on a Firestore snapshot listener (no status polling).
     */
    fun requestUnlock(action: String, detail: String = "") {
        if (_unlockState.value is UnlockState.Asking) return
        _unlockState.value = UnlockState.Asking
        viewModelScope.launch {
            val id = DeviceApi.unlockRequest(action, detail)
            if (id == null) {
                _unlockState.value =
                    UnlockState.Failed("This device is not paired with a child profile yet.")
                return@launch
            }
            _unlockState.value = when (val status = DeviceApi.awaitUnlockStatus(id)) {
                "approved" -> UnlockState.Approved
                "denied" -> UnlockState.Denied
                "timeout" -> UnlockState.TimedOut
                else -> UnlockState.Failed("The unlock request was not answered ($status).")
            }
        }
    }

    fun resetUnlockState() {
        _unlockState.value = UnlockState.Idle
    }

    // ---------------- child: live policy + ask-parent ----------------

    /** True while this install follows a parent's policy (paired, not parent mode). */
    val parentManaged: StateFlow<Boolean> = combine(
        store.pairedChildId,
        store.parentMode,
    ) { childId, parent -> !(childId ?: "").isEmpty() && parent != true }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    sealed class AskState {
        data object Idle : AskState()
        data object Waiting : AskState()

        /** Approved — the filter controls are editable until the grace ends. */
        data object Approved : AskState()
        data class Denied(val message: String) : AskState()
        data class Failed(val message: String) : AskState()
    }

    private val _askState = MutableStateFlow<AskState>(AskState.Idle)
    val askState: StateFlow<AskState> = _askState

    private val _policyEditingAllowed = MutableStateFlow(false)
    val policyEditingAllowed: StateFlow<Boolean> = _policyEditingAllowed

    private var askJob: Job? = null
    private var graceJob: Job? = null

    /**
     * While the parent owns the filter settings, editing means asking:
     * unlockRequests/{id} + snapshot wait (5 min, same as iOS), then a
     * 10-minute grace window on approval.
     */
    fun askToChangePolicy(action: String, detail: String = "") {
        if (_askState.value is AskState.Waiting) return
        _askState.value = AskState.Waiting
        askJob = viewModelScope.launch {
            val id = DeviceApi.unlockRequest(action, detail)
            if (id == null) {
                _askState.value = AskState.Failed("This device is not paired with a child profile yet.")
                return@launch
            }
            _askState.value = when (DeviceApi.awaitUnlockStatus(id, timeoutMs = 300_000)) {
                "approved" -> {
                    openPolicyGraceWindow()
                    AskState.Approved
                }

                "denied" -> AskState.Denied("Your parent declined the request.")
                "timeout" -> AskState.Failed("No answer within 5 minutes — ask again.")
                else -> AskState.Failed("The request could not be answered — ask again.")
            }
        }
    }

    /** Drop a pending ask (cancels the snapshot listener). */
    fun cancelAsk() {
        if (_askState.value is AskState.Waiting) {
            askJob?.cancel()
            _askState.value = AskState.Idle
        }
    }

    fun dismissAsk() {
        if (_askState.value !is AskState.Waiting) _askState.value = AskState.Idle
    }

    private fun openPolicyGraceWindow() {
        _policyEditingAllowed.value = true
        graceJob?.cancel()
        graceJob = viewModelScope.launch {
            delay(GRACE_WINDOW_MS)
            _policyEditingAllowed.value = false
        }
    }

    private var policyStop: (() -> Unit)? = null
    private var policyChildId: String? = null

    private fun startPolicyListener(childId: String) {
        if (policyChildId == childId && policyStop != null) return
        stopPolicyListener()
        policyChildId = childId
        policyStop = DeviceApi.listenPolicy(childId) { raw ->
            viewModelScope.launch { store.savePolicy(raw) }
        }
    }

    private fun stopPolicyListener() {
        policyStop?.invoke()
        policyStop = null
        policyChildId = null
    }

    fun requestPairCode(childId: String) {
        if (_parentBusy.value) return
        _parentBusy.value = true
        _parentError.value = null
        viewModelScope.launch {
            when (val r = ParentApi.createPairingCode(childId)) {
                is ParentApi.PairResult.Success -> _pairCode.value = r.pairCode
                is ParentApi.PairResult.Failure -> _parentError.value = opError(r.error)
                is ParentApi.PairResult.Network ->
                    _parentError.value = "Could not reach Firebase — try again."
            }
            _parentBusy.value = false
        }
    }

    private fun parentOp(op: suspend () -> ParentApi.OpResult) {
        if (_parentBusy.value) return
        _parentBusy.value = true
        _parentError.value = null
        viewModelScope.launch {
            when (val r = op()) {
                ParentApi.OpResult.Ok -> reloadParent()
                is ParentApi.OpResult.Failure -> _parentError.value = opError(r.error)
                is ParentApi.OpResult.Network ->
                    _parentError.value = "Could not reach Firebase — try again."
            }
            _parentBusy.value = false
        }
    }

    private suspend fun reloadParent() {
        when (val r = ParentApi.me()) {
            is ParentApi.MeResult.Success -> _parentState.value = ParentState.Ready(r.me)
            ParentApi.MeResult.Unauthorized -> _parentError.value = opError("unauthorized")
            is ParentApi.MeResult.Network ->
                _parentError.value = "Could not reach Firebase — try again."
            is ParentApi.MeResult.Failure -> _parentError.value = opError(r.error)
        }
    }

    private fun opError(error: String): String = when (error) {
        "not_signed_in", "unauthorized" -> "Your session expired — sign in again."
        "name_required" -> "A name is required."
        "unknown_child" -> "That child profile no longer exists."
        "unknown_device" -> "That device is no longer paired."
        "unknown_request" -> "That unlock request is no longer pending."
        "not_found" -> "That item no longer exists."
        "no_family" -> "This account has no family — sign out and sign in again."
        else -> "That did not work ($error)."
    }

    // Kept for retries and /api/device-request after a device_limit failure.
    private var lastEmail = ""
    private var lastAccountName = ""
    private var lastInvite = ""

    sealed class GuardOutcome {
        data object Granted : GuardOutcome()
        data class Denied(val message: String) : GuardOutcome()
    }

    fun register(accountName: String, email: String, invite: String = lastInvite) {
        if (_registerState.value is RegisterState.Loading) return
        lastEmail = email.trim().lowercase()
        lastAccountName = accountName.trim()
        lastInvite = invite.trim()
        _registerState.value = RegisterState.Loading
        viewModelScope.launch { doRegister() }
    }

    private suspend fun doRegister() {
        val wasRequesting = _registerState.value is RegisterState.DeviceRequested
        val result = WorkerClient.register(
            email = lastEmail,
            accountName = lastAccountName,
            invite = lastInvite,
            deviceId = store.deviceId(),
            device = deviceLabel(),
            version = appVersion(),
            ua = (System.getProperty("http.agent") ?: "SafeSight").take(160),
        )
        // Still at the limit (or briefly offline) while an approval is pending:
        // keep the waiting state so pollForApproval() keeps trying.
        if (wasRequesting && (
                (result is WorkerClient.RegisterResult.Failure && result.error == "device_limit") ||
                    result is WorkerClient.RegisterResult.Network
                )
        ) {
            return
        }
        _registerState.value = when (result) {
            is WorkerClient.RegisterResult.Success -> {
                store.setRegistered(
                    clientId = result.clientId,
                    deviceId = store.deviceId(),
                    email = result.email,
                    accountName = result.accountName,
                    status = result.status,
                )
                when {
                    result.status != "approved" -> RegisterState.Pending
                    result.pin != null -> RegisterState.Created(result.pin)
                    else -> RegisterState.Joined
                }
            }

            is WorkerClient.RegisterResult.Failure -> when (result.error) {
                "invalid_email" -> RegisterState.Error("That doesn't look like an email address — try again.")
                "account_name_required" -> RegisterState.Error("An account name is required.")
                "account_name_mismatch" -> RegisterState.Error("That account name does not match the existing account.")
                "invite_required" -> RegisterState.Error(
                    "An invite code is required to create an account.\n\n" +
                        "Ask the SafeSight admin for a code, then try again.",
                )

                "rate_limited" -> RegisterState.Error(
                    "Too many attempts from this network — try again in a few minutes.",
                )

                "device_limit" -> RegisterState.Error(
                    "That email already has ${result.deviceLimit} devices.\n\n" +
                        "Request another device below — the account admin approves it " +
                        "in the SafeSight console — or register with a different email.",
                    canRequestDevice = true,
                )

                else -> RegisterState.Error("Registration failed (${result.error}).")
            }

            is WorkerClient.RegisterResult.Network ->
                RegisterState.Error("Could not reach the SafeSight server — try again later.")
        }
        if (_registerState.value is RegisterState.Pending) pollAccountApproval()
    }

    /**
     * Post a device slot request, then poll /api/register until the admin
     * approves it (approval raises deviceLimit, so the next attempt succeeds).
     */
    fun requestDevice() {
        if (lastEmail.isEmpty()) return
        val current = _registerState.value
        if (current is RegisterState.DeviceRequested || current is RegisterState.Loading) return
        _registerState.value = RegisterState.Loading
        viewModelScope.launch {
            when (
                val r = WorkerClient.deviceRequest(
                    email = lastEmail,
                    deviceId = store.deviceId(),
                    device = deviceLabel(),
                    version = appVersion(),
                )
            ) {
                is WorkerClient.DeviceRequestResult.Ok -> {
                    if (r.alreadyAvailable) {
                        doRegister()
                    } else {
                        _registerState.value = RegisterState.DeviceRequested(r.ticket)
                        pollForApproval()
                    }
                }

                is WorkerClient.DeviceRequestResult.Failure ->
                    _registerState.value = RegisterState.Error(
                        if (r.error == "unknown_account") {
                            "No account with that email — create it first."
                        } else {
                            "Could not send the device request (${r.error})."
                        },
                        canRequestDevice = true,
                    )

                is WorkerClient.DeviceRequestResult.Network ->
                    _registerState.value = RegisterState.Error(
                        "Could not reach the SafeSight server — try again later.",
                        canRequestDevice = true,
                    )
            }
        }
    }

    private suspend fun pollForApproval() {
        kotlinx.coroutines.delay(5_000)
        while (_registerState.value is RegisterState.DeviceRequested) {
            doRegister()
            if (_registerState.value !is RegisterState.DeviceRequested) break
            kotlinx.coroutines.delay(5_000)
        }
    }

    /**
     * Polls /api/account-status while the account is pending approval. The
     * worker only reveals the PIN once the admin approves, so that's when the
     * notice (and the unlocked state) appears.
     */
    private suspend fun pollAccountApproval() {
        kotlinx.coroutines.delay(5_000)
        while (store.accountStatus.first() == "pending") {
            val acct = store.account.first() ?: break
            val result = WorkerClient.accountStatus(acct.clientId)
            if (result != null && result.first == "approved") {
                store.setAccountStatus("approved")
                _approvalNotice.value = result.second?.let {
                    "Approved by the admin.\n\nYour SafeSight PIN is: $it"
                } ?: "Approved by the admin."
                if (_registerState.value is RegisterState.Pending) {
                    _registerState.value = result.second?.let { RegisterState.Created(it) }
                        ?: RegisterState.Joined
                }
                return
            }
            kotlinx.coroutines.delay(5_000)
        }
    }

    /** Starts the approval poll for an account that registered as pending. */
    fun pollAccountApprovalIfPending() {
        viewModelScope.launch {
            if (store.accountStatus.first() == "pending") pollAccountApproval()
        }
    }

    fun resetRegisterState() {
        _registerState.value = RegisterState.Idle
    }

    /** Same contract as guardDestructive() in chrome/popup.js. */
    suspend fun guardDestructive(action: String, pin: String): GuardOutcome {
        val acct = store.account.first()
        if (acct == null) {
            // Registration happens before any destructive setting exists.
            return GuardOutcome.Denied("Registration is required first.")
        }
        if (store.accountStatus.first() != "approved") return accountPending()
        return when (val result = WorkerClient.verify(acct.clientId, pin.trim(), action)) {
            WorkerClient.VerifyResult.Ok -> GuardOutcome.Granted

            WorkerClient.VerifyResult.AccountPending -> accountPending()

            is WorkerClient.VerifyResult.WrongPin ->
                if (result.locked) {
                    val minutes = (result.retrySeconds + 59) / 60
                    GuardOutcome.Denied("Too many attempts — locked for $minutes min.")
                } else {
                    GuardOutcome.Denied("Incorrect PIN.")
                }

            WorkerClient.VerifyResult.UnknownClient ->
                GuardOutcome.Denied("This device is not registered.")

            is WorkerClient.VerifyResult.Network ->
                GuardOutcome.Denied("Could not reach the SafeSight server — try again later.")
        }
    }

    private fun accountPending(): GuardOutcome = GuardOutcome.Denied(
        "Locked: this account is waiting for admin approval.\n\n" +
            "Nothing that weakens SafeSight can change until the admin approves it.",
    )

    /** True while the account awaits admin approval — nothing may be weakened. */
    suspend fun isAccountPending(): Boolean = store.accountStatus.first() != "approved"

    suspend fun setSkinFilter(value: Boolean) = store.setSkinFilter(value)
    suspend fun setBlurAll(value: Boolean) = store.setBlurAll(value)
    suspend fun setSensitivity(value: Int) = store.setSensitivity(value)
    suspend fun resetStats() = store.resetStats()

    sealed class AddSiteResult {
        data object Added : AddSiteResult()
        data object AlreadyBlocked : AddSiteResult()
        data object Invalid : AddSiteResult()
    }

    /** addBlockSite() from chrome/popup.js — no PIN needed to add. */
    suspend fun addBlockSite(raw: String): AddSiteResult {
        val site = BlocklistRepository.normalizeSite(raw)
            ?: return AddSiteResult.Invalid
        val effective = blocklist.effective.first()
        val coveredByDefault = effective.any { site == it || site.endsWith(".$it") }
        if (coveredByDefault) return AddSiteResult.AlreadyBlocked
        store.setBlocklistUser((store.blocklistUser.first() + site).distinct())
        return AddSiteResult.Added
    }

    /** Removing a default site is destructive and PIN-guarded in the extension. */
    suspend fun removeBlockSite(site: String) {
        if (site in blocklist.defaults()) {
            store.setBlocklistRemoved((store.blocklistRemoved.first() + site).distinct())
        } else {
            store.setBlocklistUser(store.blocklistUser.first() - site)
        }
    }

    /** Adding an app to the blocklist is free; removing it is PIN-guarded. */
    suspend fun addBlockedApp(pkg: String) {
        // Blocking a shipped default the user previously removed undoes that
        // removal — otherwise the next sync would strip it again.
        store.setBlockedAppsRemoved(store.blockedAppsRemoved.first() - pkg)
        store.setBlockedApps((store.blockedApps.first() + pkg).distinct())
    }

    suspend fun removeBlockedApp(pkg: String) {
        if (appBlocklist.isDefaultPackage(pkg)) {
            store.setBlockedAppsRemoved((store.blockedAppsRemoved.first() + pkg).distinct())
        }
        store.setBlockedApps(store.blockedApps.first() - pkg)
    }

    fun launch(block: suspend SafeSightViewModel.() -> Unit) {
        viewModelScope.launch { block(this@SafeSightViewModel) }
    }

    override fun onCleared() {
        unlockStop?.invoke()
        unlockStop = null
        policyStop?.invoke()
        policyStop = null
        askJob?.cancel()
        graceJob?.cancel()
        super.onCleared()
    }

    private fun deviceLabel(): String = "Android / ${Build.MANUFACTURER} ${Build.MODEL}"

    private fun appVersion(): String = runCatching {
        getApplication<Application>().packageManager
            .getPackageInfo(getApplication<Application>().packageName, 0).versionName ?: "1.0"
    }.getOrDefault("1.0")

    companion object {
        private const val UNLOCK_CHANNEL_ID = "unlock_requests"

        /** Approval window for parent-managed filter controls (iOS parity). */
        private const val GRACE_WINDOW_MS = 10 * 60 * 1000L

        fun sensitivityLabel(value: Int): String = when {
            value <= 3 -> "Relaxed ($value)"
            value <= 6 -> "Standard ($value)"
            else -> "Strict ($value)"
        }
    }
}
