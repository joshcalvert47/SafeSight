//
//  AppBlockingView.swift
//  Shared (App)
//
//  Created by Josh Calvert on 24/09/2026.
//
//  The app shell (SafeSightTabView) and the Overview tab.
//
//  SafeSightTabView gates the whole app: Google sign-in → PIN hand-off →
//  extension setup, then four tabs (Overview / Web / Limits / Settings).
//  No Screen Time, no pairing, no parent mode — the child-device page is the
//  whole app now.
//

import SwiftUI

#if os(iOS)
import UIKit

// MARK: - iOS implementation

/// Minimal semantic palette so the dashboard follows the system appearance.
private enum Palette {
    static let accent = Color.accentColor
    static let warn = Color.orange
}

/// Root view presented as a sheet from the app's ViewController.
struct AppBlockingRootView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OverviewView()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// The native iOS app shell. Gating order: sign-in, then the one-time PIN
/// hand-off, then the extension setup step; after that the four tabs.
struct SafeSightTabView: View {
    @ObservedObject private var account = AccountStore.shared
    @State private var setupCompleted = SetupProgress.isCompleted

    var body: some View {
        if account.isWorking || account.isBootstrapping {
            VStack(spacing: 12) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(Palette.accent)
                ProgressView()
                Text("Setting up your account…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !account.isSignedIn {
            OnboardingView()
        } else if account.pendingPIN != nil {
            // The account exists but this device hasn't been shown its PIN
            // yet — onboarding owns that hand-off.
            OnboardingView()
        } else if !setupCompleted {
            SetupFlowView {
                setupCompleted = true
            }
        } else {
            TabView {
                NavigationStack {
                    OverviewView()
                }
                .tabItem {
                    Label("Overview", systemImage: "shield.lefthalf.filled")
                }

                NavigationStack {
                    ExtensionSettingsPage()
                }
                .tabItem {
                    Label("Web", systemImage: "safari")
                }

                NavigationStack {
                    LimitsView()
                }
                .tabItem {
                    Label("Limits", systemImage: "timer")
                }

                NavigationStack {
                    SettingsPage()
                }
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
            }
            .tint(Palette.accent)
        }
    }
}

/// A restrained system-background container used throughout the dashboard.
/// Optional `tint` paints a soft gradient wash in that color (used by the
/// status card) while keeping the standard card surface underneath.
private struct DashboardCard<Content: View>: View {
    var tint: Color?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
                .overlay {
                    if let tint {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [tint.opacity(0.14), tint.opacity(0.03)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    }
                }
        }
    }
}

/// Icon + title + optional count badge used at the top of a card.
private struct CardHeader: View {
    let icon: String
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.accent)
                .frame(width: 26, height: 26)
                .background(Palette.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            // Title gets priority and may wrap to two lines; the detail
            // capsule can never wrap or push into the title — it scales
            // down and truncates instead of overlapping.
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)

            Spacer(minLength: 8)

            if let detail {
                Text(detail)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
            }
        }
    }
}

/// Compact count tile using the same system surfaces as the rest of iOS.
/// Fixed height + non-wrapping, scale-to-fit text so all four tiles stay the
/// same length/width no matter how big the numbers get.
private struct StatTile: View {
    let count: Int
    let title: String
    let icon: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.accent)

            Text("\(count)")
                .font(.title3.bold().monospacedDigit())
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .multilineTextAlignment(.center)

            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 74, maxHeight: 74)
        .padding(.horizontal, 4)
        .clipped()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Overview

/// The landing tab: one glance at what's protecting this device right now,
/// with the pause control (PIN-gated) and a summary of the active limits.
struct OverviewView: View {
    @StateObject private var settings = SharedSettings.shared
    @ObservedObject private var blocker = ScreenTimeBlocker.shared
    @ObservedObject private var account = AccountStore.shared
    @State private var pinGate: PinGate?

    private var isDowntime: Bool { settings.quietEnabled && settings.isDuringQuietHours() }

    private enum Status {
        case active, paused, downtime
    }

    private var status: Status {
        if isDowntime { return .downtime }
        return settings.filtersEnabled ? .active : .paused
    }

