//
//  PacketTunnelProvider.swift
//  SafeSight DNS
//
//  DNS-level filtering for the whole device (all apps, not just Safari).
//  The tunnel only routes the configured resolver's traffic into itself:
//    - iOS sends every lookup to 1.1.1.1 (dnsSettings + matchDomains [""]),
//      routed in via includedRoutes (1.1.1.1/32).
//    - Queries are checked against the app-group blocklist (and quiet hours,
//      which blocks everything) — blocked ones get NXDOMAIN, the rest are
//      forwarded upstream over a plain UDP connection and relayed back.
//  All other traffic never enters the tunnel, so there is nothing else to
//  forward or drop.
//

import NetworkExtension
import Network
import Foundation

final class PacketTunnelProvider: NEPacketTunnelProvider {

    private static let appGroup = "group.com.joshc.SafeSight"

    // MARK: State

    private let lock = NSLock()
    /// txID -> (source IPv4, source port) so upstream replies can be wrapped
    /// back into a response for the original client.
    private var pending: [UInt16: (srcIP: Data, srcPort: UInt16)] = [:]

    private var blockedDomains: Set<String> = []
    private var filtersOn = true
    private var quietActive = false
    private var lastReload = Date.distantPast

    private var upstream: NWConnection?
    private var stopped = false
    private let workQueue = DispatchQueue(label: "SafeSight.DNS.Provider")

    // MARK: Tunnel lifecycle

    override func startTunnel(options: [String: NSObject]?,
                              completionHandler startTunnelHandler: @escaping (Error?) -> Void) {
        reload(force: true)
        startUpstream()

        let network = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "198.18.0.1")

        let dns = NEDNSSettings(servers: ["1.1.1.1"])
        dns.matchDomains = [""] // every lookup goes to the filtered resolver
        network.dnsSettings = dns

        let ipv4 = NEIPv4Settings(addresses: ["198.18.0.2"], subnetMasks: ["255.255.255.0"])
        // Only the resolver's address is routed into the tunnel — everything
        // else keeps flowing normally outside it.
        ipv4.includedRoutes = [
            NEIPv4Route(destinationAddress: "1.1.1.1", subnetMask: "255.255.255.255")
        ]
        network.ipv4Settings = ipv4
        network.mtu = 1500

        setTunnelNetworkSettings(network) { [weak self] error in
            if let error {
                startTunnelHandler(error)
                return
            }
            self?.readLoop()
            startTunnelHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        stopped = true
        upstream?.cancel()
        upstream = nil
        completionHandler()
    }

    // MARK: Settings (from the app group)

