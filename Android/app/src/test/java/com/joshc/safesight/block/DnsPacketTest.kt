package com.joshc.safesight.block

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class DnsPacketTest {

    private fun dnsQuery(txid: Int): ByteArray {
        val name = "www.example.com".split(".").flatMap { label ->
            listOf(label.length.toByte()) + label.toByteArray().toList()
        }
        val out = ArrayList<Byte>()
        fun u16(v: Int) {
            out.add((v shr 8).toByte()); out.add(v.toByte())
        }
        u16(txid)
        u16(0x0100) // RD
        u16(1); u16(0); u16(0); u16(0)
        name.forEach { out.add(it) }
        out.add(0)
        u16(1) // A
        u16(1) // IN
        return out.toByteArray()
    }

    private fun ipPacket(src: ByteArray, dst: ByteArray, sport: Int, dport: Int, payload: ByteArray): ByteArray {
        val udpLen = 8 + payload.size
        val total = 20 + udpLen
        val pkt = ByteArray(total)
        pkt[0] = 0x45
        pkt[4] = 0x12; pkt[5] = 0x34 // id
        pkt[8] = 64
        pkt[9] = 17 // UDP
        src.copyInto(pkt, 12)
        dst.copyInto(pkt, 16)
        val csum = DnsPacket.checksum(pkt, 0, 20)
        pkt[10] = (csum shr 8).toByte()
        pkt[11] = csum.toByte()
        pkt[20] = (sport shr 8).toByte()
        pkt[21] = sport.toByte()
        pkt[22] = (dport shr 8).toByte()
        pkt[23] = dport.toByte()
        pkt[24] = (udpLen shr 8).toByte()
        pkt[25] = udpLen.toByte()
        payload.copyInto(pkt, 28)
        return pkt
    }

    @Test
    fun `parses a UDP DNS query`() {
        val pkt = ipPacket(
            byteArrayOf(1, 2, 3, 4), byteArrayOf(8, 8, 8, 8),
            53000, 53, dnsQuery(0x4242),
        )
        val q = DnsPacket.parse(pkt, pkt.size)
        assertNotNull(q)
        q!!
        assertEquals(53000, q.srcPort)
        assertEquals(53, q.dstPort)
        assertEquals(0x4242, q.txid)
        assertEquals("www.example.com", q.name)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), q.srcIp)
        assertArrayEquals(byteArrayOf(8, 8, 8, 8), q.dstIp)
    }

    @Test
    fun `NXDOMAIN response keeps id and question, sets rcode 3`() {
        val pkt = ipPacket(
            byteArrayOf(1, 2, 3, 4), byteArrayOf(8, 8, 8, 8),
            53000, 53, dnsQuery(0x4242),
        )
        val q = DnsPacket.parse(pkt, pkt.size)!!
        val resp = DnsPacket.buildNxDomain(q)
        val id = ((resp[0].toInt() and 0xFF) shl 8) or (resp[1].toInt() and 0xFF)
        val flags = ((resp[2].toInt() and 0xFF) shl 8) or (resp[3].toInt() and 0xFF)
        assertEquals(0x4242, id)
        assertEquals(1, flags and 0x8000 shr 15)          // QR
        assertEquals(3, flags and 0x0F)                   // rcode = NXDOMAIN
        val qd = ((resp[4].toInt() and 0xFF) shl 8) or (resp[5].toInt() and 0xFF)
        assertEquals(1, qd)
        val an = ((resp[6].toInt() and 0xFF) shl 8) or (resp[7].toInt() and 0xFF)
        assertEquals(0, an)
    }

    @Test
    fun `response packet swaps addresses and ports`() {
        val pkt = ipPacket(
            byteArrayOf(1, 2, 3, 4), byteArrayOf(8, 8, 8, 8),
            53000, 53, dnsQuery(0x4242),
        )
        val q = DnsPacket.parse(pkt, pkt.size)!!
        val wrapped = DnsPacket.buildResponsePacket(q, DnsPacket.buildNxDomain(q))
        val back = DnsPacket.parse(wrapped, wrapped.size)!!
        assertArrayEquals(byteArrayOf(8, 8, 8, 8), back.srcIp)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), back.dstIp)
        assertEquals(53, back.srcPort)
        assertEquals(53000, back.dstPort)
        assertEquals(0x4242, back.txid)
        assertEquals(3, back.flags and 0x0F)
    }

    @Test
    fun `non-UDP or truncated packets rejected`() {
        val junk = ByteArray(64) { 0 }
        assertEquals(null, DnsPacket.parse(junk, junk.size))
        assertEquals(null, DnsPacket.parse(ByteArray(4), 4))
    }
}
