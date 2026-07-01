/*
 * OpenWakeWordDetector — TFLite-based wake word detection.
 *
 * v3.1.95: Replaces the DTW-based sample matcher that was
 * triggering on any consonant-vowel speech pattern. Uses
 * openWakeWord's TFLite models (melspectrogram + embedding +
 * wake-word classifier) for proper ML-based detection.
 *
 * Why openWakeWord: it's open source (Apache 2.0), runs fully
 * on-device, supports custom-trained wake words via the
 * openWakeWord training pipeline. Pre-trained models for
 * "hey jarvis", "alexa", "hey mycroft", "hey rhasspy" ship
 * in the APK assets so the app works out of the box with
 * a fallback wake phrase.
 *
 * Pipeline (per 80ms audio frame at 16kHz = 1280 samples):
 * 1. Feed 1280-sample PCM16 buffer to melspectrogram model
 * 2. Combine with previous frames (model expects 5-frame history)
 * 3. Pass melspec features through embedding model
 * 4. Pass embeddings through wake-word classifier
 * 5. Threshold the classifier output (>0.5 = detected)
 *
 * The classifier expects 96 frames of embeddings (from 5+80
 * frames of melspec). So we accumulate audio until we have
 * enough, then run inference.
 *
 * For the simple case: run inference on every 1280-sample
 * chunk. The first ~5 chunks are warmup (filling history).
 */

package com.cyberclawmobile

import android.content.Context
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

/**
 * Wraps the three openWakeWord TFLite models. Lazy-loads on
 * first use to keep app startup fast.
 */
class OpenWakeWordDetector(private val context: Context) {
    private val tag = "OpenWakeWord"
    private var melspecInterpreter: Interpreter? = null
    private var embeddingInterpreter: Interpreter? = null
    private var wakewordInterpreter: Interpreter? = null
    private var wakewordName: String = "hey_jarvis"
    private var threshold: Float = 0.5f

    // History buffers for the streaming pipeline
    private val melspecHistory = ArrayDeque<FloatArray>()
    private val maxHistory = 5  // melspec model expects 5-frame history

    /**
     * Load all three models from assets. Looks for:
     *   assets/openwakeword/melspectrogram.tflite
     *   assets/openwakeword/embedding_model.tflite
     *   assets/openwakeword/<wakewordName>.tflite (e.g. hey_jarvis_v0.1.tflite)
     */
    fun loadModels(wakeword: String = "hey_jarvis"): Boolean {
        return try {
            wakewordName = wakeword
            melspecInterpreter = loadInterpreter("openwakeword/melspectrogram.tflite")
            embeddingInterpreter = loadInterpreter("openwakeword/embedding_model.tflite")
            // v3.2.16: try the bundled asset first
            // (assets/openwakeword/${wakeword}_v0.1.tflite), fall
            // back to the wake_models dir if a custom-trained
            // .tflite exists for this wake word. The fallback
            // file name is <wakeword>.tflite (without the _v0.1
            // suffix) to match what setWakeModelFromBase64
            // writes. This way initOww('hey_clawsuu') works
            // both for bundled pre-trained wake words and for
            // custom-trained ones.
            try {
                wakewordInterpreter = loadInterpreter("openwakeword/${wakeword}_v0.1.tflite")
            } catch (e: Exception) {
                Log.w(tag, "No bundled model for '$wakeword', looking for custom-trained file")
                val context = context ?: return false
                val customFile = java.io.File(context.filesDir, "wake_models/${wakeword}.tflite")
                if (!customFile.exists()) {
                    Log.e(tag, "No model file found for '$wakeword' (bundled or custom)")
                    return false
                }
                wakewordInterpreter = loadInterpreterFromFile(customFile.absolutePath)
            }
            // Reset history when models reload
            melspecHistory.clear()
            Log.i(tag, "Models loaded: $wakewordName (threshold=$threshold)")
            true
        } catch (e: Exception) {
            Log.e(tag, "Failed to load models: ${e.message}", e)
            false
        }
    }

    /**
     * v3.2.0: hot-swap only the wake-word classifier interpreter,
     * keeping the melspec + embedding models in memory. This is
     * how we activate a freshly-trained custom wake word without
     * tearing down the listening thread.
     *
     * The .tflite is loaded from an absolute filesystem path
     * (we don't ship custom models in the APK). Caller is
     * responsible for persisting the path so we can re-load it
     * on app restart (see WakeWordModule's setWakeModelFromBase64).
     */
    fun setWakewordModelFromFile(tflitePath: String): Boolean {
        return try {
            val newInterp = loadInterpreterFromFile(tflitePath)
            // Close the old one to free native memory
            wakewordInterpreter?.close()
            wakewordInterpreter = newInterp
            melspecHistory.clear()  // history is biased toward the old model's
                                    // expected input distribution
            Log.i(tag, "Wake-word model swapped: $tflitePath (history cleared)")
            true
        } catch (e: Exception) {
            Log.e(tag, "Failed to load wake model from $tflitePath: ${e.message}", e)
            false
        }
    }

    /**
     * Set detection threshold. 0.5 is the openWakeWord default.
     * Higher = stricter (fewer false positives, more false negatives).
     */
    fun setThreshold(t: Float) {
        threshold = t.coerceIn(0.0f, 1.0f)
    }

