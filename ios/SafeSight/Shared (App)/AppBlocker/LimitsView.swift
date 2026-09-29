//
//  LimitsView.swift
//  Shared (App)
//  iOS target only.
//
//  "Limits" tab — quiet hours (web, enforced by the Safari extension) and
//  app blocking (Screen Time / Family Controls, enforced by ManagedSettings).
//

import SwiftUI
import FamilyControls
import ManagedSettings

struct LimitsView: View {
    @StateObject private var settings = SharedSettings.shared
    @ObservedObject private var blocker = ScreenTimeBlocker.shared
    @State private var pinGate: PinGate?

    // Picker draft — committed on Done; a draft that *removes* something from
    // the current selection is a weakening action and goes through the PIN.
    @State private var draft = FamilyActivitySelection()
    @State private var pickerPresented = false
    @State private var didCommitDraft = false

    private let defaultStart = (hour: 22, minute: 0)
    private let defaultEnd = (hour: 6, minute: 0)

    var body: some View {
        Form {
            // -----------------------------------------------------------------
            // App blocking — Screen Time.
            // -----------------------------------------------------------------
            Section {
                if blocker.authorizationState != .approved {
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
                                .frame(maxWidth: .infinity)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(blocker.isRequestingAuthorization)

                    if blocker.authorizationState == .denied {
                        Label("Denied — enable SafeSight in Settings → Screen Time → Apps with Screen Time Access",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }

                Toggle("Block Selected Apps", isOn: Binding(
                    get: { blocker.isBlocking },
                    set: { enabled in
                        if enabled {
                            blocker.enableBlocking()
                        } else {
                            pinGate = PinGate(
                                title: "Stop blocking apps",
                                reason: "Your selected apps will be openable again until you turn blocking back on.",
                                perform: { blocker.disableBlocking() }
                            )
                        }
                    }
                ))
                .disabled(blocker.authorizationState != .approved
                          || (!blocker.isBlocking && !blocker.hasSelection))

                LabeledContent("Blocked") {
                    Text(blocker.isBlocking ? blocker.selectionSummary : "Off")
                        .foregroundStyle(.secondary)
                }

                Button {
                    draft = blocker.selection
                    didCommitDraft = false
                    pickerPresented = true
                } label: {
                    Text("Choose Apps…")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(blocker.authorizationState != .approved)
            } header: {
                Text("App Blocking")
            } footer: {
                Text("Screen Time lets iOS block the selected apps everywhere on this device. SafeSight only asks for access once — turning blocking off needs your PIN.")
            }

            // -----------------------------------------------------------------
            // Quiet hours — enforced in Safari by the extension.
            // -----------------------------------------------------------------
            Section {
                Toggle("Quiet Hours", isOn: Binding(
                    get: { settings.quietEnabled },
                    set: { enabled in
                        if enabled {
                            if SharedSettings.minutes(settings.quietStart) == nil {
                                settings.quietStart = Self.format(defaultStart)
                            }
                            if SharedSettings.minutes(settings.quietEnd) == nil {
                                settings.quietEnd = Self.format(defaultEnd)
                            }
                            settings.quietEnabled = true
                        } else {
                            pinGate = PinGate(
                                title: "Turn off quiet hours",
                                reason: "Safari will stop blocking browsing outside the window until you turn this back on.",
                                perform: { settings.quietEnabled = false }
                            )
                        }
                    }
                ))

                DatePicker("From", selection: timeBinding(\.quietStart, fallback: defaultStart), displayedComponents: .hourAndMinute)
                    .disabled(!settings.quietEnabled)
                DatePicker("Until", selection: timeBinding(\.quietEnd, fallback: defaultEnd), displayedComponents: .hourAndMinute)
                    .disabled(!settings.quietEnabled)

                if settings.quietEnabled && settings.isDuringQuietHours() {
                    Label(downtimeLabel, systemImage: "moon.zzz.fill")
                        .font(.footnote)
                        .foregroundStyle(.indigo)
                }
            } header: {
                Text("Quiet Hours")
            } footer: {
                Text(quietFooter)
            }
        }
        .navigationTitle("Limits")
        .onAppear {
            settings.reload()
            blocker.refreshAuthorization()
        }
        .pinGated($pinGate)
        .sheet(isPresented: $pickerPresented) { pickerSheet }
    }

    // MARK: - App picker

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
    /// anything from the current selection, the account PIN comes first.
    private func commitDraft() {
        didCommitDraft = true
        pickerPresented = false

        let removesAnything =
            !blocker.selection.applicationTokens.isSubset(of: draft.applicationTokens) ||
            !blocker.selection.categoryTokens.isSubset(of: draft.categoryTokens) ||
            !blocker.selection.webDomainTokens.isSubset(of: draft.webDomainTokens)

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

    // MARK: - Copy

    private var quietFooter: String {
        guard settings.quietEnabled else {
            return "When on, Safari blocks every page during the window — not just your blocked list. Turning quiet hours off asks for your PIN."
        }
        var copy = "Safari blocks every page from \(settings.quietStart) to \(settings.quietEnd)"
        if let minutes = SharedSettings.quietMinutes(start: settings.quietStart, end: settings.quietEnd) {
            copy += " (\(minutes / 60)h \(minutes % 60)m)"
        }
        copy += ". The window can wrap midnight."
        return copy
    }

    private var downtimeLabel: String {
        "Downtime active — Safari is blocked until \(settings.quietEnd)"
    }

    // MARK: - Date helpers

    /// "HH:mm" string <-> DatePicker Date (anchored to today).
    private func timeBinding(_ keyPath: ReferenceWritableKeyPath<SharedSettings, String>,
                             fallback: (hour: Int, minute: Int)) -> Binding<Date> {
        Binding(
            get: {
                let value = settings[keyPath: keyPath]
                let parts = SharedSettings.minutes(value).map { ($0 / 60, $0 % 60) }
                    ?? (fallback.hour, fallback.minute)
                return Self.date(hour: parts.0, minute: parts.1)
            },
            set: { date in
                settings[keyPath: keyPath] = Self.format(Self.hourMinute(date))
            }
        )
    }

    private static func date(hour: Int, minute: Int) -> Date {
        Calendar.current.date(
            bySettingHour: hour, minute: minute, second: 0, of: Date()
        ) ?? Date()
    }

    private static func hourMinute(_ date: Date) -> (hour: Int, minute: Int) {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0, parts.minute ?? 0)
    }

    private static func format(_ hourMinute: (hour: Int, minute: Int)) -> String {
        String(format: "%02d:%02d", hourMinute.hour, hourMinute.minute)
    }
}
