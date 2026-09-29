//
//  AppSettingsStore.swift
//  Shared (App)
//
//  Cross-process settings for SafeSight.
//
//  The Safari extension stores its options in chrome.storage.local. The iOS and
//  macOS apps mirror the same options through the shared App Group container
//  (group.com.joshc.SafeSight); SafariWebExtensionHandler exposes a native
//  message bridge so the extension's background/popup can read and write these
//  same values and stay in sync with the app.
//
//  AccountStore owns the signed-in Google account and its per-account PIN:
//  the PIN is generated when the account is created, shown once during
//  onboarding, verified locally from a salted hash, and changeable in
//  Settings. PinStore guards anything that would weaken protection (pausing
//  filters, removing limited apps, loosening quiet hours, changing the PIN).
//

import Foundation
import Combine
import CryptoKit
import Security
#if canImport(FirebaseAuth)
import FirebaseAuth
#endif
#if canImport(FirebaseFirestore)
import FirebaseCore
import FirebaseFirestore
#endif

@MainActor
final class SharedSettings: ObservableObject {

    static let shared = SharedSettings()
    static let appGroupID = "group.com.joshc.SafeSight"

    private let defaults: UserDefaults
    private var didLoad = false

    // Mirror of the extension popup's options (chrome.storage.local keys).
    @Published var skinFilter = false {
        didSet { if didLoad { defaults.set(skinFilter, forKey: "skinFilter") } }
    }
    @Published var blurAll = false {
        didSet { if didLoad { defaults.set(blurAll, forKey: "blurAll") } }
    }
    @Published var sensitivity = 4 {
        didSet { if didLoad { defaults.set(sensitivity, forKey: "sensitivity") } }
    }
    @Published var blocklistUser: [String] = [] {
        didSet { if didLoad { defaults.set(blocklistUser, forKey: "blocklistUser") } }
    }
    @Published var scannedCount = 0 {
        didSet { if didLoad { defaults.set(scannedCount, forKey: "scannedCount") } }
    }
    @Published var blockedCount = 0 {
        didSet { if didLoad { defaults.set(blockedCount, forKey: "blockedCount") } }
    }

    // MARK: - Filters & quiet hours (enforced by the Safari extension)

    /// Master switch for web filtering. The extension checks this on every
    /// navigation; pausing it is PIN-gated in the app.
    @Published var filtersEnabled = true {
        didSet { if didLoad { defaults.set(filtersEnabled, forKey: "filtersEnabled") } }
    }
    /// Quiet hours on/off. Turning it off is PIN-gated ("loosen" action).
    @Published var quietEnabled = false {
        didSet { if didLoad { defaults.set(quietEnabled, forKey: "quietEnabled") } }
    }
    /// Quiet hours as "HH:mm" (device local time). Empty = no quiet hours.
    /// During the window the extension blocks all browsing, not just
    /// block-listed sites. The window may wrap midnight (22:00 – 06:00).
    @Published var quietStart = "" {
        didSet { if didLoad { defaults.set(quietStart, forKey: "quietStart") } }
    }
    @Published var quietEnd = "" {
        didSet { if didLoad { defaults.set(quietEnd, forKey: "quietEnd") } }
    }

    private init() {
        defaults = UserDefaults(suiteName: Self.appGroupID) ?? .standard
        reload()
        didLoad = true
    }

    func setSkinFilter(_ enabled: Bool) {
        skinFilter = enabled
        defaults.set(enabled, forKey: "skinFilter")
    }

    func reload() {
        skinFilter = defaults.bool(forKey: "skinFilter")
        blurAll = defaults.bool(forKey: "blurAll")
        sensitivity = defaults.object(forKey: "sensitivity") as? Int ?? 4
        blocklistUser = defaults.stringArray(forKey: "blocklistUser") ?? []
        scannedCount = max(0, defaults.integer(forKey: "scannedCount"))
        blockedCount = max(0, defaults.integer(forKey: "blockedCount"))
        filtersEnabled = defaults.object(forKey: "filtersEnabled") as? Bool ?? true
        quietEnabled = defaults.bool(forKey: "quietEnabled")
        quietStart = defaults.string(forKey: "quietStart") ?? ""
        quietEnd = defaults.string(forKey: "quietEnd") ?? ""
    }

