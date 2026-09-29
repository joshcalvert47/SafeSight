package com.joshc.safesight.ml

import android.content.Context
import org.tensorflow.lite.InterpreterApi
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/**
 * On-device NSFW image classifier backed by nsfw.tflite (same 24MB model the
 * browser extensions ship). Mirrors chrome/offscreen.js: load once, feed
 * 224x224x3 RGB, fail open (score 0) on any error so a page is never
 * permanently blocked by a model failure.
 */
class NsfwClassifier(context: Context) {

    private val interpreter: InterpreterApi by lazy { openModel(context) }

    @Synchronized
    fun analyzeRgb(rgb: ByteArray): Int = try {
        require(rgb.size == INPUT_BYTES) {
            "Data size mismatch: Expected $INPUT_BYTES, got ${rgb.size}"
        }
        val input = buildInput(interpreter.getInputTensor(0).dataType(), rgb)
        val shape = interpreter.getOutputTensor(0).shape()
        val output: Any =
            if (shape.size == 2 && shape[0] == 1) Array(1) { FloatArray(shape[1]) }
            else FloatArray(shape.fold(1) { acc, d -> acc * d })
        interpreter.run(input, output)
        val probs = flattenOutput(output)
        NsfwScore.compute(probs)
    } catch (t: Throwable) {
        // Fail open — offscreen.js returns score 0 when analysis cannot run.
        0
    }

    @Synchronized
    fun close() {
        runCatching { interpreter.close() }
    }

    private fun buildInput(type: org.tensorflow.lite.DataType, rgb: ByteArray): Any =
        when (type) {
            org.tensorflow.lite.DataType.FLOAT32 -> {
                // Same /255.0 conversion as offscreen.js when dtype is float32.
                val floats = FloatArray(INPUT_BYTES)
                for (i in 0 until INPUT_BYTES) {
                    floats[i] = (rgb[i].toInt() and 0xFF) / 255f
                }
                floats
            }

            else -> {
                // Integer inputs take the raw bytes through a direct buffer.
                val buffer = ByteBuffer.allocateDirect(INPUT_BYTES).order(ByteOrder.nativeOrder())
                buffer.put(rgb).rewind()
                buffer
            }
        }

    private fun flattenOutput(output: Any): FloatArray = when (output) {
        is Array<*> -> (output[0] as FloatArray)
        is FloatArray -> output
        else -> throw IllegalStateException("Unexpected output type: $output")
    }

    private fun openModel(context: Context): InterpreterApi {
        val buffer: MappedByteBuffer = try {
            val afd = context.assets.openFd(MODEL_ASSET)
            FileInputStream(afd.fileDescriptor).use { input ->
                input.channel.map(
                    FileChannel.MapMode.READ_ONLY,
                    afd.startOffset,
                    afd.declaredLength,
                )
            }
        } catch (e: Exception) {
            // Asset was compressed by aapt — fall back to a copied model file.
            copyAssetToFile(context)
        }
        return InterpreterApi.create(buffer, InterpreterApi.Options().setNumThreads(4))
    }

    private fun copyAssetToFile(context: Context): MappedByteBuffer {
        val file = java.io.File(context.filesDir, MODEL_ASSET)
        if (!file.exists() || file.length() == 0L) {
            context.assets.open(MODEL_ASSET).use { input ->
                java.io.FileOutputStream(file).use { output -> input.copyTo(output) }
            }
        }
        return FileInputStream(file).use { input ->
            input.channel.map(FileChannel.MapMode.READ_ONLY, 0, file.length())
        }
    }

    companion object {
        const val MODEL_ASSET = "nsfw.tflite"
        const val INPUT_BYTES = 224 * 224 * 3 // 150528
    }
}