    private func reload(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastReload) > 10 else { return }
        lastReload = Date()
        let defaults = UserDefaults(suiteName: Self.appGroup) ?? .standard
        blockedDomains = Set((defaults.stringArray(forKey: "blocklistUser") ?? []).map { $0.lowercased() })
        filtersOn = defaults.object(forKey: "filtersEnabled") as? Bool ?? true
        quietActive = Self.isDuringQuiet(
            start: defaults.string(forKey: "quietStart") ?? "",
            end: defaults.string(forKey: "quietEnd") ?? "",
            now: Date()
        ) && defaults.bool(forKey: "quietEnabled")
    }

    /// Mirrors SharedSettings.isDuringQuietHours(start:end:now:).
    private static func isDuringQuiet(start: String, end: String, now: Date) -> Bool {
        guard let s = Self.minutes(start), let e = Self.minutes(end), s != e else { return false }
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

    private func isBlocked(_ domain: String) -> Bool {
        if blockedDomains.contains(domain) { return true }
        var labels = domain.split(separator: ".")
        labels.removeFirst()
        while !labels.isEmpty {
            if blockedDomains.contains(labels.joined(separator: ".")) { return true }
            labels.removeFirst()
        }
        return false
    }

    // MARK: Packet loop

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            for (index, packet) in packets.enumerated() {
                guard protocols[index].int32Value == AF_INET else { continue }
                if let response = self.handleIPv4(packet) {
                    self.write(response)
                }
            }
            self.readLoop()
        }
    }

    private func write(_ packet: Data) {
        packetFlow.writePackets([packet], withProtocols: [NSNumber(value: AF_INET)])
    }

    /// Handles one IPv4 packet: only UDP/53 (queries to the resolver) is
    /// interesting; anything else is ignored (it isn't routed here anyway).
    private func handleIPv4(_ packet: Data) -> Data? {
        reload()
        guard packet.count >= 28, packet[packet.startIndex] >> 4 == 4 else { return nil }
        let ihl = Int(packet[packet.startIndex] & 0x0F) * 4
        guard ihl >= 20, packet.count >= ihl + 8, packet[packet.startIndex + 9] == 17 else { return nil }

        let udp = packet.startIndex + ihl
        let dstPort = (UInt16(packet[udp + 2]) << 8) | UInt16(packet[udp + 3])
        guard dstPort == 53 else { return nil }

        let dns = packet.subdata(in: (udp + 8)..<packet.endIndex)
        guard dns.count >= 12, let queryName = Self.queryName(in: dns) else { return nil }

        let srcIP = packet.subdata(in: (packet.startIndex + 12)..<(packet.startIndex + 16))
        let srcPort = (UInt16(packet[udp]) << 8) | UInt16(packet[udp + 1])

        if !filtersOn {
            forward(dns, srcIP: srcIP, srcPort: srcPort)
            return nil
        }

        // Quiet hours block every lookup — same "everything is off" behavior
        // as the Safari extension's quiet-hours redirect.
        if quietActive || isBlocked(queryName) {
            guard let payload = Self.nxDomainResponse(for: dns) else { return nil }
            return Self.response(toQuery: packet, dnsPayload: payload)
        }

        forward(dns, srcIP: srcIP, srcPort: srcPort)
        return nil
    }

    /// "www.example.com" from a DNS question section (offset 12).
    private static func queryName(in dns: Data) -> String? {
        guard dns.count > 12 else { return nil }
        var index = dns.startIndex + 12
        var labels: [String] = []
        while index < dns.endIndex {
            let length = Int(dns[index])
            index = dns.index(after: index)
            guard length > 0 else { break }
            guard dns.distance(from: index, to: dns.endIndex) >= length else { return nil }
            let end = dns.index(index, offsetBy: length)
            labels.append(String(data: dns[index..<end], encoding: .utf8) ?? "")
            index = end
        }
        guard !labels.isEmpty else { return nil }
        return labels.joined(separator: ".").lowercased()
    }

    // MARK: Upstream

    private func startUpstream() {
        let connection = NWConnection(
            host: NWEndpoint.Host("1.1.1.1"),
            port: NWEndpoint.Port(rawValue: 53)!,
            using: .udp
        )
        upstream = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.receiveUpstream()
            case .failed:
                // Reconnect; queries stall briefly meanwhile.
                self?.workQueue.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, !self.stopped else { return }
                    self.startUpstream()
                }
            default:
                break
            }
        }
        connection.start(queue: workQueue)
    }

    private func forward(_ dns: Data, srcIP: Data, srcPort: UInt16) {
        guard dns.count >= 2 else { return }
        let id = (UInt16(dns[dns.startIndex]) << 8) | UInt16(dns[dns.startIndex + 1])
        lock.lock()
        pending[id] = (srcIP, srcPort)
        if pending.count > 512 { pending.removeAll() } // safety valve
        lock.unlock()
        upstream?.send(content: dns, completion: .contentProcessed { _ in })
    }

    private func receiveUpstream() {
        upstream?.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, data.count >= 12 {
                self.handleUpstream(data)
            }
            if error == nil {
                self.receiveUpstream()
            }
        }
    }

    private func handleUpstream(_ dns: Data) {
        let id = (UInt16(dns[dns.startIndex]) << 8) | UInt16(dns[dns.startIndex + 1])
        lock.lock()
        let context = pending.removeValue(forKey: id)
        lock.unlock()
        guard let context else { return }
        guard let packet = Self.response(
            toSourceIP: context.srcIP,
            sourcePort: 53,
            destinationPort: context.srcPort,
            dnsPayload: dns
        ) else { return }
        write(packet)
    }

    // MARK: Packet crafting

    /// Wraps a DNS payload as an IPv4/UDP response for the client that sent
    /// `query` (addresses/ports swapped, checksums recomputed).
    private static func response(toQuery query: Data, dnsPayload: Data) -> Data? {
        guard query.count >= 28 else { return nil }
        let ihl = Int(query[query.startIndex] & 0x0F) * 4
        let udp = query.startIndex + ihl

        var out = Data(count: ihl + 8 + dnsPayload.count)
        out.replaceSubrange(0..<(ihl + 8), with: query[query.startIndex..<(query.startIndex + ihl + 8)])

        // Swap source/destination IPv4.
        let srcRange = 12..<16
        let dstRange = 16..<20
        let srcBytes = Data(out[srcRange])
        out.replaceSubrange(srcRange, with: out[dstRange])
        out.replaceSubrange(dstRange, with: srcBytes)

        // Total length.
        let total = UInt16(ihl + 8 + dnsPayload.count)
        out[2] = UInt8(total >> 8)
        out[3] = UInt8(total & 0xFF)

        // IPv4 header checksum.
        out[10] = 0
        out[11] = 0
        let sum = internetChecksum(out[0..<ihl])
        out[10] = UInt8(sum >> 8)
        out[11] = UInt8(sum & 0xFF)

        // UDP length + zero checksum (optional for IPv4).
        let udpLength = UInt16(8 + dnsPayload.count)
        out[udp] = UInt8(udpLength >> 8)
        out[udp + 1] = UInt8(udpLength & 0xFF)
        out[udp + 2] = 0
        out[udp + 3] = 0

        out.replaceSubrange((ihl + 8)..<out.endIndex, with: dnsPayload)
        return out
    }

    /// Builds a response for a client address that didn't originate from a
    /// captured query (upstream replies).
    private static func response(toSourceIP srcIP: Data, sourcePort: UInt16,
                                 destinationPort: UInt16, dnsPayload: Data) -> Data? {
        guard srcIP.count == 4, dnsPayload.count >= 12 else { return nil }
        let ihl = 20
        var out = Data(count: ihl + 8 + dnsPayload.count)

        out[0] = 0x45                    // v4, IHL 5
        out[1] = 0
        let total = UInt16(ihl + 8 + dnsPayload.count)
        out[2] = UInt8(total >> 8)
        out[3] = UInt8(total & 0xFF)
        out[4] = 0
        out[5] = 0
        out[6] = 0x40                    // DF
        out[7] = 0
        out[8] = 64                      // TTL
        out[9] = 17                      // UDP
        out.replaceSubrange(12..<16, with: Data([1, 1, 1, 1]))       // from resolver
        out.replaceSubrange(16..<20, with: srcIP)                     // to client
        let sum = internetChecksum(out[0..<ihl])
        out[10] = UInt8(sum >> 8)
        out[11] = UInt8(sum & 0xFF)

        let udp = ihl
        out[udp] = UInt8(sourcePort >> 8)
        out[udp + 1] = UInt8(sourcePort & 0xFF)
        out[udp + 2] = UInt8(destinationPort >> 8)
        out[udp + 3] = UInt8(destinationPort & 0xFF)
        let udpLength = UInt16(8 + dnsPayload.count)
        out[udp + 4] = UInt8(udpLength >> 8)
        out[udp + 5] = UInt8(udpLength & 0xFF)
        out[udp + 6] = 0
        out[udp + 7] = 0

        out.replaceSubrange((ihl + 8)..<out.endIndex, with: dnsPayload)
        return out
    }

    /// The query with QR=1, RCODE=NXDOMAIN, RA=1.
    private static func nxDomainResponse(for dns: Data) -> Data? {
        guard dns.count >= 12 else { return nil }
        var out = dns
        let start = out.startIndex
        out[start + 2] = out[start + 2] | 0x80           // QR
        out[start + 3] = (out[start + 3] & 0xF0) | 0x03  // RCODE = NXDOMAIN
        out[start + 3] = out[start + 3] | 0x80           // RA
        return out
    }

    private static func internetChecksum(_ bytes: Data) -> UInt16 {
        var sum: UInt32 = 0
        var index = bytes.startIndex
        while index < bytes.endIndex {
            var word = UInt32(bytes[index]) << 8
            let next = bytes.index(after: index)
            if next < bytes.endIndex {
                word |= UInt32(bytes[next])
                index = next
            }
            sum += word
            index = bytes.index(after: index)
        }
        while sum >> 16 != 0 {
            sum = (sum & 0xFFFF) + (sum >> 16)
        }
        return ~UInt16(truncatingIfNeeded: sum)
    }
}