    func refreshCounts() {
        scannedCount = max(0, defaults.integer(forKey: "scannedCount"))
        blockedCount = max(0, defaults.integer(forKey: "blockedCount"))
    }

    func resetStats() {
        defaults.set(0, forKey: "scannedCount")
        defaults.set(0, forKey: "blockedCount")
        scannedCount = 0
        blockedCount = 0
    }

    static func sensitivityLabel(_ value: Int) -> String {
        if value <= 3 { return "Relaxed (\(value))" }
        if value <= 6 { return "Standard (\(value))" }
        return "Strict (\(value))"
    }

    // MARK: - Quiet hours helpers

    /// True when `now` falls inside the quiet-hours window. Equal start/end,
    /// an empty window or a disabled switch means quiet hours are off.
    func isDuringQuietHours(now: Date = Date()) -> Bool {
        guard quietEnabled else { return false }
        return Self.isDuringQuietHours(start: quietStart, end: quietEnd, now: now)
    }

    static func isDuringQuietHours(start: String, end: String, now: Date = Date()) -> Bool {
        guard let s = minutes(start), let e = minutes(end), s != e else { return false }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let current = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        return s < e ? (current >= s && current < e) : (current >= s || current < e)
    }

    /// "HH:mm" -> minutes since midnight; anything unparseable is nil.
    static func minutes(_ value: String) -> Int? {
        let parts = value.split(separator: ":")
        guard parts.count == 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1]),
              (0...23).contains(hour),
              (0...59).contains(minute) else { return nil }
        return hour * 60 + minute
    }

    /// Minutes of the day inside the window (for "300 min/day" style copy).
    static func quietMinutes(start: String, end: String) -> Int? {
        guard let s = minutes(start), let e = minutes(end), s != e else { return nil }
        return s < e ? e - s : (24 * 60 - s) + e
    }
}

// MARK: - Per-account PIN

@MainActor
final class PinStore: ObservableObject {

    static let shared = PinStore()
    static let maxAttempts = 5
    static let lockoutSeconds: TimeInterval = 30

    private let defaults: UserDefaults
    private let pinHashKey = "pinHash"
    private let pinSaltKey = "pinSalt"
    private let failuresKey = "pinFailures"
    private let parentPinHashKey = "parentPinHash"
    private let parentPinSaltKey = "parentPinSalt"

    @Published private(set) var isSet: Bool
    /// Parent-controlled mode: on while a parent PIN exists. While on, the
    /// account PIN can't be changed and every PIN gate asks for the parent
    /// PIN. The parent PIN itself can't be changed either — only disabled
    /// (verified) and then re-created.
    @Published private(set) var parentModeEnabled: Bool
    @Published private(set) var failedAttempts = 0
    @Published private(set) var lockoutRemaining = 0
    private var lockTimer: Timer?

    private init() {
        defaults = UserDefaults(suiteName: SharedSettings.appGroupID) ?? .standard
        isSet = defaults.string(forKey: pinHashKey) != nil
        parentModeEnabled = defaults.string(forKey: parentPinHashKey) != nil
        failedAttempts = defaults.integer(forKey: failuresKey)
    }

    var isLockedOut: Bool { lockoutRemaining > 0 }

    static func isValidPIN(_ pin: String) -> Bool {
        pin.count == 4 && pin.allSatisfy { $0.isNumber }
    }

    /// Creates (or replaces) the PIN. Returns false if the PIN is invalid —
    /// or if parent mode is on (the account PIN can't be changed then).
    func setPIN(_ pin: String) -> Bool {
        guard Self.isValidPIN(pin), !parentModeEnabled else { return false }
        let salt = Self.randomSalt()
        defaults.set(Self.hash(pin, salt: salt), forKey: pinHashKey)
        defaults.set(salt, forKey: pinSaltKey)
        defaults.set(0, forKey: failuresKey)
        failedAttempts = 0
        stopLockoutTimer()
        isSet = true
        return true
    }

    /// The salt + hash to upload to the account document, if a PIN exists.
    var secrets: (salt: String, hash: String)? {
        guard isSet,
              let salt = defaults.string(forKey: pinSaltKey),
              let hash = defaults.string(forKey: pinHashKey) else { return nil }
        return (salt, hash)
    }

