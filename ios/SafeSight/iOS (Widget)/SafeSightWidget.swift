//
//  SafeSightWidget.swift
//  SafeSight Widget
//
//  Home-screen status widget. Reads the shared app group directly (the app
//  writes these keys through SharedSettings) — no shared Swift files, so the
//  widget target stays dependency-free.
//

import WidgetKit
import SwiftUI

// MARK: - Model

struct ProtectionEntry: TimelineEntry {
    let date: Date
    let filtersOn: Bool
    let quietOn: Bool
    let quietActive: Bool
    let quietWindow: String
    let blockedSites: Int
}

struct ProtectionProvider: TimelineProvider {
    static let appGroup = "group.com.joshc.SafeSight"

    func placeholder(in context: Context) -> ProtectionEntry {
        ProtectionEntry(date: .now, filtersOn: true, quietOn: true,
                        quietActive: false, quietWindow: "22:00–06:00",
                        blockedSites: 12)
    }

    func getSnapshot(in context: Context, completion: @escaping (ProtectionEntry) -> Void) {
        completion(Self.loadEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ProtectionEntry>) -> Void) {
        let entry = Self.loadEntry()
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: .now) ?? .now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private static func loadEntry() -> ProtectionEntry {
        let d = UserDefaults(suiteName: appGroup) ?? .standard
        let filtersOn = d.object(forKey: "filtersEnabled") as? Bool ?? true
        let quietOn = d.bool(forKey: "quietEnabled")
        let start = d.string(forKey: "quietStart") ?? ""
        let end = d.string(forKey: "quietEnd") ?? ""
        let active = quietOn && isDuringQuiet(start: start, end: end, now: .now)
        let window = start.isEmpty || end.isEmpty ? "not set" : "\(start)–\(end)"
        return ProtectionEntry(
            date: .now,
            filtersOn: filtersOn,
            quietOn: quietOn,
            quietActive: active,
            quietWindow: window,
            blockedSites: (d.stringArray(forKey: "blocklistUser") ?? []).count
        )
    }

    /// Mirrors SharedSettings.isDuringQuietHours(start:end:now:).
    private static func isDuringQuiet(start: String, end: String, now: Date) -> Bool {
        guard let s = minutes(start), let e = minutes(end), s != e else { return false }
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let current = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        return s < e ? (current >= s && current < e) : (current >= s || current < e)
    }

    private static func minutes(_ value: String) -> Int? {
        let parts = value.split(separator: ":")
        guard parts.count == 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1]),
              (0...23).contains(hour),
              (0...59).contains(minute) else { return nil }
        return hour * 60 + minute
    }
}

// MARK: - View

struct ProtectionWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ProtectionEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(.indigo)
                Text("SafeSight")
                    .font(.headline)
                Spacer()
                Circle()
                    .fill(entry.filtersOn && !entry.quietActive ? Color.green : entry.quietActive ? Color.indigo : Color.orange)
                    .frame(width: 8, height: 8)
            }

            if entry.quietActive {
                Label("Quiet hours", systemImage: "moon.zzz.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.indigo)
            } else {
                Text(entry.filtersOn ? "Protection active" : "Filters paused")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(entry.filtersOn ? .green : .orange)
            }

            if family != .systemSmall {
                Text("\(entry.blockedSites) blocked site\(entry.blockedSites == 1 ? "" : "s") · quiet \(entry.quietWindow)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Quiet \(entry.quietWindow)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            Color(.secondarySystemBackground)
        }
    }
}

struct ProtectionWidget: Widget {
    let kind = "ProtectionWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ProtectionProvider()) { entry in
            ProtectionWidgetView(entry: entry)
        }
        .supportedFamilies([.systemSmall, .systemMedium])
        .configurationDisplayName("Protection Status")
        .description("Shows your filters, quiet hours and blocked-site count at a glance.")
    }
}

@main
struct SafeSightWidgetBundle: WidgetBundle {
    var body: some Widget {
        ProtectionWidget()
    }
}
