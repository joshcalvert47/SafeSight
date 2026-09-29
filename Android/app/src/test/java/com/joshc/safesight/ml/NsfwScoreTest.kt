package com.joshc.safesight.ml

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Score-math parity tests against chrome/offscreen.js lines 71-86 and the
 * expectations in chrome/modeltest/test.html.
 */
class NsfwScoreTest {

    @Test
    fun `neutral-heavy image scores 0`() {
        // neutral > 0.85 and (porn+hentai+sexy)*10 < 2 → forced to 0
        val probs = floatArrayOf(0.01f, 0.02f, 0.90f, 0.03f, 0.04f)
        assertEquals(0, NsfwScore.compute(probs))
    }

    @Test
    fun `porn-heavy image scores high`() {
        val probs = floatArrayOf(0.01f, 0.01f, 0.03f, 0.90f, 0.05f)
        // (0.90 + 0.01 + 0.05) * 10 = 9.6 → round → 10
        assertEquals(10, NsfwScore.compute(probs))
    }

    @Test
    fun `borderline image scores 5`() {
        val probs = floatArrayOf(0.10f, 0.05f, 0.40f, 0.35f, 0.10f)
        // (0.35 + 0.05 + 0.10) * 10 = 5.0 → 5
        assertEquals(5, NsfwScore.compute(probs))
    }

    @Test
    fun `logits are normalized by their total`() {
        // Raw logits > 1 → divided by sum (100) before scoring, matching JS.
        val logits = floatArrayOf(1f, 1f, 94f, 3f, 1f)
        // probs: neutral .94, porn .03, hentai .01, sexy .01
        // score = (0.03+0.01+0.01)*10 = 0.5, neutral .94 > .85 and < 2 → 0
        assertEquals(0, NsfwScore.compute(logits))
    }

    @Test
    fun `half scores round up like javascript`() {
        // JS Math.round(2.5) === 3. Use binary-exact fractions so float and
        // double arithmetic both land on exactly 2.5.
        // (porn .1875 + hentai .0625 + sexy 0) * 10 = 2.5 → 3
        val probs = floatArrayOf(0.5f, 0.0625f, 0.25f, 0.1875f, 0f)
        assertEquals(3, NsfwScore.compute(probs))
    }

    @Test
    fun `score never exceeds 10`() {
        // After normalization by total, largest possible (p+h+s)*10 is 10,
        // but test the clamp directly with summing logits.
        val logits = floatArrayOf(0f, 0f, 0f, 6f, 6f)
        // normalize: total 12 → porn .5, sexy .5 → (1.0)*10 = 10
        assertEquals(10, NsfwScore.compute(logits))
    }

    @Test
    fun `probabilities are not renormalized`() {
        // Values all <= 1 pass through untouched (JS does not rescale them).
        val probs = floatArrayOf(0.2f, 0.2f, 0.2f, 0.2f, 0.2f)
        // (0.2+0.2+0.2)*10 = 6 → 6 (neutral .2 not > .85)
        assertEquals(6, NsfwScore.compute(probs))
    }

    @Test
    fun `zero sum logits do not divide by zero`() {
        val allZero = FloatArray(5)
        assertEquals(0, NsfwScore.compute(allZero))
    }
}