    /// Adopts the account's stored salt + hash (another device created the
    /// account, or this one restored it from Firestore).
    func adopt(salt: String, hash: String) {
        guard !hash.isEmpty else { return }
        defaults.set(hash, forKey: pinHashKey)
        defaults.set(salt, forKey: pinSaltKey)
        defaults.set(0, forKey: failuresKey)
        failedAttempts = 0
        stopLockoutTimer()
        isSet = true
    }

    /// Generates a fresh random 4-digit PIN, stores it locally and returns the
    /// plaintext once (for the onboarding / reset hand-off).
    @discardableResult
    func createNew() -> String? {
        let pin = (0..<4).map { _ in String(Int.random(in: 0...9)) }.joined()
        guard setPIN(pin) else { return nil }
        return pin
    }

    func changePIN(_ current: String, to new: String) -> Bool {
        guard verify(current) else { return false }
        return setPIN(new)
    }

    // MARK: Parent-controlled mode

    /// Sets the parent PIN and turns parent mode on. The parent PIN has its
    /// own hash and can never be changed directly — only replaced by
    /// disabling the mode and enabling it again with a new PIN.
    func setParentPIN(_ pin: String) -> Bool {
        guard Self.isValidPIN(pin) else { return false }
        let salt = Self.randomSalt()
        defaults.set(Self.hash(pin, salt: salt), forKey: parentPinHashKey)
        defaults.set(salt, forKey: parentPinSaltKey)
        defaults.set(0, forKey: failuresKey)
        failedAttempts = 0
        stopLockoutTimer()
        parentModeEnabled = true
        return true
    }

    /// Verifies the parent PIN. Shares the failed-attempt lockout with the
    /// account PIN (one lockout for the whole gate surface).
    @discardableResult
    func verifyParentPIN(_ pin: String) -> Bool {
        if isLockedOut { return false }
        guard parentModeEnabled,
              let salt = defaults.string(forKey: parentPinSaltKey),
              let stored = defaults.string(forKey: parentPinHashKey) else { return false }

        if Self.hash(pin, salt: salt) == stored {
            defaults.set(0, forKey: failuresKey)
            failedAttempts = 0
            stopLockoutTimer()
            return true
        }
        noteWrongPIN()
        return false
    }

    /// Turns parent mode off and forgets the parent PIN. Callers must have
    /// verified the parent PIN first (the PIN gate does this).
    func disableParentMode() {
        defaults.removeObject(forKey: parentPinHashKey)
        defaults.removeObject(forKey: parentPinSaltKey)
        parentModeEnabled = false
    }

    /// The parent salt + hash to upload to the account document, if parent
    /// mode is on.
    var parentSecrets: (salt: String, hash: String)? {
        guard parentModeEnabled,
              let salt = defaults.string(forKey: parentPinSaltKey),
              let hash = defaults.string(forKey: parentPinHashKey) else { return nil }
        return (salt, hash)
    }

    /// Adopts a parent PIN from the account document (another device enabled
    /// or rotated it). Only called when the remote hash exists — a missing
    /// remote value never clears a locally active parent mode (fail closed).
    func adoptParent(salt: String, hash: String) {
        guard !hash.isEmpty else { return }
        defaults.set(hash, forKey: parentPinHashKey)
        defaults.set(salt, forKey: parentPinSaltKey)
        parentModeEnabled = true
    }

    @discardableResult
    func verify(_ pin: String) -> Bool {
        if isLockedOut { return false }
        guard isSet,
              let salt = defaults.string(forKey: pinSaltKey),
              let stored = defaults.string(forKey: pinHashKey) else { return false }

        if Self.hash(pin, salt: salt) == stored {
            defaults.set(0, forKey: failuresKey)
            failedAttempts = 0
            stopLockoutTimer()
            return true
        }

        noteWrongPIN()
        return false
    }

    /// One shared wrong-PIN path: count the failure and start the lockout
    /// timer when the attempt limit is reached.
    private func noteWrongPIN() {
        failedAttempts += 1
        defaults.set(failedAttempts, forKey: failuresKey)
        if failedAttempts >= Self.maxAttempts {
            stopLockoutTimer()
            lockoutRemaining = Int(Self.lockoutSeconds)
            lockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.lockoutRemaining -= 1
                    if self.lockoutRemaining <= 0 {
                        self.stopLockoutTimer()
                        self.failedAttempts = 0
                        self.defaults.set(0, forKey: self.failuresKey)
                    }
                }
            }
        }
    }

    private func stopLockoutTimer() {
        lockTimer?.invalidate()
        lockTimer = nil
        lockoutRemaining = 0
    }

    private static func hash(_ pin: String, salt: String) -> String {
        let sha = SHA256.hash(data: Data((salt + pin).utf8))
        return sha.compactMap { String(format: "%02x", $0) }.joined()
    }

    private static func randomSalt() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Account (Google sign-in + per-account PIN)

