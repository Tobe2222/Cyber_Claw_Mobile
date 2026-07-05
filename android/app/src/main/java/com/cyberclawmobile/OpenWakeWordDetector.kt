/*
 * OpenWakeWordDetector — TFLite-based wake word + exit phrase detection.
 *
 * v3.1.95: Replaces the DTW-based sample matcher that was
 * triggering on any consonant-vowel speech pattern. Uses
 * openWakeWord's TFLite models (melspectrogram + embedding +
 * classifier) for proper ML-based detection.
 *
 * v3.5.0: Dual classifier support — runs BOTH a wake-word
 * classifier AND an exit-phrase classifier on the same
 * melspec+embedding output. Both models are hot-swappable
 * from desktop-trained .tflite files (no app restart).
 *
 * v3.6.0: Triple classifier support — adds a "send" classifier
 * (the explicit end-of-utterance word, e.g. "send" or "go").
 * Runs alongside wake and exit on the same embedding. All
 * three fire independently with their own thresholds and
 * high-score counters.
 *
 * Pipeline (per 80ms audio frame at 16kHz = 1280 samples):
 * 1. Feed 1280-sample PCM16 buffer to melspectrogram model
 * 2. Combine with previous frames (model expects 5-frame history)
 * 3. Pass melspec features through embedding model
 * 4. Run BOTH classifiers (wake + exit) on the embedding
 * 5. Return (wakeScore, exitScore)
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
 * Wraps the openWakeWord TFLite models (melspectrogram +
 * embedding) + N binary classifier interpreters (wake word,
 * exit phrase, future phrases). Lazy-loads on first use to
 * keep app startup fast.
 *
 * v3.5.0: refactored from single-classifier to multi-classifier.
 * The predict method now returns a `PairScores` data class with
 * optional wake + exit scores, so callers can fire whichever
 * events apply.
 *
 * v3.6.0: extended to TripleScores with optional wake + exit
 * + send scores. Send runs alongside, separate threshold.
 */
class OpenWakeWordDetector(private val context: Context) {
    private val tag = "OpenWakeWord"
    private var melspecInterpreter: Interpreter? = null
    private var embeddingInterpreter: Interpreter? = null
    // v3.5.0: was a single wakewordInterpreter. Now we have
    // two slots: one for the wake word, one for the exit
    // phrase. Both are optional (either can be null if not
    // trained yet) and both share the same melspec+embedding.
    //
    // v3.6.0: third slot for the send classifier (explicit
    // end-of-utterance word). Same hot-swap, same threshold
    // mechanism. Independent of exit — they serve different
    // purposes (send finishes a turn, exit closes voice mode).
    private var wakewordInterpreter: Interpreter? = null
    private var exitInterpreter: Interpreter? = null
    private var sendInterpreter: Interpreter? = null
    private var wakewordName: String = "hey_jarvis"
    private var exitName: String? = null  // null until the user trains an exit phrase
    private var sendName: String? = null  // null until the user trains a send word
    private var threshold: Float = 0.5f
    private var exitThreshold: Float = 0.5f
    private var sendThreshold: Float = 0.5f

    // History buffers for the streaming pipeline
    private val melspecHistory = ArrayDeque<FloatArray>()
    private val maxHistory = 5  // melspec model expects 5-frame history

    /**
     * v3.6.0: scores from a single inference pass. Any
     * field can be null if the corresponding classifier
     * isn't loaded (e.g. user hasn't trained an exit phrase
     * or send word yet — only wake score is populated).
     */
    data class TripleScores(
        val wake: Float?,
        val exit: Float?,
        val send: Float?,
    )

    // v3.5.0: kept as an alias so older callers that
    // imported PairScores still compile. The new send slot
    // is always null when constructed from the v3.5.0 path.
    typealias PairScores = TripleScores

    /**
     * Load all three base models from assets, plus the wake
     * classifier. Looks for:
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
            // v3.5.0: exitInterpreter is NOT loaded here — it's
            // hot-swapped later when the user trains an exit
            // phrase via setExitModelFromFile. Until then, the
            // exit score stays null.
            //
            // v3.6.0: same applies to sendInterpreter. Hot-
            // swapped via setSendModelFromFile when the user
            // trains a send word.
            //
            // Reset history when models reload
            melspecHistory.clear()
            Log.i(tag, "Models loaded: wake=$wakewordName exit=${exitName ?: "(none)"} send=${sendName ?: "(none)"} (threshold=$threshold)")
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
            return false
        }
    }

    /**
     * v3.5.0: hot-swap the exit-phrase classifier interpreter.
     * Parallel to setWakewordModelFromFile. Same clearing
     * behavior (melspec history is biased toward the previous
     * model's expected input distribution).
     *
     * @param phrase the user's exit phrase text (stored as
     *               `exitName` for logging/debug only — the
     *               model itself is opaque).
     */
    fun setExitModelFromFile(phrase: String, tflitePath: String): Boolean {
        return try {
            val newInterp = loadInterpreterFromFile(tflitePath)
            exitInterpreter?.close()
            exitInterpreter = newInterp
            exitName = phrase
            melspecHistory.clear()
            Log.i(tag, "Exit-phrase model swapped: '$phrase' from $tflitePath (history cleared)")
            true
        } catch (e: Exception) {
            Log.e(tag, "Failed to load exit model from $tflitePath: ${e.message}", e)
            return false
        }
    }

