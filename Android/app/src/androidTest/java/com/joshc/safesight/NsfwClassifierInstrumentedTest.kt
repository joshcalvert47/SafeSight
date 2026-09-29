package com.joshc.safesight

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.joshc.safesight.ml.NsfwClassifier
import com.joshc.safesight.ml.NsfwScore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * End-to-end check that nsfw.tflite loads and produces deterministic
 * in-range scores — the JVM can't exercise the native interpreter.
 */
@RunWith(AndroidJUnit4::class)
class NsfwClassifierInstrumentedTest {

    @Test
    fun modelLoadsAndScoresDeterministically() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val classifier = NsfwClassifier(context)

        val rgb = ByteArray(NsfwClassifier.INPUT_BYTES) { i -> (i % 255).toByte() }
        val first = classifier.analyzeRgb(rgb)
        val second = classifier.analyzeRgb(rgb)

        assertTrue("score should be 0..10, was $first", first in 0..10)
        assertEquals("same input must give the same verdict", first, second)
        assertEquals(
            "classifier must equal the shared score math",
            NsfwScore.compute(FloatArray(5)), // fail-open path sanity
            classifier.analyzeRgb(ByteArray(NsfwClassifier.INPUT_BYTES)),
        )
        classifier.close()
    }

    @Test
    fun wrongSizedInputFailsOpen() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val classifier = NsfwClassifier(context)
        assertEquals(0, classifier.analyzeRgb(ByteArray(10)))
        classifier.close()
    }
}