/// The signed-in account: Google sign-in through Firebase Auth, profile and
/// PIN hash in `users/{uid}` in Firestore, profile mirrored into the app
/// group so the Safari extension bridge sees `accountReady`.
///
/// The PIN is generated when the account document is created and handed to
/// the onboarding screen exactly once (`pendingPIN`, persisted until the user
/// acknowledges it). It is never sent anywhere else — Firestore only ever
/// holds a salted SHA-256 hash.
@MainActor
final class AccountStore: ObservableObject {

    static let shared = AccountStore()

    @Published private(set) var isSignedIn = false
    @Published private(set) var email: String?
    @Published private(set) var name: String?
    @Published private(set) var picture: String?
    /// Plaintext PIN waiting to be shown to the user (onboarding or Settings).
    @Published private(set) var pendingPIN: String?
    /// True while sign-in / account bootstrap is running.
    @Published private(set) var isWorking = false
    /// True while the account document is being loaded/created on a cold
    /// start — the app shell shows a loader instead of flashing the tabs
    /// before the PIN hand-off state is known.
    @Published private(set) var isBootstrapping = false
    /// Non-nil when the last sign-in or account write failed.
    @Published var errorMessage: String?
    /// Set when the account document couldn't be written (offline / rules) —
    /// the PIN exists on this device but hasn't synced yet.
    @Published private(set) var syncPending = false

    private let defaults: UserDefaults

    private let emailKey = "unlockEmail"
    private let accountNameKey = "unlockAccountName"
    private let clientIdKey = "unlockClientId"
    private let pendingPINKey = "pendingPIN"
    private let pendingPINUidKey = "pendingPINUid"

    private init() {
        defaults = UserDefaults(suiteName: SharedSettings.appGroupID) ?? .standard
        email = defaults.string(forKey: emailKey)
        name = defaults.string(forKey: accountNameKey)
        #if canImport(FirebaseAuth)
        // FirebaseIdentity is behind the same guard: only the iOS target
        // compiles it (the macOS target doesn't link Firebase).
        isSignedIn = FirebaseIdentity.currentUid != nil
        if FirebaseIdentity.isConfigured {
            // Firebase restores the session from the keychain asynchronously
            // on some launches — follow its state so a cold start lands on the
            // right screen once the user is known.
            Auth.auth().addStateDidChangeListener { [weak self] _, user in
                Task { @MainActor in
                    guard let self else { return }
                    let signedIn = user != nil
                    if signedIn != self.isSignedIn {
                        self.isSignedIn = signedIn
                        if signedIn { await self.bootstrap() }
                    }
                }
            }
        }
        if isSignedIn {
            Task { await bootstrap() }
        }
        #else
        isSignedIn = false
        #endif
    }

    /// Completes sign-in: Google prompt, then load-or-create the account
    /// document and make sure a local PIN exists.
    func signIn() async -> Bool {
        #if canImport(FirebaseAuth)
        guard !isWorking else { return false }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }

