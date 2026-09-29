package com.joshc.safesight.block

/**
 * Minimal IPv4/UDP/DNS codec — just enough to intercept port-53 traffic
 * flowing through the TUN and inject responses. No TCP support: packets that
 * are not DNS simply never get a reply (accepted v1 limitation).
 */
object DnsPacket {

    private const val PROTO_UDP = 17

    data class Query(
        val srcIp: ByteArray,
        val srcPort: Int,
        val dstIp: ByteArray,
        val dstPort: Int,
        val txid: Int,
        val flags: Int,
        val question: ByteArray,
        val name: String,
    )

    /** Parse an IPv4/UDP datagram; null if not UDP or malformed. */
    fun parse(buf: ByteArray, length: Int): Query? {
        if (length < 28) return null
        if (buf[0].toInt() shr 4 != 4) return null
        if (buf[9].toInt() != PROTO_UDP) return null
        val ihl = (buf[0].toInt() and 0xF) * 4
        if (ihl < 20 || length < ihl + 8) return null
        val udpLen = u16(buf, ihl + 4)
        if (udpLen < 8 || length < ihl + udpLen) return null
        val payload = buf.copyOfRange(ihl + 8, ihl + udpLen)
        if (payload.size < 12) return null
        return Query(
            srcIp = buf.copyOfRange(12, 16),
            srcPort = u16(buf, ihl),
            dstIp = buf.copyOfRange(16, 20),
            dstPort = u16(buf, ihl + 2),
            txid = u16(payload, 0),
            flags = u16(payload, 2),
            question = extractQuestion(payload),
            name = readName(payload, 12).first,
        )
    }

    /** First question section (name + type + class), or empty. */
    private fun extractQuestion(dns: ByteArray): ByteArray {
        val end = readName(dns, 12).second + 4
        if (end > dns.size) return ByteArray(0)
        return dns.copyOfRange(12, end)
    }

    /** Compression-aware name reader; returns name and offset after it. */
    fun readName(dns: ByteArray, start: Int): Pair<String, Int> {
        val labels = mutableListOf<String>()
        var pos = start
        var next = -1
        var hops = 0
        while (pos < dns.size && hops++ < 64) {
            val len = dns[pos].toInt() and 0xFF
            when {
                len == 0 -> {
                    pos++
                    if (next < 0) next = pos
                    break
                }

                len and 0xC0 == 0xC0 -> {
                    if (pos + 1 >= dns.size) break
                    val ptr = ((len and 0x3F) shl 8) or (dns[pos + 1].toInt() and 0xFF)
                    if (next < 0) next = pos + 2
                    pos = ptr
                }

                else -> {
                    pos++
                    if (pos + len > dns.size) break
                    labels += String(dns, pos, len, Charsets.ISO_8859_1)
                    pos += len
                }
            }
        }
        if (next < 0) next = pos
        return labels.joinToString(".") to next
    }

    /** NXDOMAIN for the queried name (flags copied, rcode=3, no answers). */
    fun buildNxDomain(q: Query): ByteArray {
        val out = ArrayList<Byte>(q.question.size + 12)
        fun u16v(v: Int) {
            out.add((v shr 8).toByte())
            out.add(v.toByte())
        }
        u16v(q.txid)
        // QR=1, copy opcode+RD from query, RA=1, rcode=NXDOMAIN
        val flags = 0x8000 or (q.flags and 0x7900) or 0x0080 or 0x0003
        u16v(flags)
        u16v(1)  // qdcount
        u16v(0); u16v(0); u16v(0)
        out += q.question.toList()
        return out.toByteArray()
    }

    /** Wrap a DNS payload in an IPv4/UDP packet (UDP checksum left 0). */
    fun buildResponsePacket(q: Query, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val total = 20 + udpLen
        val pkt = ByteArray(total)
        pkt[0] = 0x45
        pkt[2] = (total shr 8).toByte()
        pkt[3] = total.toByte()
        pkt[8] = 64 // ttl
        pkt[9] = PROTO_UDP.toByte()
        q.dstIp.copyInto(pkt, 12) // src = resolver the query was sent to
        q.srcIp.copyInto(pkt, 16) // dst = original client
        val ipCsum = checksum(pkt, 0, 20)
        pkt[10] = (ipCsum shr 8).toByte()
        pkt[11] = ipCsum.toByte()
        pkt[20] = (q.dstPort shr 8).toByte()
        pkt[21] = q.dstPort.toByte()
        pkt[22] = (q.srcPort shr 8).toByte()
        pkt[23] = q.srcPort.toByte()
        pkt[24] = (udpLen shr 8).toByte()
        pkt[25] = udpLen.toByte()
        payload.copyInto(pkt, 28)
        return pkt
    }

    fun checksum(data: ByteArray, offset: Int, length: Int): Int {
        var sum = 0L
        var i = offset
        while (i < offset + length - 1) {
            sum += ((data[i].toInt() and 0xFF) shl 8) or (data[i + 1].toInt() and 0xFF)
            i += 2
        }
        if (length % 2 != 0) sum += (data[offset + length - 1].toInt() and 0xFF) shl 8
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        return sum.inv().toInt() and 0xFFFF
    }

    private fun u16(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)
}
