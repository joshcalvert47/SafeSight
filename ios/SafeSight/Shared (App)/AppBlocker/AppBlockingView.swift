//
//  AppBlockingView.swift
//  Shared (App)
//
//  Created by Josh Calvert on 24/09/2026.
//
//  The app shell (SafeSightTabView) and the Filter tab.
//
//  SafeSightTabView gates the whole app: Google sign-in → PIN hand-off →
//  extension setup, then three tabs (Filter / Times / Settings).
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
            FilterView()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// The native iOS app shell. Gating order: sign-in, then the one-time PIN
/// hand-off, then the extension setup step; after that the three tabs.
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
                    FilterView()
                }
                .tabItem {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }

                NavigationStack {
                    TimesView()
                }
                .tabItem {
                    Label("Times", systemImage: "clock")
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

/// One counter in the status card: an accent icon, the count and its
/// caption in an equal-width column, so the row spans the card edge to
/// edge with no chip of its own. Fixed height keeps the row steady when
/// a count gains or loses a digit.
private struct StatTile: View {
    let count: Int
    let title: String
    let icon: String

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
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
        .frame(maxWidth: .infinity, minHeight: 58, maxHeight: 58)
    }
}

// MARK: - Filter

/// The Filter tab: protection status and counters at the top, then the
/// app-blocking controls and the web-filter settings, in that order.
struct FilterView: View {
    @StateObject private var settings = SharedSettings.shared
    @ObservedObject private var blocker = ScreenTimeBlocker.shared
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
            // Status — one card: what's protecting this device right now, the
            // live counters spanning its full width, and the pause control.
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

                    Divider()
                        .padding(.horizontal, -16)

                    HStack(alignment: .top, spacing: 0) {
                        StatTile(count: settings.scannedCount, title: "Scanned", icon: "eye")
                        StatTile(count: settings.blockedCount, title: "Blocked", icon: "hand.raised")
                        StatTile(count: settings.blocklistUser.count, title: "Sites", icon: "list.bullet")
                        StatTile(count: blocker.isBlocking ? blocker.selectionCount : 0, title: "Apps", icon: "timer")
                    }

                    Divider()
                        .padding(.horizontal, -16)

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
                // Full-bleed horizontally: the card spans the section frame,
                // the same edge the cards/buttons below sit on, instead of
                // being pinned 16pt inside them. Vertical stays tight.
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                .listRowBackground(Color.clear)
            } header: {
                Text("Status")
            } footer: {
                Text(settings.filtersEnabled
                     ? "The Safari extension applies your filter settings the next time a page loads — usually within seconds."
                     : "Nothing is being blocked while filters are paused.")
            }

            // -----------------------------------------------------------------
            // App blocking, then the web filter — the Filter page in order.
            // -----------------------------------------------------------------
            AppBlockingSections()
            WebFilterSections()
        }
        .navigationTitle("Filter")
        .onAppear {
            // The app group is shared with the Safari extension — re-read it
            // so counters pushed by the extension show up. Deferred a tick so
            // the publishes land after this view's own insertion transaction;
            // running them synchronously here coalesces with the row diffs of
            // the initial (or tab-switch) batch update.
            DispatchQueue.main.async {
                settings.reload()
                blocker.refreshAuthorization()
            }
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

            Text("Filter")
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
