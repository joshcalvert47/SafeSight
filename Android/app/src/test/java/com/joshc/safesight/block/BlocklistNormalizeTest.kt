package com.joshc.safesight.block

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BlocklistNormalizeTest {

    @Test
    fun `plain domain passes through`() {
        assertEquals("example.com", BlocklistRepository.normalizeSite("example.com"))
    }

    @Test
    fun `scheme, path, query and fragment stripped`() {
        assertEquals(
            "example.com",
            BlocklistRepository.normalizeSite("https://www.Example.com/path?x=1#f"),
        )
    }

    @Test
    fun `wildcard and www prefixes stripped`() {
        assertEquals("example.com", BlocklistRepository.normalizeSite("*.example.com"))
        assertEquals("example.com", BlocklistRepository.normalizeSite("www.example.com"))
    }

    @Test
    fun `port and userinfo stripped`() {
        assertEquals("example.com", BlocklistRepository.normalizeSite("example.com:8443"))
        assertEquals("example.com", BlocklistRepository.normalizeSite("user:pass@example.com"))
    }

    @Test
    fun `missing dot or empty rejected`() {
        assertNull(BlocklistRepository.normalizeSite("localhost"))
        assertNull(BlocklistRepository.normalizeSite("   "))
        assertNull(BlocklistRepository.normalizeSite(""))
    }

    @Test
    fun `host matching covers exact and subdomains`() {
        val sites = listOf("example.com", "blocked.net")
        assertTrue(BlocklistRepository.matches("example.com", sites))
        assertTrue(BlocklistRepository.matches("www.example.com", sites))
        assertTrue(BlocklistRepository.matches("sub.example.com", sites))
        assertFalse(BlocklistRepository.matches("notexample.com", sites))
        assertFalse(BlocklistRepository.matches("example.com.evil.net", sites))
        assertFalse(BlocklistRepository.matches("other.org", sites))
    }
}
