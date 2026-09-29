//
//  SafeSightIntents.swift
//  Shared (App)
//  iOS target only.
//
//  Siri / Shortcuts / App Intents. Only non-weakening actions are exposed:
//  intents can't show UI, so anything that would loosen protection (pausing
//  filters, quiet hours off, unblocking) must go through the in-app PIN gate.
//

import AppIntents
import Foundation

/// "How's my protection?" — reports status without opening the app.
struct CheckProtectionIntent: AppIntent {
    static var title: LocalizedStringResource = "Check SafeSight Status"
    static var description = IntentDescription(
        "Tells you whether web filters, quiet hours and app blocking are on."
    )
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = SharedSettings.shared
        settings.reload()

        var parts: [String] = []
        parts.append(settings.filtersEnabled
            ? "Web filters are on"
            : "Web filters are paused")

        if let count = settings.blocklistUser.isEmpty ? nil : settings.blocklistUser.count {
            parts.append("\(count) blocked site\(count == 1 ? "" : "s")")
        }

        if settings.quietEnabled {
            var quiet = "quiet hours \(settings.quietStart) to \(settings.quietEnd)"
            if settings.isDuringQuietHours() {
                quiet += " — active now"
            }
            parts.append(quiet)
        }

        #if os(iOS)
        let blocker = ScreenTimeBlocker.shared
        if blocker.isBlocking && blocker.hasSelection {
            parts.append("app blocking \(blocker.selectionSummary)")
        }
        #endif

        return .result(dialog: "\(parts.joined(separator: ", ")).")
    }
}

/// Turns quiet hours on — a tightening action, so no PIN is needed.
struct StartQuietHoursIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Quiet Hours"
    static var description = IntentDescription(
        "Blocks all Safari browsing until the quiet-hours end time."
    )
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let settings = SharedSettings.shared
        settings.reload()
        guard !settings.isDuringQuietHours() else {
            return .result(dialog: "Quiet hours are already active.")
        }
        settings.quietEnabled = true
        return .result(dialog: "Quiet hours on — Safari is blocked until \(settings.quietEnd).")
    }
}