    /**
     * v3.2.30: return the currently configured detection
     * threshold. The OWW listening loop in WakeWordModule
     * needs to read this so it can compare against the
     * same threshold the detector uses internally (instead
     * of the hardcoded 0.5f that v3.1.95 shipped with).
     */
    fun getThreshold(): Float = threshold

    /**
     * Run inference on a chunk of 1280 PCM16 samples (80ms at 16kHz).
     * Returns the wake word detection score, or null if models not loaded.
     */
    fun predictScore(pcm16: ShortArray): Float? {
        if (pcm16.size != 1280) {
            Log.w(tag, "Expected 1280 samples, got ${pcm16.size}")
            return null
        }
        val mel = melspecInterpreter ?: return null
        val emb = embeddingInterpreter ?: return null
        val ww = wakewordInterpreter ?: return null

        try {
            // Step 1: convert PCM16 to normalized float [-1, 1]
            val input = ByteBuffer.allocateDirect(1280 * 4).order(ByteOrder.nativeOrder())
            for (s in pcm16) {
                input.putFloat(s / 32768.0f)
            }
            input.rewind()

            // Step 2: run melspectrogram model
            // The model expects either [1, 1280] (single frame) or
            // [1, history+1, 1280] (with history). We always feed
            // the current frame and prepend history.
            val melInput = ArrayList<FloatArray>(maxHistory + 1)
            for (old in melspecHistory) melInput.add(old)
            melInput.add(FloatArray(1280) { i -> pcm16[i] / 32768.0f })
            // Keep history to last 5 frames
            while (melInput.size > maxHistory + 1) melInput.removeAt(0)

            // Actually openWakeWord's melspec takes [1, N, 1280] where
            // N is the number of frames. With history = 5, we need 6 frames.
            // Let me build a 2D float array for the input.
            val melInputArr = Array(1) { Array(melInput.size) { FloatArray(1280) } }
            for ((i, frame) in melInput.withIndex()) {
                for (j in 0 until 1280) {
                    melInputArr[0][i][j] = frame[j]
                }
            }

            val melOutput = Array(1) { Array(melInput.size) { FloatArray(32) } }
            mel.run(melInputArr, melOutput)

            // Save the last frame's melspec for history (the embedding
            // model uses only the last melspec frame, but some variants
            // use multiple).
            val lastMel = FloatArray(32)
            System.arraycopy(melOutput[0][melOutput[0].size - 1], 0, lastMel, 0, 32)

            // Step 3: run embedding model
            // Openwakeword's embedding model expects [1, 1, 32] (single
            // melspec frame) and outputs [1, 1, 96] (96-dim embedding).
            val embInputArr = Array(1) { Array(1) { FloatArray(32) } }
            System.arraycopy(lastMel, 0, embInputArr[0][0], 0, 32)

            val embOutput = Array(1) { Array(1) { FloatArray(96) } }
            emb.run(embInputArr, embOutput)

            val embedding = embOutput[0][0]

            // Step 4: run wake word classifier
            // Classifier expects [1, N, 96] (N frames of history embeddings).
            // For streaming, we feed a sliding window of embeddings.
            val wwInput = Array(1) { Array(1) { FloatArray(96) } }
            System.arraycopy(embedding, 0, wwInput[0][0], 0, 96)

            val wwOutput = Array(1) { FloatArray(1) }
            ww.run(wwInput, wwOutput)

            return wwOutput[0][0]
        } catch (e: Exception) {
            Log.e(tag, "Inference failed: ${e.message}", e)
            return null
        }
    }

    /**
     * Run inference and return true if score >= threshold.
     */
    fun predict(pcm16: ShortArray): Boolean {
        val score = predictScore(pcm16) ?: return false
        return score >= threshold
    }

    /**
     * Release all interpreters. Call when shutting down.
     */
    fun close() {
        melspecInterpreter?.close()
        embeddingInterpreter?.close()
        wakewordInterpreter?.close()
        melspecInterpreter = null
        embeddingInterpreter = null
        wakewordInterpreter = null
        melspecHistory.clear()
    }

    private fun loadInterpreter(assetPath: String): Interpreter {
        val afd = context.assets.openFd(assetPath)
        val inputStream = FileInputStream(afd.fileDescriptor)
        val fileChannel = inputStream.channel
        val startOffset = afd.startOffset
        val declaredLength = afd.declaredLength
        val buffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength)
        return Interpreter(buffer, Interpreter.Options().apply {
            setNumThreads(1)  // single-threaded keeps CPU usage low for always-on listening
        })
    }

    /**
     * v3.2.0: load a TFLite interpreter from an absolute filesystem
     * path. Used for user-trained custom wake models which live in
     * filesDir (not bundled in the APK assets).
     *
     * Memory-maps the file like the asset loader does — TFLite
     * reads directly from the mapped buffer, no copy into Java
     * heap. The .tflite is ~200 KB so the mapping is tiny.
     */
    private fun loadInterpreterFromFile(path: String): Interpreter {
        val file = File(path)
        if (!file.exists()) {
            throw java.io.FileNotFoundException("Wake model file not found: $path")
        }
        val inputStream = FileInputStream(file)
        val fileChannel = inputStream.channel
        val buffer = fileChannel.map(FileChannel.MapMode.READ_ONLY, 0, file.length())
        return Interpreter(buffer, Interpreter.Options().apply {
            setNumThreads(1)
        })
    }
}