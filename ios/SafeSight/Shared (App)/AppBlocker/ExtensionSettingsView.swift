//
//  ExtensionSettingsView.swift
//  Shared (App)
//
//  The "Settings" tab, plus the web-filter settings shared by the Filter
//  tab and the standalone Web Filter sheet.
//
//  SettingsPage  — account (Google sign-in), per-account PIN management,
//                  sign-out.
//  WebFilterSections — the Safari extension's master switch, options and
//                  blocked-site list, embedded in the Filter tab.
//  ExtensionSettingsPage — the Web Filter sheet: WebFilterSections plus the
//                  extension's activity counters. Both write straight into
//                  the shared App Group container
//                  (group.com.joshc.SafeSight); the extension pulls them
//                  down through the native bridge on its next settings sync.
//
//  Anything that would weaken protection (pausing the filters, removing a
//  blocked site, turning quiet hours off) is PIN-gated through PINGateSheet.
//  While parent mode is on (Settings → Parent Controls), every gate asks for
//  the parent PIN instead of the account PIN, which is also locked.
//

import SwiftUI
#if os(iOS)
import FamilyControls
import UIKit
#endif

// MARK: - PIN gate

/// Sheet state for a PIN-gated action: run `verify` before `perform`.
struct PinGate: Identifiable {
    let id = UUID()
    let title: String
    let reason: String
    let perform: () -> Void
}

/// PIN prompt used everywhere a weakening action needs a PIN. While parent
/// mode is on it asks for the parent PIN (and routes verification there);
/// otherwise it verifies the account PIN against the local salted hash
/// (PinStore), including the failed-attempt lockout.
struct PINGateSheet: View {
    @Environment(\.dismiss) private var dismiss
    let gate: PinGate
    @State private var pin = ""
    @State private var failed = false
    @ObservedObject private var store = PinStore.shared

    private var asksForParentPIN: Bool { store.parentModeEnabled }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(asksForParentPIN ? "Parent PIN" : "PIN", text: $pin)
#if os(iOS)
                        .keyboardType(.numberPad)
#endif
                        .onChange(of: pin) { newValue in
                            pin = String(newValue.filter(\.isNumber).prefix(4))
                            failed = false
                        }
                } header: {
                    Text(gate.title)
                } footer: {
                    if store.isLockedOut {
                        Text("Too many attempts — try again in \(store.lockoutRemaining)s.")
                            .foregroundStyle(.red)
                    } else if failed {
                        Text(asksForParentPIN ? "Incorrect parent PIN." : "Incorrect PIN.")
                            .foregroundStyle(.red)
                    } else {
                        Text(gate.reason)
                    }
                }
            }
            .navigationTitle(asksForParentPIN ? "Enter parent PIN" : "Enter your PIN")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Confirm") {
                        let ok = asksForParentPIN
                            ? store.verifyParentPIN(pin)
                            : store.verify(pin)
                        guard ok else {
                            failed = true
                            return
                        }
                        dismiss()
                        // Run the action on the next tick: mutating the
                        // presenting form's rows in the same turn as the
                        // dismissal batch update corrupts its diff ("Invalid
                        // update: invalid number of items in section").
                        DispatchQueue.main.async {
                            gate.perform()
                        }
                    }
                    .disabled(pin.count < 4 || store.isLockedOut)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

extension View {
    /// Presents the shared PIN gate from a `PinGate?` state variable.
    func pinGated(_ gate: Binding<PinGate?>) -> some View {
        sheet(item: gate) { PINGateSheet(gate: $0) }
    }
}

// MARK: - Settings tab

/// Account + PIN management. The account is a plain Google sign-in; the PIN
/// is per-account, generated on creation and shown once during onboarding.
struct SettingsPage: View {
    @ObservedObject private var account = AccountStore.shared
    @ObservedObject private var pin = PinStore.shared

    @State private var pinGate: PinGate?
    @State private var showChangePIN = false
    @State private var showCreateParentPIN = false
    @State private var showResetConfirm = false
    @State private var resetPINValue: String?
    @State private var showSignOutConfirm = false
    @State private var changeError = ""