    /**
     * v3.6.0: hot-swap the send-word classifier interpreter.
     * Identical structure to setExitModelFromFile. The send
     * word is the explicit "I'm done with my turn" cue the
     * user says to commit the current utterance to the LLM
     * (alternative to silence-detection auto-send).
     *
     * @param phrase the user's send word text (e.g. "send",
     *               "go", "done") — used as `sendName` for
     *               logging/debug only; the model is opaque.
     */
    fun setSendModelFromFile(phrase: String, tflitePath: String): Boolean {
        return try {
            val newInterp = loadInterpreterFromFile(tflitePath)
            sendInterpreter?.close()
            sendInterpreter = newInterp
            sendName = phrase
            melspecHistory.clear()
            Log.i(tag, "Send-word model swapped: '$phrase' from $tflitePath (history cleared)")
            true
        } catch (e: Exception) {
            Log.e(tag, "Failed to load send model from $tflitePath: ${e.message}", e)
            return false
        }
    }

    /**
     * Set wake detection threshold. 0.5 is the openWakeWord
     * default. Higher = stricter (fewer false positives, more
     * false negatives).
     */
    fun setThreshold(t: Float) {
        threshold = t.coerceIn(0.0f, 1.0f)
    }

    /**
     * v3.5.0: set the exit-phrase detection threshold separately
     * from the wake threshold. They serve different purposes
     * (wake = first detection, exit = ends conversation) so
     * they're tuned independently. Default 0.5 to match wake.
     */
    fun setExitThreshold(t: Float) {
        exitThreshold = t.coerceIn(0.0f, 1.0f)
    }

    /**
     * v3.6.0: set the send-word detection threshold. Same
     * reasoning as setExitThreshold — the send word serves a
     * different purpose (commit utterance) than wake or exit,
     * so it's tuned independently. Default 0.5 to match.
     */
    fun setSendThreshold(t: Float) {
        sendThreshold = t.coerceIn(0.0f, 1.0f)
    }

    /**
     * v3.2.30: return the currently configured wake detection
     * threshold. The OWW listening loop in WakeWordModule
     * needs to read this so it can compare against the
     * same threshold the detector uses internally (instead
     * of the hardcoded 0.5f that v3.1.95 shipped with).
     */
    fun getThreshold(): Float = threshold

    /**
     * v3.5.0: return the exit-phrase detection threshold.
     */
    fun getExitThreshold(): Float = exitThreshold

    /**
     * v3.6.0: return the send-word detection threshold.
     */
    fun getSendThreshold(): Float = sendThreshold

    /**
     * v3.6.0: helper for the listening-loop log/event payload.
     * Returns the configured send word text (e.g. "send") or an
     * empty string if no send word is loaded. The WakeWordModule
     * uses this to populate the `sendword` field on the
     * `owwSendDetected` event so the JS layer can log/display
     * what actually fired. Mirrors how `wakeword` is exposed on
     * the wake event.
     */
    fun sendNameOrEmpty(): String = sendName ?: ""

    /**
     * Run inference on a chunk of 1280 PCM16 samples (80ms at 16kHz).
     * Returns a TripleScores with optional wake / exit / send scores.
     * Any field can be null if the corresponding classifier isn't
     * loaded.
     */
    fun predictScore(pcm16: ShortArray): TripleScores {
        if (pcm16.size != 1280) {
            Log.w(tag, "Expected 1280 samples, got ${pcm16.size}")
            return TripleScores(null, null, null)
        }
        val mel = melspecInterpreter
        val emb = embeddingInterpreter
        val ww = wakewordInterpreter
        val exit = exitInterpreter
        val send = sendInterpreter

        if (mel == null || emb == null || (ww == null && exit == null && send == null)) {
            // Need at least one classifier loaded to do anything useful.
            return TripleScores(null, null, null)
        }

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

            // Step 4: run all classifiers (wake + exit + send)
            // on the same embedding. Each expects [1, 1, 96]
            // (single embedding frame) and outputs [1, 1]
            // (binary score). v3.6.0 added send alongside exit;
            // both are independent and may be null if not trained.
            val classInput = Array(1) { Array(1) { FloatArray(96) } }
            System.arraycopy(embedding, 0, classInput[0][0], 0, 96)

            var wakeScore: Float? = null
            var exitScore: Float? = null
            var sendScore: Float? = null

            if (ww != null) {
                val wwOutput = Array(1) { FloatArray(1) }
                ww.run(classInput, wwOutput)
                wakeScore = wwOutput[0][0]
            }

            if (exit != null) {
                val exitOutput = Array(1) { FloatArray(1) }
                exit.run(classInput, exitOutput)
                exitScore = exitOutput[0][0]
            }

            if (send != null) {
                val sendOutput = Array(1) { FloatArray(1) }
                send.run(classInput, sendOutput)
                sendScore = sendOutput[0][0]
            }

            return TripleScores(wakeScore, exitScore, sendScore)
        } catch (e: Exception) {
            Log.e(tag, "Inference failed: ${e.message}", e)
            return TripleScores(null, null, null)
        }
    }

    /**
     * Run inference. Returns true if wake score >= wake
     * threshold OR exit score >= exit threshold OR send
     * score >= send threshold. Any classifier can fire
     * independently.
     */
    fun predict(pcm16: ShortArray): Boolean {
        val (wakeScore, exitScore, sendScore) = predictScore(pcm16)
        val wakeHit = wakeScore != null && wakeScore >= threshold
        val exitHit = exitScore != null && exitScore >= exitThreshold
        val sendHit = sendScore != null && sendScore >= sendThreshold
        return wakeHit || exitHit || sendHit
    }

    /**
     * Release all interpreters. Call when shutting down.
     */
    fun close() {
        melspecInterpreter?.close()
        embeddingInterpreter?.close()
        wakewordInterpreter?.close()
        exitInterpreter?.close()
        sendInterpreter?.close()
        melspecInterpreter = null
        embeddingInterpreter = null
        wakewordInterpreter = null
        exitInterpreter = null
        sendInterpreter = null
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
