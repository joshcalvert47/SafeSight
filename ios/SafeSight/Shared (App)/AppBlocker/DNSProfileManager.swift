//
//  DNSProfileManager.swift
//  SafeSight (iOS)
//
//  Installs/removes the on-demand packet-tunnel DNS profile so filtering
//  covers every app on the device, not just Safari. The tunnel itself lives
//  in the SafeSight DNS extension; this is only the app-side toggle.
//

#if os(iOS) && canImport(NetworkExtension)
import Foundation
import Combine
import NetworkExtension

@MainActor
final class DNSProfileManager: ObservableObject {

    static let shared = DNSProfileManager()
    static let providerBundleID = "com.joshc.SafeSight.DNS"

    enum State: Equatable {
        case unknown
        case disabled
        case enabled
    }

    @Published private(set) var state: State = .unknown
    @Published var lastError: String?

    private init() {}

    func refresh() {
        Task {
            do {
                let managers = try await NETunnelProviderManager.loadAllFromPreferences()
                if let manager = managers.first(where: {
                    ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == Self.providerBundleID
                }) {
                    state = (manager.isEnabled && manager.isOnDemandEnabled) ? .enabled : .disabled
                } else {
                    state = .disabled
                }
            } catch {
                lastError = error.localizedDescription
                state = .unknown
            }
        }
    }

    func setEnabled(_ enabled: Bool) {
        Task {
            do {
                let managers = try await NETunnelProviderManager.loadAllFromPreferences()
                let manager = managers.first(where: {
                    ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == Self.providerBundleID
                }) ?? NETunnelProviderManager()

                let protocolConfig = NETunnelProviderProtocol()
                protocolConfig.providerBundleIdentifier = Self.providerBundleID
                protocolConfig.serverAddress = "SafeSight DNS Filter"
                manager.protocolConfiguration = protocolConfig
                manager.isEnabled = true
                manager.isOnDemandEnabled = enabled
                manager.onDemandRules = enabled ? [NEOnDemandRuleConnect()] : []
                if !enabled {
                    manager.connection.stopVPNTunnel()
                }

                // First save prompts the system's "Add VPN Configuration" sheet.
                try await manager.saveToPreferences()
                try await manager.loadFromPreferences()
                state = enabled ? .enabled : (manager.isOnDemandEnabled ? .enabled : .disabled)
                lastError = nil
            } catch {
                lastError = error.localizedDescription
                state = .unknown
            }
        }
    }
}
#endif