    var body: some View {
        Form {
            // -----------------------------------------------------------------
            // Status
            // -----------------------------------------------------------------
            Section {
                DashboardCard(tint: statusColor) {
                    HStack(spacing: 12) {
                        Image(systemName: statusIcon)
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(statusColor)
                            .frame(width: 44, height: 44)
                            .background(statusColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                        VStack(alignment: .leading, spacing: 3) {
                            Text(statusTitle)
                                .font(.headline)
                            Text(statusSubtitle)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }

                    if settings.filtersEnabled {
                        Button {
                            pinGate = PinGate(
                                title: "Pause web filtering",
                                reason: "Safari will stop blocking sites and filtering images until you turn this back on.",
                                perform: { settings.filtersEnabled = false }
                            )
                        } label: {
                            Label("Pause Filters", systemImage: "pause.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    } else {
                        Button {
                            settings.filtersEnabled = true
                        } label: {
                            Label("Resume Filters", systemImage: "play.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .listRowBackground(Color.clear)
            } header: {
                Text("Status")
            } footer: {
                Text(settings.filtersEnabled
                     ? "The Safari extension applies your filter settings the next time a page loads — usually within seconds."
                     : "Nothing is being blocked while filters are paused.")
            }

            // -----------------------------------------------------------------
            // Activity
            // -----------------------------------------------------------------
            Section("Activity") {
                DashboardCard {
                    HStack(spacing: 8) {
                        StatTile(count: settings.scannedCount, title: "Scanned", icon: "eye")
                        StatTile(count: settings.blockedCount, title: "Blocked", icon: "hand.raised")
                        StatTile(count: settings.blocklistUser.count, title: "Sites", icon: "list.bullet")
                        StatTile(count: blocker.isBlocking ? blocker.selectionCount : 0, title: "Apps", icon: "timer")
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                .listRowBackground(Color.clear)
            }

            // -----------------------------------------------------------------
            // Limits at a glance
            // -----------------------------------------------------------------
            Section {
                LabeledContent("Quiet Hours") {
                    if settings.quietEnabled {
                        Text("\(settings.quietStart) – \(settings.quietEnd)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    } else {
                        Text("Off")
                            .foregroundStyle(.secondary)
                    }
                }

                LabeledContent("App Blocking") {
                    if blocker.isBlocking && blocker.hasSelection {
                        Text(blocker.selectionSummary)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.trailing)
                    } else {
                        Text(blocker.hasSelection ? "Off" : "Nothing selected")
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Your Limits")
            } footer: {
                Text("Quiet hours block all Safari browsing during the window. App blocking uses iOS Screen Time to keep the selected apps closed until you turn it off (PIN required).")
            }

            // -----------------------------------------------------------------
            // Account
            // -----------------------------------------------------------------
            Section("Account") {
                LabeledContent("Signed in as") {
                    Text(account.email ?? "—")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if account.syncPending {
                    Label("Your PIN is stored on this device only so far — it will sync when you're back online.", systemImage: "icloud.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        }
        .navigationTitle("Overview")
        .onAppear {
            // The app group is shared with the Safari extension — re-read it
            // so counters pushed by the extension show up.
            settings.reload()
            blocker.refreshAuthorization()
        }
        .refreshable {
            settings.reload()
            blocker.refreshAuthorization()
        }
        .pinGated($pinGate)
    }

    // MARK: - Status copy

    private var statusIcon: String {
        switch status {
        case .active: return "checkmark.shield.fill"
        case .paused: return "shield.slash"
        case .downtime: return "moon.zzz.fill"
        }
    }

    private var statusColor: Color {
        switch status {
        case .active: return .green
        case .paused: return Palette.warn
        case .downtime: return .indigo
        }
    }

    private var statusTitle: String {
        switch status {
        case .active: return "Protection active"
        case .paused: return "Filters paused"
        case .downtime: return "Quiet hours"
        }
    }

    private var statusSubtitle: String {
        switch status {
        case .active:
            return isDowntime
                ? "Safari is blocked until \(settings.quietEnd)."
                : "Safari filtering is on" + (settings.blocklistUser.isEmpty ? "." : " and \(settings.blocklistUser.count) site\(settings.blocklistUser.count == 1 ? "" : "s") blocked.")
        case .paused:
            return "Turn filters back on to resume blocking."
        case .downtime:
            return "All Safari browsing is blocked until \(settings.quietEnd)."
        }
    }
}

#else

// MARK: - macOS fallback

/// Root view presented as a sheet from the app's ViewController. On native
/// macOS app limits aren't available, so this explains the feature and
/// points users to the iOS experience.
struct AppBlockingRootView: View {
    @Environment(\.presentationMode) private var presentationMode

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "app.badge.checkmark")
                .font(.system(size: 52))
                .foregroundColor(.accentColor)

            Text("Limits")
                .font(.title2.bold())

            Text("App limits are available in the iPhone and iPad version of SafeSight.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)

            Text("On this Mac, SafeSight keeps protecting your browsing with the Safari extension.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)

            Button("Close") {
                presentationMode.wrappedValue.dismiss()
            }
            .keyboardShortcut(.cancelAction)
            .padding(.top, 8)
        }
        .padding(40)
        .frame(minWidth: 440, minHeight: 360, alignment: .center)
    }
}

#endif
