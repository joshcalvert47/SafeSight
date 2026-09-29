//
//  AppBlocklist.swift
//  Shared (App)
//
//  Reads blocklist_apps.json — the shipped list of apps SafeSight tracks.
//  Screen Time (Family Controls) does the actual blocking, but its tokens can
//  only come from the system FamilyActivityPicker, so this file can never
//  block anything by itself: it detects which listed apps are installed to
//  suggest names during onboarding and in the Limits tab. On Android the same
//  file auto-blocks the tier "default" entries; keep both copies in sync.
//

import Foundation
#if os(iOS)
import UIKit
#endif

/// One row of blocklist_apps.json.
struct AppBlocklistEntry: Decodable, Identifiable {
    let name: String
    let tier: String?
    let android: String?
    let ios: String?
    let scheme: String?

    var id: String { name }

    /// "default" rows are auto-blocked on Android; everything else is a
    /// recommendation on both platforms.
    var isDefault: Bool { tier == "default" }
}

enum AppBlocklist {

    private struct FilePayload: Decodable {
        let enabled: Bool?
        let apps: [AppBlocklistEntry]?
    }

    /// Shipped rows, in file order. Parsed once; a bad file simply means no
    /// recommendations rather than a broken setup flow.
    static let entries: [AppBlocklistEntry] = {
        guard let url = Bundle.main.url(forResource: "blocklist_apps", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(FilePayload.self, from: data)
        else { return [] }
        return payload.apps ?? []
    }()

    /// The file-level switch: false turns every platform's handling off.
    static let isEnabled: Bool = {
        guard let url = Bundle.main.url(forResource: "blocklist_apps", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let payload = try? JSONDecoder().decode(FilePayload.self, from: data)
        else { return true }
        return payload.enabled ?? true
    }()

#if os(iOS)
    /// `canOpenURL` is the only installed-app check available without the
    /// restricted "App and Website Usage" entitlement: each row ships the URL
    /// scheme its app registers, which must also be listed under
    /// LSApplicationQueriesSchemes in Info.plist.
    static func isInstalled(_ entry: AppBlocklistEntry) -> Bool {
        guard isEnabled,
              let scheme = entry.scheme?.trimmingCharacters(in: .whitespaces),
              !scheme.isEmpty,
              let url = URL(string: "\(scheme)://")
        else { return false }
        return UIApplication.shared.canOpenURL(url)
    }

    /// Shipped entries that are actually on this device, ready to recommend.
    static var installedRecommendations: [AppBlocklistEntry] {
        entries.filter { isInstalled($0) }
    }
#endif
}