        guard FirebaseIdentity.isConfigured else {
            errorMessage = "Firebase isn't configured on this build yet — add GoogleService-Info.plist first."
            return false
        }
        let ok = await FirebaseIdentity.signInWithGoogle()
        guard ok else {
            errorMessage = "Sign-in didn't complete. Check your connection and try again."
            return false
        }
        isSignedIn = true
        await bootstrap()
        return true
        #else
        errorMessage = "Google sign-in isn't available in this build."
        return false
        #endif
    }

    /// Re-authenticates with Google to mint a replacement PIN (forgot-PIN
    /// path). Returns the new plaintext PIN, or nil if it couldn't run.
    func resetPIN() async -> String? {
        guard !isWorking else { return nil }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        #if canImport(FirebaseAuth)
        if FirebaseIdentity.isConfigured {
            let ok = await FirebaseIdentity.signInWithGoogle()
            guard ok else {
                errorMessage = "Couldn't verify it's you — sign-in didn't complete."
                return nil
            }
            isSignedIn = true
        }
        #endif
        let pin = PinStore.shared.createNew()
        if let pin {
            pendingPIN = pin
            defaults.set(pin, forKey: pendingPINKey)
            #if canImport(FirebaseAuth)
            defaults.set(FirebaseIdentity.currentUid ?? "", forKey: pendingPINUidKey)
            #endif
            await uploadPIN()
        }
        return pin
    }

    func signOut() {
        #if canImport(FirebaseAuth)
        FirebaseIdentity.signOut()
        #endif
        isSignedIn = false
        errorMessage = nil
    }

    /// Called when the user taps through the PIN card: the plaintext is no
    /// longer needed (the hash stays on-device and in the account doc).
    func acknowledgePendingPIN() {
        pendingPIN = nil
        defaults.removeObject(forKey: pendingPINKey)
        defaults.removeObject(forKey: pendingPINUidKey)
    }

    // MARK: - Account document

    /// Loads `users/{uid}`; creates it (with a fresh PIN) when it's missing.
    /// Always safe to call — on sign-in and on every cold start.
    func bootstrap() async {
        isBootstrapping = true
        defer { isBootstrapping = false }
        #if canImport(FirebaseAuth)
        guard let uid = FirebaseIdentity.currentUid else {
            isSignedIn = false
            return
        }
        isSignedIn = true

        if let profile = FirebaseIdentity.currentProfile {
            publishProfile(email: profile.email, name: profile.name, picture: profile.picture)
        }
        defaults.set(uid, forKey: clientIdKey)

        // Restore a PIN hand-off left over from an interrupted onboarding.
        if let pending = defaults.string(forKey: pendingPINKey),
           defaults.string(forKey: pendingPINUidKey) == uid {
            pendingPIN = pending
        }

        #if canImport(FirebaseFirestore)
        guard FirebaseApp.app() != nil else {
            ensureLocalPIN(uid: uid)
            return
        }
        let ref = Firestore.firestore().collection("users").document(uid)
        do {
            // Server source: an offline read throws instead of reporting a
            // cached "missing" doc, which would mint a second, wrong PIN.
            let snapshot = try await ref.getDocument(source: .server)
            if snapshot.exists {
                let data = snapshot.data() ?? [:]
            if let salt = data["pinSalt"] as? String,
               let hash = data["pinHash"] as? String,
               !hash.isEmpty {
                PinStore.shared.adopt(salt: salt, hash: hash)
                syncPending = false
            } else {
                // Document exists without a PIN (or a legacy account):
                // mint one here and write it up.
                mintAndUpload(ref: ref, uid: uid)
            }

            // Parent PIN: adopt it whenever the account has one (another
            // device enabled/rotated it). A missing remote value never clears
            // an active local parent mode — the parent disables per device.
            if let pHash = data["parentPinHash"] as? String,
               !pHash.isEmpty,
               let pSalt = data["parentPinSalt"] as? String {
                PinStore.shared.adoptParent(salt: pSalt, hash: pHash)
            }
                var touch: [String: Any] = ["lastSeen": Date().timeIntervalSince1970]
                if let email = email { touch["email"] = email }
                if let name = name { touch["name"] = name }
                try? await ref.updateData(touch)
            } else {
                try await createAccountDocument(ref: ref, uid: uid)
            }
        } catch {
            // Offline or rules rejected the read: keep working locally.
            ensureLocalPIN(uid: uid)
            syncPending = true
        }
        #else
        ensureLocalPIN(uid: uid)
        #endif
        #else
        // No Firebase in this build: local-only mode with a device PIN.
        ensureLocalPIN(uid: nil)
        #endif
    }

    /// Makes sure this device has *some* local PIN to verify against, even
    /// when the account document can't be reached.
    private func ensureLocalPIN(uid: String?) {
        guard !PinStore.shared.isSet else { return }
        let pin = PinStore.shared.createNew()
        if let pin {
            pendingPIN = pin
            defaults.set(pin, forKey: pendingPINKey)
            defaults.set(uid ?? "", forKey: pendingPINUidKey)
            syncPending = true
        }
    }

    #if canImport(FirebaseAuth) && canImport(FirebaseFirestore)
    private func createAccountDocument(ref: DocumentReference, uid: String) async throws {
        let pin = PinStore.shared.createNew()
        guard let pin, let secrets = PinStore.shared.secrets else { return }
        var doc: [String: Any] = [
            "uid": uid,
            "role": "user",
            "pinHash": secrets.hash,
            "pinSalt": secrets.salt,
            "pinUpdatedAt": Date().timeIntervalSince1970,
            "createdAt": Date().timeIntervalSince1970,
            "lastSeen": Date().timeIntervalSince1970
        ]
        if let email { doc["email"] = email }
        if let name { doc["name"] = name }
        if let picture { doc["picture"] = picture }
        try await ref.setData(doc)
        pendingPIN = pin
        defaults.set(pin, forKey: pendingPINKey)
        defaults.set(uid, forKey: pendingPINUidKey)
        syncPending = false
    }

    private func mintAndUpload(ref: DocumentReference, uid: String) {
        let pin = PinStore.shared.createNew()
        guard let pin, let secrets = PinStore.shared.secrets else { return }
        pendingPIN = pin
        defaults.set(pin, forKey: pendingPINKey)
        defaults.set(uid, forKey: pendingPINUidKey)
        Task {
            do {
                try await ref.setData([
                    "pinHash": secrets.hash,
                    "pinSalt": secrets.salt,
                    "pinUpdatedAt": Date().timeIntervalSince1970
                ], merge: true)
                self.syncPending = false
            } catch {
                self.syncPending = true
            }
        }
    }
    #endif

    /// Uploads the current local PIN hash after a change or reset.
    func uploadPIN() async {
        #if canImport(FirebaseAuth) && canImport(FirebaseFirestore)
        guard FirebaseApp.app() != nil,
              let uid = FirebaseIdentity.currentUid,
              let secrets = PinStore.shared.secrets else { return }
        let ref = Firestore.firestore().collection("users").document(uid)
        do {
            try await ref.setData([
                "pinHash": secrets.hash,
                "pinSalt": secrets.salt,
                "pinUpdatedAt": Date().timeIntervalSince1970
            ], merge: true)
            syncPending = false
        } catch {
            syncPending = true
        }
        #endif
    }

    /// Syncs the parent PIN to the account document: enable/rotate writes the
    /// hash, disable deletes the fields. Local state is authoritative if the
    /// write fails — parent mode never turns itself off on a network error.
    func syncParentPIN(enabled: Bool) async {
        #if canImport(FirebaseAuth) && canImport(FirebaseFirestore)
        guard FirebaseApp.app() != nil, let uid = FirebaseIdentity.currentUid else { return }
        let ref = Firestore.firestore().collection("users").document(uid)
        do {
            if enabled, let secrets = PinStore.shared.parentSecrets {
                try await ref.setData([
                    "parentPinHash": secrets.hash,
                    "parentPinSalt": secrets.salt,
                    "parentPinUpdatedAt": Date().timeIntervalSince1970
                ], merge: true)
            } else {
                try await ref.updateData([
                    "parentPinHash": FieldValue.delete(),
                    "parentPinSalt": FieldValue.delete(),
                    "parentPinUpdatedAt": FieldValue.delete()
                ])
            }
        } catch {
            // Stay local; the next successful sync can catch up.
        }
        #endif
    }

    /// Changes the PIN: verifies the current one locally, then re-hashes and
    /// uploads. Returns false when the current PIN is wrong.
    func changePIN(current: String, new: String) async -> Bool {
        guard PinStore.shared.changePIN(current, to: new) else { return false }
        await uploadPIN()
        return true
    }

    /// Mirrors the profile into the app group keys the extension bridge reads
    /// (`accountReady` requires both keys, so the name always gets a value —
    /// a Google account with no display name falls back to the email prefix).
    private func publishProfile(email: String?, name: String?, picture: String?) {
        if let email, !email.isEmpty {
            self.email = email
            defaults.set(email, forKey: emailKey)
        }
        let displayName: String? = {
            if let name, !name.isEmpty { return name }
            if let email, let prefix = email.split(separator: "@").first, !prefix.isEmpty {
                return String(prefix)
            }
            return nil
        }()
        if let displayName {
            self.name = displayName
            defaults.set(displayName, forKey: accountNameKey)
        }
        if let picture {
            self.picture = picture
        }
    }
}
