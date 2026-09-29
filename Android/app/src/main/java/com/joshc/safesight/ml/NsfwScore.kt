package com.joshc.safesight.ml

/**
 * Pure port of the score math in chrome/offscreen.js (lines 71-86).
 * Kept free of Android APIs so it runs in plain JVM unit tests.
 *
 * Class indices match the standard GantMan NSFW 5-class model:
 * 0 drawing, 1 hentai, 2 neutral, 3 porn, 4 sexy.
 */
object NsfwScore {

    const val CLASS_DRAWING = 0
    const val CLASS_HENTAI = 1
    const val CLASS_NEUTRAL = 2
    const val CLASS_PORN = 3
    const val CLASS_SEXY = 4

    /**
     * Offscreen.js normalizes only when the model emitted logits (any value
     * > 1): each value is divided by the total. Probabilities pass through.
     */
    fun normalize(values: FloatArray): FloatArray {
        val hasLargeValues = values.any { it > 1f }
        if (!hasLargeValues) return values
        val total = values.fold(0f) { sum, v -> sum + v }.takeIf { it != 0f } ?: 1f
        return FloatArray(values.size) { values[it] / total }
    }

    /** Score 0-10; identical rounding/clamping to the extension. */
    fun compute(values: FloatArray): Int {
        require(values.size >= 5) { "Expected 5 class scores, got ${values.size}" }
        val probs = normalize(values)
        val porn = probs[CLASS_PORN]
        val hentai = probs[CLASS_HENTAI]
        val sexy = probs[CLASS_SEXY]
        val neutral = probs[CLASS_NEUTRAL]

        var score = (porn + hentai + sexy) * 10f
        if (neutral > 0.85f && score < 2f) score = 0f
        // JS Math.round is floor(x + 0.5); kotlin.math.round uses ties-to-even
        // and would disagree with the extensions on exact .5 scores.
        val rounded = Math.round(score.toDouble()).toInt()
        return rounded.coerceIn(0, 10)
    }
}
