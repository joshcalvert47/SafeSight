//
//  ScreenTimeBlocker.swift
//  Shared (App)
//
//  Screen Time (Family Controls / Managed Settings) app blocking: requesting
//  the Family Controls authorization, remembering the user's FamilyActivity
//  selection, and applying / clearing the shield.
//
//  Notes:
//  - The Screen Time API is only available for native iOS/iPadOS apps. The
//    macOS target compiles this file empty (everything is #if os(iOS)).
//  - Before distributing you must request the Family Controls entitlement:
//    https://developer.apple.com/contact/request/family-controls-distribution
//  - Tokens only come from FamilyActivityPicker — blocklist_apps.json can
//    suggest names but can never mint a token (see AppBlocklist.swift).
//

import Foundation
import Combine

#if os(iOS)
import FamilyControls
import ManagedSettings

/// The authorization state of SafeSight to manage Screen Time on the device.
/// Kept as a Swift-facing enum so the UI layer never needs to know the
/// platform-specific `AuthorizationCenter` types.
enum ScreenTimeAuthorizationState: Equatable {
    case notDetermined
    case approved
    case denied
}

/// Owns the Screen Time state for app blocking: authorization, the chosen
/// selection, and the always-on shield.
@MainActor
final class ScreenTimeBlocker: ObservableObject {

    static let shared = ScreenTimeBlocker()

    @Published private(set) var authorizationState: ScreenTimeAuthorizationState = .notDetermined
    @Published private(set) var isBlocking = false
    /// True while the system Screen Time authorization prompt is in flight.
    /// Duplicate taps are coalesced so requests can't stack up and hang.
    @Published private(set) var isRequestingAuthorization = false

    @Published var selection = FamilyActivitySelection() {
        didSet {
            guard didLoad else { return }
            persistSelection()
            if isBlocking { applyShield() }
        }
    }

    private let store = ManagedSettingsStore()
    private let defaults: UserDefaults
    private let selectionKey = "blockedSelection"
    private let enabledKey = "blockingEnabled"
    private var authorizationTask: Task<Void, Never>?
    private var didLoad = false

    private init() {
        defaults = UserDefaults(suiteName: SharedSettings.appGroupID) ?? .standard
        authorizationState = ScreenTimeBlocker.map(AuthorizationCenter.shared.authorizationStatus)
        restorePersistedState()
        didLoad = true
        // Managed settings are durable, but re-apply on launch so a shield set
        // while unauthorized (or a cleared store) comes back.
        if isBlocking && hasSelection {
            applyShield()
        }
    }

    // MARK: - Selection metrics

    var hasSelection: Bool {
        !selection.applicationTokens.isEmpty
            || !selection.categoryTokens.isEmpty
            || !selection.webDomainTokens.isEmpty
    }

    var blockedAppCount: Int { selection.applications.count }
    var blockedCategoryCount: Int { selection.categories.count }
    var blockedWebsiteCount: Int { selection.webDomains.count }
    var selectionCount: Int { blockedAppCount + blockedCategoryCount + blockedWebsiteCount }

    /// "3 apps, 1 category" style summary for the UI.
    var selectionSummary: String {
        guard hasSelection else { return "Nothing selected" }
        var parts: [String] = []
        if blockedAppCount > 0 { parts.append("\(blockedAppCount) app\(blockedAppCount == 1 ? "" : "s")") }
        if blockedCategoryCount > 0 { parts.append("\(blockedCategoryCount) categor\(blockedCategoryCount == 1 ? "y" : "ies")") }
        if blockedWebsiteCount > 0 { parts.append("\(blockedWebsiteCount) site\(blockedWebsiteCount == 1 ? "" : "s")") }
        return parts.joined(separator: ", ")
    }

    // MARK: - Authorization

    func refreshAuthorization() {
        let previous = authorizationState
        // Publish only real transitions: this runs from onAppear and from App
        // Intents, and a redundant @Published write racing a row update in an
        // open Form corrupts its collection-view diff.
        let latest = ScreenTimeBlocker.map(AuthorizationCenter.shared.authorizationStatus)
        if latest != previous {
            authorizationState = latest
        }
        // Screen Time access was just granted (e.g. flipped on in Settings
        // while the app was backgrounded): re-arm anything already selected —
        // shield values set while unauthorized may never have taken effect.
        if authorizationState == .approved, previous != .approved, isBlocking, hasSelection {
            applyShield()
        }
    }

    func requestAuthorization() async {
        // The system prompt can take a while to spin up, and issuing a second
        // request while one is pending is what makes Screen Time feel stuck.
        // Coalesce: every caller awaits the same single in-flight request.
        if let inFlight = authorizationTask {
            await inFlight.value
            return
        }

        isRequestingAuthorization = true
        let task = Task { @MainActor in
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            } catch {
                // Keep the current status; the user may need to authorize from
                // Settings -> Screen Time -> Apps with Screen Time Access.
            }
            self.authorizationState = ScreenTimeBlocker.map(AuthorizationCenter.shared.authorizationStatus)
            // Shield values assigned before authorization may not have taken
            // effect — apply them now that access exists.
            if self.authorizationState == .approved, self.isBlocking, self.hasSelection {
                self.applyShield()
            }
            self.authorizationTask = nil
            self.isRequestingAuthorization = false
        }
        authorizationTask = task
        await task.value
    }

    // MARK: - Blocking

    func enableBlocking() {
        guard hasSelection else { return }
        applyShield()
        isBlocking = true
        defaults.set(true, forKey: enabledKey)
    }

    func disableBlocking() {
        store.clearAllSettings()
        isBlocking = false
        defaults.set(false, forKey: enabledKey)
    }

    private func applyShield() {
        // Assign nil (not an empty set) when a kind of item is no longer
        // selected: ManagedSettings keeps the previously applied policy if you
        // hand it a non-nil value, so an unselected category or app would keep
        // being shielded after the user removed it.
        let apps = selection.applicationTokens
        let categories = selection.categoryTokens
        let domains = selection.webDomainTokens

        store.shield.applications = apps.isEmpty ? nil : apps
        store.shield.applicationCategories = categories.isEmpty ? nil : .specific(categories)
        store.shield.webDomains = domains.isEmpty ? nil : domains
    }

    // MARK: - Persistence

    private func restorePersistedState() {
        if let data = defaults.data(forKey: selectionKey),
           let restored = try? PropertyListDecoder().decode(FamilyActivitySelection.self, from: data) {
            selection = restored
        }
        isBlocking = defaults.bool(forKey: enabledKey)
    }

    private func persistSelection() {
        if let data = try? PropertyListEncoder().encode(selection) {
            defaults.set(data, forKey: selectionKey)
        }
    }

    private static func map(_ status: AuthorizationStatus) -> ScreenTimeAuthorizationState {
        switch status {
        case .approved, .approvedWithDataAccess: return .approved
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }
}
#endif
