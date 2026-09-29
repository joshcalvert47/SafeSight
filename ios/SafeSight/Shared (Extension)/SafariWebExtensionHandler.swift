//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Josh Calvert on 22/09/2026.
//
//  Native bridge between the SafeSight app and its Safari web extension.
//
//  A Safari web extension cannot read the app's App Group container from
//  JavaScript, so settings live in exactly one place — the App Group, written
//  by the app's Web Filter page — and the extension asks for them here:
//
//      chrome.runtime.sendNativeMessage(APP_BUNDLE_ID, { type: "getSettings" })
//
//  The extension mirrors whatever comes back into chrome.storage.local, which
//  is what its content script reads while it filters and blocks pages.
//  Counters travel the other way ({ type: "setStats" }) so the app's dashboard
//  shows the real numbers instead of zeroes.
//
//  Note: this file is shared by the iOS and macOS extension targets. It only
//  does something useful where the target has the App Group entitlement
//  (see "iOS (Extension)/SafeSight Extension.entitlements").
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    /// Shared container with the app — the single source of truth for settings.
    private static let appGroupID = "group.com.joshc.SafeSight"
    /// Guard rails: the extension can never store an unbounded list.
    private static let maxBlockedSites = 500
    private static let defaultSensitivity = 4

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]

        os_log(.default, "SafeSight bridge request: %@", String(describing: message))

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: Self.handle(message)]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // MARK: - Message handling

    private static func handle(_ raw: Any?) -> [String: Any] {
        guard let message = raw as? [String: Any],
              let type = message["type"] as? String else {
            return ["ok": false, "error": "Unsupported message"]
        }

        let defaults = UserDefaults(suiteName: appGroupID) ?? .standard

        switch type {
        case "getSettings":
            return ["ok": true, "settings": snapshot(from: defaults)]

        case "setSettings":
            guard let values = message["values"] as? [String: Any] else {
                return ["ok": false, "error": "Missing values"]
            }
            apply(values, to: defaults)
            return ["ok": true, "settings": snapshot(from: defaults)]

        case "setStats":
            guard let values = message["values"] as? [String: Any] else {
                return ["ok": false, "error": "Missing values"]
            }
            // Counters are owned by the extension; the app only reads them.
            if let scanned = intValue(values["scannedCount"]) {
                defaults.set(max(0, scanned), forKey: "scannedCount")
            }
            if let blocked = intValue(values["blockedCount"]) {
                defaults.set(max(0, blocked), forKey: "blockedCount")
            }
            return ["ok": true, "settings": snapshot(from: defaults)]

        default:
            return ["ok": false, "error": "Unsupported type: \(type)"]
        }
    }

    // MARK: - App Group access

    private static func snapshot(from defaults: UserDefaults) -> [String: Any] {
        [
            "skinFilter": defaults.bool(forKey: "skinFilter"),
            "blurAll": defaults.bool(forKey: "blurAll"),
            "sensitivity": sensitivity(from: defaults),
            "blocklistUser": defaults.stringArray(forKey: "blocklistUser") ?? [],
            "accountEmail": defaults.string(forKey: "unlockEmail") ?? "",
            "accountName": defaults.string(forKey: "unlockAccountName") ?? "",
            "accountReady": !((defaults.string(forKey: "unlockEmail") ?? "").isEmpty
                || (defaults.string(forKey: "unlockAccountName") ?? "").isEmpty),
            // Accounts created before approval existed default to approved so
            // they keep working; new registrations store "pending".
            "accountStatus": defaults.string(forKey: "accountStatus") ?? "approved",
            "clientId": defaults.string(forKey: "unlockClientId") ?? "",
            "filtersEnabled": defaults.object(forKey: "filtersEnabled") as? Bool ?? true,
            "quietEnabled": defaults.bool(forKey: "quietEnabled"),
            "quietStart": defaults.string(forKey: "quietStart") ?? "",
            "quietEnd": defaults.string(forKey: "quietEnd") ?? "",
            "scannedCount": max(0, defaults.integer(forKey: "scannedCount")),
            "blockedCount": max(0, defaults.integer(forKey: "blockedCount"))
        ]
    }

    private static func sensitivity(from defaults: UserDefaults) -> Int {
        guard defaults.object(forKey: "sensitivity") != nil else { return defaultSensitivity }
        return min(9, max(1, defaults.integer(forKey: "sensitivity")))
    }

    /// Everything written from the extension is validated here: the app trusts
    /// these values, so a bad payload can't put nonsense in the shared store.
    private static func apply(_ values: [String: Any], to defaults: UserDefaults) {
        if let flag = values["skinFilter"] as? Bool {
            defaults.set(flag, forKey: "skinFilter")
        }
        if let flag = values["blurAll"] as? Bool {
            defaults.set(flag, forKey: "blurAll")
        }
        if let level = intValue(values["sensitivity"]) {
            defaults.set(min(9, max(1, level)), forKey: "sensitivity")
        }
        if let raw = values["blocklistUser"] as? [String] {
            defaults.set(normalizedSites(raw), forKey: "blocklistUser")
        }
    }

    /// JavaScript numbers arrive as NSNumber, so accept either representation.
    private static func intValue(_ raw: Any?) -> Int? {
        if let value = raw as? Int { return value }
        if let value = raw as? Double { return Int(value) }
        if let value = raw as? NSNumber { return value.intValue }
        return nil
    }

    /// Same normalisation the app and the popup apply, so a site added on any
    /// surface is stored — and later matched — identically.
    private static func normalizedSites(_ raw: [String]) -> [String] {
        var seen = Set<String>()
        var sites: [String] = []
        for entry in raw {
            guard let site = normalize(entry), !seen.contains(site) else { continue }
            seen.insert(site)
            sites.append(site)
            if sites.count >= maxBlockedSites { break }
        }
        return sites
    }

    private static func normalize(_ entry: String) -> String? {
        var site = entry.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !site.isEmpty else { return nil }

        if let scheme = site.range(of: "://") {
            site = String(site[scheme.upperBound...])
        }
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