    var body: some View {
        Form {
            // -----------------------------------------------------------------
            // Account
            // -----------------------------------------------------------------
            Section {
                if account.isSignedIn {
                    LabeledContent("Name") {
                        Text(account.name ?? "—")
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("Email") {
                        Text(account.email ?? "—")
                            .foregroundStyle(.secondary)
                    }
                    if account.syncPending {
                        Label("PIN hasn't synced yet", systemImage: "icloud.slash")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    Button("Sign Out", role: .destructive) {
                        showSignOutConfirm = true
                    }
                    // Parent mode is a full lock-down: sign-out would strip the
                    // parent PIN check off every loosening action, so it's off
                    // until a parent disables the mode.
                    .disabled(pin.parentModeEnabled)
                } else {
                    Button {
                        Task { _ = await account.signIn() }
                    } label: {
                        if account.isWorking {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Signing in…")
                            }
                        } else {
                            Label("Sign in with Google", systemImage: "person.crop.circle")
                        }
                    }
                    .disabled(account.isWorking)
                }
            } header: {
                Text("Account")
            } footer: {
                if let error = account.errorMessage {
                    Text(error).foregroundStyle(.red)
                } else if !account.isSignedIn {
                    Text("Sign in to keep your PIN in sync across your devices. Your account only stores a hashed PIN — never the digits themselves.")
                } else if pin.parentModeEnabled {
                    Text("Parent mode is on — signing out is disabled until a parent turns the mode off with the parent PIN.")
                        .foregroundStyle(.orange)
                } else {
                    Text("Your SafeSight account and PIN protect this device's settings.")
                }
            }

            // -----------------------------------------------------------------
            // PIN
            // -----------------------------------------------------------------
            Section {
                if let pending = account.pendingPIN {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your PIN")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(pending)
                            .font(.system(size: 34, weight: .semibold, design: .monospaced))
                            .kerning(6)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                        Text("Write this down — you'll need it to pause filters, edit limits and change settings. It's shown only once.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("I wrote it down") {
                            account.acknowledgePendingPIN()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, 4)
                }

                Button("Change PIN") {
                    guard pin.isSet else { return }
                    showChangePIN = true
                }
                .disabled(!pin.isSet || pin.parentModeEnabled)

                Button("Forgot PIN?", role: .destructive) {
                    showResetConfirm = true
                }
                .disabled(pin.parentModeEnabled)
            } header: {
                Text("PIN")
            } footer: {
                if let value = resetPINValue {
                    Text("Your new PIN is \(value). Write it down — it won't be shown again.")
                        .foregroundStyle(.orange)
                } else if pin.parentModeEnabled {
                    Text("Parent mode is on — the account PIN can't be changed or reset until a parent disables it.")
                } else if !pin.isSet {
                    Text("No PIN on this device yet — sign in to create one.")
                } else {
                    Text("Your PIN guards everything that would loosen protection: pausing filters, removing limits, quiet hours and changing the PIN itself.")
                }
            }

            // -----------------------------------------------------------------
            // Parent controls
            // -----------------------------------------------------------------
            Section {
                if pin.parentModeEnabled {
                    LabeledContent("Parent Mode") {
                        Text("On")
                            .foregroundStyle(.secondary)
                    }
                    Button("Disable Parent Mode", role: .destructive) {
                        pinGate = PinGate(
                            title: "Disable parent mode",
                            reason: "Enter the parent PIN — the account PIN won't work here.",
                            perform: {
                                pin.disableParentMode()
                                Task { await account.syncParentPIN(enabled: false) }
                            }
                        )
                    }
                } else {
                    Button("Turn On Parent Mode…") {
                        showCreateParentPIN = true
                    }
                    .disabled(!pin.isSet)
                }
            } header: {
                Text("Parent Controls")
            } footer: {
                if pin.parentModeEnabled {
                    Text("Pausing filters, quiet hours, app blocking and removing sites/apps now ask for the parent PIN, and the account PIN is locked. The parent PIN itself can't be changed — disable the mode (with the parent PIN) to set a new one.")
                } else if !pin.isSet {
                    Text("Set an account PIN first: a parent sets a second PIN that every protection gate will require while parent mode is on.")
                } else {
                    Text("A parent can set a separate 4-digit PIN that can't be changed. While parent mode is on, everything that loosens protection asks for the parent PIN instead of the account PIN.")
                }
            }

#if os(iOS)
            if pin.parentModeEnabled {
                ParentRecommendationSections()
            }
#endif
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showChangePIN) {
            ChangePINSheet()
        }
        .sheet(isPresented: $showCreateParentPIN) {
            CreateParentPINSheet()
        }
        .alert("Get a new PIN?", isPresented: $showResetConfirm) {
            Button("Get new PIN", role: .destructive) {
                Task {
                    resetPINValue = await account.resetPIN()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll sign in with Google again to confirm it's you, then get a fresh 4-digit PIN. The old PIN stops working immediately.")
        }
        .alert("Sign out?", isPresented: $showSignOutConfirm) {
            Button("Sign Out", role: .destructive) { account.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your limits and PIN stay on this device. Sign back in any time with the same Google account.")
        }
        .pinGated($pinGate)
    }
}

/// Sheet for changing the account PIN: verify the current one, then set a new
/// 4-digit one (re-hashed and uploaded to the account document).
private struct ChangePINSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var account = AccountStore.shared
    @State private var current = ""
    @State private var newPIN = ""
    @State private var confirm = ""
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Current PIN") {
                    SecureField("PIN", text: $current)
#if os(iOS)
                        .keyboardType(.numberPad)
#endif
                        .onChange(of: current) { v in
                            current = String(v.filter(\.isNumber).prefix(4))
                        }
                }
                Section {
                    SecureField("New PIN", text: $newPIN)
#if os(iOS)
                        .keyboardType(.numberPad)
#endif
                        .onChange(of: newPIN) { v in
                            newPIN = String(v.filter(\.isNumber).prefix(4))
                        }
                    SecureField("Confirm new PIN", text: $confirm)
#if os(iOS)
                        .keyboardType(.numberPad)
#endif
                        .onChange(of: confirm) { v in
                            confirm = String(v.filter(\.isNumber).prefix(4))
                        }
                } header: {
                    Text("New PIN")
                } footer: {
                    if !error.isEmpty {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Change PIN")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Change") {
                        Task { await change() }
                    }
                    .disabled(current.count < 4 || newPIN.count < 4 || confirm.count < 4)
                }
            }
        }
    }

    private func change() async {
        guard newPIN == confirm else {
            error = "The new PINs don't match."
            return
        }
        guard newPIN != current else {
            error = "Pick a different PIN."
            return
        }
        guard await account.changePIN(current: current, new: newPIN) else {
            error = "Incorrect current PIN."
            return
        }
        dismiss()
    }
}

