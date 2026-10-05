//
//  OnboardingView.swift
//  Shared (App)
//  iOS target only.
//
//  First-run flow, in the order SafeSightTabView shows it:
//
//  1. OnboardingView — Google sign-in, then the one-time PIN hand-off.
//  2. SetupFlowView  — grant Screen Time, pick apps to block, turn on the
//     Safari extension.
//
//  After that the three tabs take over; SetupProgress remembers that setup is
//  done (app group, survives relaunches).
//

import SwiftUI

#if os(iOS)
import UIKit
import FamilyControls

// MARK: - Sign-in + PIN hand-off

struct OnboardingView: View {
    @ObservedObject private var account = AccountStore.shared

    var body: some View {
        Group {
            if !account.isSignedIn {
                signInStage
            } else if let pin = account.pendingPIN {
                pinStage(pin)
            } else {
                // Signed in, no PIN hand-off outstanding: bootstrap is either
                // still running (the shell shows its loader) or this state
                // shouldn't exist — show a safe fallback rather than a blank.
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Finishing up…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    // MARK: Stage 1 — Google sign-in

    private var signInStage: some View {
        VStack(spacing: 20) {
            Spacer(minLength: 8)

            ZStack {
                Circle()
                    .fill(LinearGradient(
                        colors: [Color.accentColor, Color.accentColor.opacity(0.55)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .frame(width: 108, height: 108)
                    .shadow(color: Color.accentColor.opacity(0.35), radius: 18, y: 9)

                Image(systemName: "hourglass")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.white)
            }

            Text("Take back your time")
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)

            Text("Set quiet hours, block sites and choose app limits — your device, your rules. One Google account and one PIN keep your settings yours.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 4)

            Button {
                Task { _ = await account.signIn() }
            } label: {
                Group {
                    if account.isWorking {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Signing in…")
                        }
                    } else {
                        Label("Continue with Google", systemImage: "person.crop.circle")
                    }
                }
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(account.isWorking)

            if let error = account.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 4)
            }

            Text("Sign-in is only used to keep your PIN in sync across your devices. SafeSight never stores your Google password, and your PIN is saved as a salted hash.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)

            Spacer(minLength: 8)
        }
        .padding(24)
    }

    // MARK: Stage 2 — one-time PIN hand-off

    private func pinStage(_ pin: String) -> some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)

            SetupIconChip(systemName: "key.fill")

            Text("Your PIN is")
                .font(.title2.bold())

            Text(pin)
                .font(.system(size: 46, weight: .semibold, design: .monospaced))
                .kerning(10)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity)
                .background(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.12), Color.accentColor.opacity(0.04)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.accentColor.opacity(0.28), lineWidth: 1)
                }

            Text("Write it down now — it's shown only once.\n\nYou'll need it to pause filters, remove limits and change settings. It's the same PIN on every device signed into \(account.email ?? "your account").")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 4)

            Button {
                account.acknowledgePendingPIN()
            } label: {
                Text("I wrote it down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Spacer(minLength: 8)
        }
        .padding(24)
    }
}

// MARK: - First-run setup wizard

enum SetupProgress {
    private static let key = "setupCompletedV1"

    static var isCompleted: Bool {
        UserDefaults(suiteName: SharedSettings.appGroupID)?.bool(forKey: key) ?? false
    }

    static func markCompleted() {
        UserDefaults(suiteName: SharedSettings.appGroupID)?.set(true, forKey: key)
    }
}

/// Shown by SafeSightTabView once sign-in and the PIN hand-off are done:
/// grant Screen Time + pick apps to block, then turn on the Safari extension.
/// Completed once.
struct SetupFlowView: View {
    let onFinished: () -> Void

    @State private var step = 0

    /// The steps this run shows, in order: Screen Time setup, then the
    /// Safari extension. Both are always relevant.
    private var flow: [Int] { [0, 1] }

    private var position: Int {
        flow.firstIndex(of: step) ?? 0
    }

    /// Moves to the next step in this run's flow (or finishes at the end).
    private func advance() {
        let next = position + 1
        if next < flow.count {
            step = flow[next]
        } else {
            finish()
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            SetupProgressHeader(step: position, total: flow.count)

            switch step {
            case 0:
                AppBlockingSetupStep(onContinue: { advance() })
            default:
                ExtensionSetupStep(onFinished: finish)
            }
        }
        .onAppear {
            step = flow[0]
        }
    }

    private func finish() {
        SetupProgress.markCompleted()
        onFinished()
    }
}

/// "Step 1 of 3" dots at the top of the wizard.
private struct SetupProgressHeader: View {
    let step: Int
    let total: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<total, id: \.self) { i in
                Capsule()
                    .fill(i <= step ? Color.accentColor : Color.secondary.opacity(0.25))
                    .frame(width: 28, height: 5)
            }
            Spacer()
            Text("Step \(min(step + 1, total)) of \(total)")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
    }
}

