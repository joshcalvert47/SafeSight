package com.joshc.safesight.block

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import com.joshc.safesight.data.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.Executors

/**
 * Local DNS firewall: TUN hands us every port-53 packet the system resolver
 * (our addDnsServer address) and the hardcoded upstream resolvers below send.
 * Queries for blocked sites (BlocklistRepository = single source of truth)
 * get NXDOMAIN; everything else is forwarded through a protected socket.
 *
 * Only routes DNS — all other traffic keeps using the physical network, so
 * there is no TCP stack to implement.
 */
class SafeSightVpnService : VpnService() {

    private var tun: ParcelFileDescriptor? = null
    private val executor = Executors.newFixedThreadPool(4)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var readerThread: Thread? = null

    @Volatile
    private var blocked: List<String> = emptyList()

    private var upstreams: List<InetAddress> = emptyList()
    private val tunAddr = "10.1.11.2"
    private val tunIpBytes = byteArrayOf(10, 1, 11, 2)
    private val store by lazy { SettingsStore(this) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }
        if (tun != null) return START_STICKY

        upstreams = captureSystemDns()
        scope.launch {
            BlocklistRepository(this@SafeSightVpnService, SettingsStore(this@SafeSightVpnService))
                .effective
                .collect { blocked = it }
        }

        val pfd = Builder()
            .setSession("SafeSight")
            .addAddress("10.1.11.1", 24)
            .addDnsServer(tunAddr)
            .addRoute("10.1.11.0", 24)
            .apply { COMMON_RESOLVERS.forEach { (ip, prefix) -> addRoute(ip, prefix) } }
            .addDisallowedApplication(packageName)
            .establish()

        if (pfd == null) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }
        tun = pfd
        startReading(pfd)
        return START_STICKY
    }

    override fun onRevoke() {
        shutdown()
        stopSelf()
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun startReading(pfd: ParcelFileDescriptor) {
        readerThread = Thread({
            val input = FileInputStream(pfd.fileDescriptor)
            val output = FileOutputStream(pfd.fileDescriptor)
            val buf = ByteArray(32767)
            runCatching {
                while (!Thread.currentThread().isInterrupted) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    val query = DnsPacket.parse(buf, n) ?: continue
                    if (query.dstPort != 53) continue // never routed, but drop anyway
                    executor.execute { handle(query, output) }
                }
            }
            runCatching { pfd.close() }
        }, "safesight-dns-reader").apply { isDaemon = true; start() }
    }

    private fun handle(query: DnsPacket.Query, output: FileOutputStream) {
        val name = query.name.lowercase().trim('.')
        val isBlocked = name.isNotEmpty() && BlocklistRepository.matches(name, blocked)
        val payload = if (isBlocked) {
            scope.launch { store.incrementStats(blocked = 1) }
            DnsPacket.buildNxDomain(query)
        } else {
            forward(query) ?: return // upstream timeout: stay silent, client retries
        }
        val pkt = DnsPacket.buildResponsePacket(query, payload)
        runCatching {
            synchronized(output) {
                output.write(pkt)
                output.flush()
            }
        }
    }

    /** Relay the query to the resolver the client addressed (or system DNS). */
    private fun forward(query: DnsPacket.Query): ByteArray? {
        val target: InetAddress = if (query.dstIp.contentEquals(tunIpBytes)) {
            upstreams.firstOrNull() ?: InetAddress.getByName("8.8.8.8")
        } else {
            InetAddress.getByAddress(query.dstIp)
        }
        val payload = ByteArray(4096)
        return DatagramSocket().use { sock ->
            runCatching {
                protect(sock)
                sock.soTimeout = 3000
                val dns = originalDns(query)
                sock.send(DatagramPacket(dns, dns.size, target, 53))
                val resp = DatagramPacket(payload, payload.size)
                sock.receive(resp)
                payload.copyOf(resp.length)
            }.getOrNull()
        }
    }

    /**
     * The original DNS datagram bytes are not retained by parse(); rebuild a
     * standard query (txid, RD, one question) — sufficient for every resolver.
     */
    private fun originalDns(query: DnsPacket.Query): ByteArray {
        val out = ArrayList<Byte>(query.question.size + 12)
        fun u16(v: Int) {
            out.add((v shr 8).toByte())
            out.add(v.toByte())
        }
        u16(query.txid)
        u16(0x0100) // RD=1
        u16(1)      // qdcount
        u16(0); u16(0); u16(0)
        out += query.question.toList()
        return out.toByteArray()
    }

    private fun captureSystemDns(): List<InetAddress> {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val servers = cm.activeNetwork
            ?.let { cm.getLinkProperties(it)?.dnsServers }
            .orEmpty()
            .filterIsInstance<Inet4Address>()
            .filter { !it.isLoopbackAddress && it.hostAddress != tunAddr }
        return if (servers.isNotEmpty()) servers
        else listOf(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("1.1.1.1"))
    }

    private fun shutdown() {
        readerThread?.interrupt()
        readerThread = null
        runCatching { tun?.close() }
        tun = null
        executor.shutdownNow()
        scope.cancel()
    }

    companion object {
        const val ACTION_STOP = "com.joshc.safesight.action.STOP_VPN"

        /** Public + common-family resolvers routed into the TUN for filtering. */
        private val COMMON_RESOLVERS = listOf(
            "8.8.8.8" to 32, "8.8.4.4" to 32,
            "1.1.1.1" to 32, "1.0.0.1" to 32,
            "9.9.9.9" to 32, "149.112.112.112" to 32,
            "208.67.222.222" to 32, "208.67.220.220" to 32,
            "94.140.14.14" to 32, "94.140.15.15" to 32,
            "76.76.2.0" to 24, "76.76.10.0" to 24,
            "185.228.168.9" to 32, "185.228.169.9" to 32,
            "8.26.56.26" to 32, "8.20.247.20" to 32,
            "64.6.64.6" to 32, "64.6.65.6" to 32,
            "77.88.8.8" to 32, "77.88.8.1" to 32,
        )
    }
}