/// Sheet for enabling parent mode: step 0 verifies the account PIN and sets
/// the new parent PIN (enter + confirm), step 1 shows the parent
/// recommendations — apps to add to the block list (App Store, other
/// browsers, VPN/DNS tools) and the one removal restriction iOS won't let
/// apps set for them. The parent PIN gets its own salted hash and can't be
/// changed afterwards without disabling parent mode first.
private struct CreateParentPINSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = PinStore.shared
    @State private var step = 0
    @State private var accountPIN = ""
    @State private var parentPIN = ""
    @State private var confirm = ""
    @State private var error = ""

    var body: some View {
        NavigationStack {
            Form {
                if step == 0 {
                    pinSections
                } else {
#if os(iOS)
                    ParentRecommendationSections()
#else
                    Text("App-blocking recommendations appear in the iPhone version of SafeSight.")
                        .foregroundStyle(.secondary)
#endif
                }
            }
            .navigationTitle(step == 0 ? "Parent Mode" : "Recommendations")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                if step == 0 {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Enable") {
                            enable()
                        }
                        .disabled(accountPIN.count < 4 || parentPIN.count < 4 || confirm.count < 4 || store.isLockedOut)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var pinSections: some View {
        Section("Your PIN") {
            SecureField("Current account PIN", text: $accountPIN)
#if os(iOS)
                .keyboardType(.numberPad)
#endif
                .onChange(of: accountPIN) { v in
                    accountPIN = String(v.filter(\.isNumber).prefix(4))
                }
        }
        Section {
            SecureField("Parent PIN", text: $parentPIN)
#if os(iOS)
                .keyboardType(.numberPad)
#endif
                .onChange(of: parentPIN) { v in
                    parentPIN = String(v.filter(\.isNumber).prefix(4))
                }
            SecureField("Confirm parent PIN", text: $confirm)
#if os(iOS)
                .keyboardType(.numberPad)
#endif
                .onChange(of: confirm) { v in
                    confirm = String(v.filter(\.isNumber).prefix(4))
                }
        } header: {
            Text("Parent PIN")
        } footer: {
            if store.isLockedOut {
                Text("Too many attempts — try again in \(store.lockoutRemaining)s.")
                    .foregroundStyle(.red)
            } else if !error.isEmpty {
                Text(error).foregroundStyle(.red)
            } else {
                Text("This PIN can't be changed later. To set a new one, disable parent mode with it and turn the mode on again.")
            }
        }
    }

    private func enable() {
        guard store.verify(accountPIN) else {
            error = "Incorrect account PIN."
            return
        }
        guard parentPIN == confirm else {
            error = "The parent PINs don't match."
            return
        }
        guard store.setParentPIN(parentPIN) else {
            error = "Parent mode is already on."
            return
        }
        Task { await AccountStore.shared.syncParentPIN(enabled: true) }
        // Stay open and walk the parent through the recommendations next.
        withAnimation { step = 1 }
    }
}

#if os(iOS)
// MARK: - Parent-mode recommendations

/// What a parent should add to the Screen Time block list when they turn
/// parent mode on: the App Store (installs bypass tools), other browsers
/// (they skip the Safari web filter completely) and VPN/DNS/proxy tools
/// (route around filtering). Screen Time tokens only come from the system
/// picker, so this lists the names to search for there and opens the picker;
/// it also walks the parent through the one restriction iOS won't let apps
/// set for themselves — preventing app deletion — with a best-effort deep
/// link into Settings (private URL, so it falls back to the written steps
/// if Apple's layout moves or the scheme is rejected).
struct ParentRecommendationSections: View {
    @ObservedObject private var blocker = ScreenTimeBlocker.shared

    @State private var pinGate: PinGate?
    @State private var draft = FamilyActivitySelection()
    @State private var pickerPresented = false
    @State private var didCommitDraft = false
    @State private var showRemovalSteps = false

    private struct Recommendation: Identifiable {
        let id = UUID()
        let icon: String
        let title: String
        let reason: String
    }

    private let recommended: [Recommendation] = [
        Recommendation(icon: "arrow.down.app.fill",
                       title: "App Store",
                       reason: "Stops new browsers, VPNs and other bypass tools from being installed."),
        Recommendation(icon: "safari",
                       title: "Chrome, Firefox, Edge, Brave, Opera…",
                       reason: "Other browsers skip the Safari web filter completely."),
        Recommendation(icon: "network",
                       title: "VPN & DNS apps",
                       reason: "1.1.1.1, AdGuard DNS and similar route traffic around filtering."),
        Recommendation(icon: "globe.dashed",
                       title: "Proxy & Tor browsers",
                       reason: "Tor, Psiphon and similar hide browsing from any filter.")
    ]

    var body: some View {
        sections
            .sheet(isPresented: $pickerPresented) { pickerSheet }
            .pinGated($pinGate)
            .alert("Turn on \"Deleting Apps\"", isPresented: $showRemovalSteps) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Open Settings → Screen Time → Content & Privacy Restrictions, turn restrictions on, then tap iTunes & App Store Purchases → Deleting Apps → Don't Allow.")
            }
    }

    @ViewBuilder
    private var sections: some View {
        recommendationsSection
        removalSection
    }

    private var recommendationsSection: some View {
        Section {
            ForEach(recommended) { item in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: item.icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 26, height: 26)
                        .background(Color.accentColor.opacity(0.10),
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                        Text(item.reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 2)
            }

            if blocker.authorizationState != .approved {
                Label("Allow Screen Time access in the Filter tab first — the picker needs it.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            Button {
                draft = blocker.selection
                didCommitDraft = false
                pickerPresented = true
            } label: {
                Label("Review in the App Picker…", systemImage: "square.grid.2x2")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(blocker.authorizationState != .approved)
        } header: {
            Text("Recommended for Parents")
        } footer: {
            Text("Search these names in the picker — iOS never lets an app pre-select them for you. Adding apps applies immediately; removing one later asks for the parent PIN.")
        }
    }

    private var removalSection: some View {
        Section {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Deleting Apps → Don't Allow")
                        .font(.subheadline.weight(.semibold))
                    Text("Settings → Screen Time → Content & Privacy Restrictions → iTunes & App Store Purchases")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } icon: {
                Image(systemName: "lock.fill")
                    .foregroundStyle(.orange)
            }

            Button {
                openScreenTimeSettings()
            } label: {
                Label("Open Screen Time Settings", systemImage: "gearshape")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        } header: {
            Text("Prevent Removal")
        } footer: {
            Text("iOS gives apps no way to enable or verify this restriction — a parent has to flip it. With it on, children can't delete SafeSight or any other app from the Home Screen.")
        }
    }

    /// iOS exposes no public Settings URL, so these private roots are tried
    /// in order; if none open, the written steps are shown instead.
    private func openScreenTimeSettings() {
        openRoots([
            "App-Prefs:root=SCREEN_TIME",
            "App-Prefs:root=CONTENT_PRIVACY",
            "prefs:root=SCREEN_TIME"
        ], at: 0)
    }

    private func openRoots(_ roots: [String], at index: Int) {
        guard index < roots.count, let url = URL(string: roots[index]) else {
            showRemovalSteps = true
            return
        }
        UIApplication.shared.open(url, options: [:]) { opened in
            if !opened {
                openRoots(roots, at: index + 1)
            }
        }
    }

    private var pickerSheet: some View {
        NavigationStack {
            FamilyActivityPicker(selection: $draft)
                .navigationTitle("Choose What to Block")
#if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
#endif
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { commitDraft() }
                    }
                }
        }
        .onDisappear {
            // Swiped away without tapping Done: discard the draft.
            if !didCommitDraft {
                draft = blocker.selection
            }
            didCommitDraft = false
        }
    }

    /// Additions are free (they tighten protection). If the draft drops
    /// anything from the current selection, the parent PIN comes first —
    /// same contract as the Filter tab's app-blocking section.
    private func commitDraft() {
        didCommitDraft = true
        pickerPresented = false

        let removesAnything =
            !blocker.selection.applicationTokens.isSubset(of: draft.applicationTokens) ||
            !blocker.selection.categoryTokens.isSubset(of: draft.categoryTokens) ||
            !blocker.selection.webDomains.isSubset(of: draft.webDomains)

        guard removesAnything && blocker.isBlocking else {
            blocker.selection = draft
            return
        }
        pinGate = PinGate(
            title: "Remove apps from the block list",
            reason: "The apps you unchecked will be openable again.",
            perform: { blocker.selection = draft }
        )
    }
}
#endif