/// Step 1: Screen Time access + the system app picker. Real blocking starts
/// only after both — the picker's tokens are the only thing ManagedSettings
/// can shield, and iOS only honors that once Family Controls is granted.
private struct AppBlockingSetupStep: View {
    let onContinue: () -> Void

    @ObservedObject private var blocker = ScreenTimeBlocker.shared
    @State private var draft = FamilyActivitySelection()
    @State private var pickerPresented = false
    @State private var installed: [AppBlocklistEntry] = []

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)

            SetupIconChip(systemName: "hand.raised")

            Text("Block your apps")
                .font(.title2.bold())

            Text(copy)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 4)

            if blocker.authorizationState == .approved {
                Button {
                    draft = blocker.selection
                    pickerPresented = true
                } label: {
                    Label(blocker.hasSelection ? "Change Selection" : "Choose Apps…",
                          systemImage: "square.grid.2x2")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                Text(blocker.hasSelection ? blocker.selectionSummary : "Nothing selected yet")
                    .font(.footnote)
                    .foregroundStyle(blocker.hasSelection ? Color.secondary : Color.orange)
            } else {
                Button {
                    Task { await blocker.requestAuthorization() }
                } label: {
                    HStack {
                        if blocker.isRequestingAuthorization {
                            ProgressView()
                        }
                        Text(blocker.authorizationState == .denied
                             ? "Try Granting Again"
                             : "Allow Screen Time Access")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(blocker.isRequestingAuthorization)

                if blocker.authorizationState == .denied {
                    Text("Denied — you can enable SafeSight later in Settings → Screen Time → Apps with Screen Time Access.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                }
            }

            if !installed.isEmpty {
                Text("Tip: search for \(installed.prefix(4).map(\.name).joined(separator: ", "))… in the picker.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }

            Button {
                onContinue()
            } label: {
                Text("Continue")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Spacer(minLength: 8)
        }
        .padding(24)
        .onAppear {
            installed = AppBlocklist.installedRecommendations
            blocker.refreshAuthorization()
        }
        .sheet(isPresented: $pickerPresented) {
            NavigationStack {
                FamilyActivityPicker(selection: $draft)
                    .navigationTitle("Choose What to Block")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") {
                                blocker.selection = draft
                                pickerPresented = false
                            }
                        }
                    }
            }
            .onDisappear {
                pickerPresented = false
            }
        }
    }

    private var copy: String {
        switch blocker.authorizationState {
        case .approved:
            return blocker.hasSelection
                ? "These apps will be blocked everywhere on this device once you turn blocking on (you can do that in the Filter tab)."
                : "Pick the apps you want blocked — the system picker is iOS's only way to choose them."
        case .denied:
            return "SafeSight needs Screen Time access to close other apps. You can grant it later in Settings."
        case .notDetermined:
            return "iOS only lets SafeSight block other apps after you grant Screen Time access. You'll get the system prompt next."
        }
    }
}

/// Final step: turn the Safari web extension on, then finish setup.
private struct ExtensionSetupStep: View {
    let onFinished: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 8)

            SetupIconChip(systemName: "safari")

            Text("Enable the Safari extension")
                .font(.title2.bold())

            Text("SafeSight blocks sites and filters images in Safari. Turn the extension on once and allow it on all websites — otherwise Safari only runs it when you tap it per site.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 4)

            VStack(alignment: .leading, spacing: 8) {
                OnboardingStep(number: 1, text: "Tap Open Settings below")
                OnboardingStep(number: 2, text: "Go to Apps → Safari → Extensions → SafeSight")
                OnboardingStep(number: 3, text: "Turn SafeSight on")
                OnboardingStep(number: 4, text: "Tap Website Access and choose All Websites (not Ask for Websites)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))

            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Open Settings", systemImage: "gearshape")
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Button {
                onFinished()
            } label: {
                Text("Finish Setup")
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            Spacer(minLength: 8)
        }
        .padding(24)
    }
}

/// Tinted rounded-square chip behind the hero icon of each setup step —
/// the same treatment as the dashboard's card headers.
private struct SetupIconChip: View {
    let systemName: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.accentColor.opacity(0.12))
                .frame(width: 76, height: 76)

            Image(systemName: systemName)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Color.accentColor)
        }
        .accessibilityHidden(true)
    }
}

private struct OnboardingStep: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.bold())
                .frame(width: 20, height: 20)
                .background(Circle().fill(Color.accentColor.opacity(0.2)))
                .foregroundStyle(.tint)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

#endif

struct OnboardingView_Previews: PreviewProvider {
    static var previews: some View {
        OnboardingView()
    }
}