// MARK: - Web filter sections

/// The Safari extension's master switch, options and blocked-site list —
/// shared by the Filter tab and the standalone Web Filter sheet
/// (ExtensionSettingsPage). Writes into the app group; the extension picks
/// the values up on its next settings sync.
struct WebFilterSections: View {
    @StateObject private var settings = SharedSettings.shared
    @State private var newSite = ""
    @State private var pinGate: PinGate?

    var body: some View {
        sections
            .pinGated($pinGate)
    }

    @ViewBuilder
    private var sections: some View {
        // -----------------------------------------------------------------
        // Master switch — pausing the filters is PIN-gated.
        // -----------------------------------------------------------------
        Section {
            Toggle("Web Filtering", isOn: Binding(
                get: { settings.filtersEnabled },
                set: { enabled in
                    if enabled {
                        settings.filtersEnabled = true
                    } else {
                        pinGate = PinGate(
                            title: "Pause web filtering",
                            reason: "Safari will stop blocking sites and filtering images until you turn this back on.",
                            perform: { settings.filtersEnabled = false }
                        )
                    }
                }
            ))
        } header: {
            Text("Filters")
        } footer: {
            Text(settings.filtersEnabled
                 ? "On. Applied by the Safari extension the next time a page loads — usually within seconds."
                 : "Paused — nothing is being blocked right now.")
        }

        // -----------------------------------------------------------------
        // The extension's controls — written to the app group, picked up by
        // the Safari extension on its next settings sync.
        // -----------------------------------------------------------------
        Section {
            Toggle("Skin Filter", isOn: Binding(
                get: { settings.skinFilter },
                set: { settings.setSkinFilter($0) }
            ))

            VStack(alignment: .leading, spacing: 6) {
                Text("Filter Sensitivity")
                Text(SharedSettings.sensitivityLabel(settings.sensitivity))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Slider(
                    value: Binding(
                        get: { Double(settings.sensitivity) },
                        set: { settings.sensitivity = Int($0.rounded()) }
                    ),
                    in: 1...9,
                    step: 1
                )
                HStack {
                    Text("Relaxed")
                    Spacer()
                    Text("Strict")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Toggle("Blur All", isOn: Binding(
                get: { settings.blurAll },
                set: { settings.blurAll = $0 }
            ))
        } header: {
            Text("Web Filter Options")
        } footer: {
            Text("Applied by the Safari extension the next time a page loads — usually within seconds.")
        }

        Section {
            ForEach(settings.blocklistUser, id: \.self) { site in
                Text(site)
                    .font(.body.monospaced())
            }
            .onDelete { offsets in
                guard let first = offsets.first else { return }
                let site = settings.blocklistUser[first]
                pinGate = PinGate(
                    title: "Remove \(site)?",
                    reason: "This site will be openable in Safari again.",
                    perform: { settings.blocklistUser.removeAll { $0 == site } }
                )
            }

            HStack {
                TextField("example.com", text: $newSite)
                    .autocorrectionDisabled()
#if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
#endif
                    .onSubmit(addSite)
                Button("Add", action: addSite)
                    .buttonStyle(.borderedProminent)
                    .disabled(normalizedSite(newSite) == nil)
            }
        } header: {
            Text("Blocked Sites")
        } footer: {
            Text("Sites listed here can't be opened in Safari at all. Sites built into the extension stay locked.")
        }
    }

    // MARK: - Blocked sites

    /// Adds the typed host to the block list, normalised the same way the
    /// extension bridge normalises it so both sides match identically.
    private func addSite() {
        guard let site = normalizedSite(newSite) else {
            newSite = ""
            return
        }
        guard !settings.blocklistUser.contains(site) else {
            newSite = ""
            return
        }
        settings.blocklistUser.append(site)
        newSite = ""
    }

    /// Strips scheme, path, port and "www." and requires a dotted host —
    /// mirrors SafariWebExtensionHandler.normalize(_:) and the popup's JS.
    private func normalizedSite(_ entry: String) -> String? {
        var site = entry.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !site.isEmpty else { return nil }
        if let scheme = site.range(of: "://") { site = String(site[scheme.upperBound...]) }
        site = site.split(whereSeparator: { "/?#".contains($0) }).first.map(String.init) ?? site
        site = site.split(separator: "@").last.map(String.init) ?? site
        site = site.split(separator: ":").first.map(String.init) ?? site
        if site.hasPrefix("*.") { site.removeFirst(2) }
        if site.hasPrefix("www.") { site.removeFirst(4) }
        while site.hasSuffix(".") { site.removeLast() }
        guard site.contains("."), !site.contains(" "), site.count <= 253 else { return nil }
        return site
    }
}

// MARK: - Web Filter sheet

/// The Safari extension's activity counters as a standalone sheet, with
/// WebFilterSections above them. Presented from the legacy Main.html paths
/// and the macOS toolbar; iOS root flow uses the Filter tab instead.
struct ExtensionSettingsPage: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var settings = SharedSettings.shared

    var isDoneSheet: Bool

    init(isDoneSheet: Bool = false) {
        self.isDoneSheet = isDoneSheet
    }

    var body: some View {
        Form {
            WebFilterSections()

            // -----------------------------------------------------------------
            // Activity — reported by the Safari extension through the app group.
            // -----------------------------------------------------------------
            Section {
                LabeledContent("Images scanned") {
                    Text("\(settings.scannedCount)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Images blocked") {
                    Text("\(settings.blockedCount)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Activity")
            } footer: {
                Text("Counted by the Safari extension while you browse.")
            }
        }
        .navigationTitle("Web Filter")
        .onAppear {
            // Deferred a tick: a synchronous reload here publishes while the
            // sheet's own insertion transaction is still being applied.
            DispatchQueue.main.async {
                settings.reload()
            }
        }
        .toolbar {
            if isDoneSheet {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// The extension's default blocklist.json, copied into the app bundle so
    /// the app can report how many sites the extension blocks out of the box.
    /// These entries are locked: the extension enforces them and the app
    /// deliberately never lists them. Keep both copies in sync.
    static let defaultBlocklist: [String] = {
        guard let url = Bundle.main.url(forResource: "blocklist", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data),
              let obj = json as? [String: Any],
              let sites = obj["sites"] as? [String] else { return [] }
        return sites
    }()
}

struct ExtensionSettingsPage_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            ExtensionSettingsPage()
        }
    }
}
