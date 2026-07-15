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

    // v3.10.19: speaker-embedding circular buffer. We
    // keep the last N embeddings (each 96-dim float) so
    // that on a wake-word fire, we can compute a
    // stable speaker match against an enrolled profile
    // using the most recent audio — not just the
    // single chunk that triggered the wake. KEEP_LAST
    // = ~32 chunks = ~2.5s of audio at the 80ms chunk
    // rate. That's enough to be a stable speaker ID
    // signal even if individual chunks vary.
    private val embeddingHistory = ArrayDeque<FloatArray>()
    private val embeddingHistoryMax = 32

    // v3.10.23: single global speaker profile. Replaces
    // the v3.10.21 per-agent enrollment HashMap. The user's voice is one thing — it
    // doesn't depend on which companion they're talking
    // to. The profile is a 96-dim float vector (the
    // averaged + L2-normalized OWW embeddings over many
    // voice-active chunks).
    //
    // null = no profile yet (we haven't accumulated
    //   enough voice to be confident). Wake detection
    //   proceeds WITHOUT speaker gating in this state
    //   — the system has to work before it can learn.
    // non-null = profile is set. Wake detection is
    //   GATED by speaker match: if the audio doesn't
    //   sound like the enrolled user, suppress the
    //   wake event.
    @Volatile private var primaryProfile: FloatArray? = null

    // v3.10.23: passive enrollment accumulator. Unlike
    // embeddingHistory (which keeps the LAST N for
    // matching), this buffer keeps voice-active
    // embeddings for a longer window so we can
    // auto-learn the user's voice over time. Voice-
    // active filtering happens at the call site (the
    // WakeWordModule checks rms/zcr before calling
    // accumulateLatestEmbedding) so the detector doesn't
    // need to recompute them.
    //
    // KEEP_LAST = ~64 voice-active embeddings = ~5s of
    // continuous speech. Long enough to capture a
    // sentence; short enough to bias toward recent
    // voice (recent speech averages out earlier noise).
    private val enrollmentBuffer = ArrayDeque<FloatArray>()
    private val enrollmentBufferMax = 64
    // Cumulative count of voice-active samples seen
    // across all enrollment sessions. Never decreases;
    // resets only on clearPrimaryProfile. Used by the
    // auto-lock threshold + by JS for status (debug only
    // — no UI in production).
    private var enrollmentSamplesTotal = 0L
    // Last profile recomputation time (ms). Used to
    // throttle the averaging — recomputing every chunk
    // is wasted CPU; every 5s is plenty.
    private var enrollmentLastUpdateMs = 0L
    // v3.10.23: confirmed wake-fire count. A wake-fire
    // counts as "confirmed" only if a recent voice-active
    // embedding was within 2 seconds of the wake fire
    // (i.e. the user actually said something, not a
    // stray TV / door slam). Used as an alternative
    // auto-lock trigger: lock the profile when we've
    // seen enough CONFIRMED wake fires (real user use),
    // even if total sample count is low.
    private var confirmedWakeFires = 0
    // v3.10.23: persistent lock flag. Once true, the
    // profile is "locked" — it's been written to
    // SharedPreferences and survives app restarts. The
    // auto-enrollment no longer fires (the buffer can
    // still accumulate for drift detection, but it
    // doesn't overwrite the locked profile).
    @Volatile private var profileLocked = false
    // Auto-lock thresholds. Either condition triggers
    // lock; whichever hits first.
    private val PROFILE_LOCK_SAMPLES = 1000   // ~30s of voice-active buffers
    private val PROFILE_LOCK_WAKE_FIRES = 5   // 5 confirmed wake-fires
    // v3.10.23: gate threshold for wake suppression.
    // When a profile is locked and the most recent
    // audio's cosine match against the profile is below
    // this value, suppress the wake event. 0.5 was
    // chosen as a balance: typical same-speaker matches
    // are 0.7-0.9 (gate lets them through), and a
    // different speaker typically scores 0.3-0.5 (gate
    // suppresses). Set too high and the user's voice
    // drift causes false negatives; too low and other
    // speakers slip through.
    private val SPEAKER_GATE_THRESHOLD = 0.5f
    // SharedPreferences key for persisting the profile
    // across app restarts. The value is a base64-
    // encoded 96-float vector (96 * 4 bytes = 384
    // bytes → ~512 chars base64). The `v1` suffix
    // lets us bump the encoding format without colliding
    // with the v3.10.21 per-agent stored data (which
    // used a different key prefix).
    private val PROFILE_PREFS_NAME = "speaker_profile_v1"
    private val PROFILE_PREFS_KEY = "profile_b64"

    /**
     * v3.10.19: cosine similarity between two 96-dim
     * vectors. Returns a value in [-1, 1]; typical
     * same-speaker scores are 0.7-0.9.
     */
    private fun cosineSimilarity(a: FloatArray, b: FloatArray): Float {
        if (a.size != b.size) return 0f
        var dot = 0.0
        var normA = 0.0
        var normB = 0.0
        for (i in a.indices) {
            dot += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        val denom = Math.sqrt(normA) * Math.sqrt(normB)
        return if (denom == 0.0) 0f else (dot / denom).toFloat()
    }

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

    // v3.6.0: PairScores was renamed to TripleScores (added
    // the send slot). The Kotlin compiler does not support
    // nested typealiases as of 2.1.21 (verified: emits
    // "nested and local type aliases are not supported"
    // on the typealias line itself). PairScores was only
    // referenced inside this file (no external imports),
    // so the rename is safe. If external callers ever
    // need the old name, add a top-level typealias in a
    // separate .kt file.

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
                // v3.10.1: look in BOTH the legacy flat
                // path AND the v3.9.0 directory
                // registry. The trainer writes to
                // filesDir/wake_models/<setId>/model.tflite
                // (directory-per-set) and the setId is a
                // slugified, timestamped name
                // (e.g. hey-clawsuu-1784025212000), NOT
                // the typed phrase. So matching on the
                // wakeword argument to find the file
                // requires scanning the registry and
                // matching by meta.json's phrase field
                // (case-insensitive contains or exact
                // match) rather than file name.
                //
                // Tobe hit a real-world false-wake bug
                // from this: training completed,
                // setWakeModelFromBase64 hot-swapped
                // the model into the running detector,
                // but the trainer's unmount cleanup
                // called initOww(typed phrase) which
                // closed + re-created the detector.
                // loadModels couldn't find the file
                // (it's at <setId>/model.tflite, not
                // <phrase>.tflite), the new detector
                // was half-initialized (melspec +
                // embedding only, no wake classifier),
                // and owwWakeDetected stopped firing.
                // The BG service (Vosk + PhoneticMatcher,
                // separate code path) was still
                // running with the old phrase and
                // produced the false wakes.
                //
                // 1. Try the legacy flat file (any
                //    pre-v3.9.0 custom-trained model
                //    plus the bundled pre-trained
                //    wake words when the asset name
                //    matches the wakeword arg).
                val legacyFile = java.io.File(context.filesDir, "wake_models/${wakeword}.tflite")
                if (legacyFile.exists()) {
                    wakewordInterpreter = loadInterpreterFromFile(legacyFile.absolutePath)
                } else {
                    // 2. Scan the v3.9.0 directory
                    //    registry for a set whose
                    //    meta.json phrase matches the
                    //    wakeword argument
                    //    (case-insensitive). The
                    //    active set wins; otherwise
                    //    newest by createdAt.
                    val matched = findWakeModelByPhrase(context, wakeword)
                    if (matched == null) {
                        Log.e(tag, "No model file found for '$wakeword' (bundled or custom)")
                        return false
                    }
                    wakewordInterpreter = loadInterpreterFromFile(matched)
                }
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

            // v3.10.19: stash a copy of the embedding for
            // speaker matching. The classifier scores are
            // computed from this same embedding; saving it
            // costs nothing extra. We keep the last
            // embeddingHistoryMax frames (default 32 = ~2.5s)
            // so a wake-fire can compute a stable match
            // score across the wake-word audio and the
            // seconds that follow (when the user says the
            // actual command).
            synchronized(embeddingHistory) {
                embeddingHistory.addLast(embedding.copyOf())
                while (embeddingHistory.size > embeddingHistoryMax) {
                    embeddingHistory.removeFirst()
                }
            }

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
        synchronized(embeddingHistory) { embeddingHistory.clear() }
    }

    // v3.10.19: speaker enrollment. Averages the most
    // recent embeddings in the buffer into a single
    // 96-dim profile for the agent. Returns true if
    // enrollment succeeded (enough samples in buffer).
    // Tobe's "ideal feature": learn the user's voice
    // over time so the wake-word detector can ignore
    // other speakers.
    //
    // Why average over the buffer rather than the
    // single wake-fire moment: averaging 32 frames
    // (~2.5s) smooths over momentary voice variations
    // (prosody, microphone angle) and produces a
    // stable profile. The buffer is updated
    // continuously as the listener runs, so by the
    // time the user has used the app for a few minutes
    // we have plenty of enrollment data.
    fun enrollPrimaryProfileFromBuffer(minSamples: Int = 8): Boolean {
        val snapshot: List<FloatArray>
        synchronized(embeddingHistory) {
            if (embeddingHistory.size < minSamples) return false
            snapshot = embeddingHistory.toList()
        }
        // Average the embeddings, then L2-normalize so
        // the resulting profile has unit norm (cosine
        // similarity = dot product for normalized vectors).
        val avg = FloatArray(96)
        for (emb in snapshot) {
            for (i in 0 until 96) avg[i] += emb[i]
        }
        val n = snapshot.size.toFloat()
        for (i in 0 until 96) avg[i] /= n
        var norm = 0.0
        for (i in 0 until 96) norm += avg[i] * avg[i]
        norm = Math.sqrt(norm)
        if (norm > 0.0) for (i in 0 until 96) avg[i] = (avg[i] / norm).toFloat()
        primaryProfile = avg
        Log.i(tag, "Set primary speaker profile from ${snapshot.size} embeddings")
        return true
    }

    /**
     * v3.10.19: compute speaker match score against the
     * enrolled profile for this agent. Returns the
     * AVERAGE cosine similarity across the most
     * recent K embeddings in the buffer (default K=8
     * = ~640ms). Averaging across K frames gives a
     * more stable match than a single-frame comparison.
     *
     * Returns null if no enrollment exists for the
     * agent. Caller should treat null as "no
     * preference" (allow the wake word).
     */
    fun matchRecentSpeaker(recentK: Int = 8): Float? {
        val profile = primaryProfile ?: return null
        val snapshot: List<FloatArray>
        synchronized(embeddingHistory) {
            val n = Math.min(recentK, embeddingHistory.size)
            if (n == 0) return null
            snapshot = embeddingHistory.toList().takeLast(n)
        }
        var total = 0.0
        for (emb in snapshot) total += cosineSimilarity(profile, emb)
        return (total / snapshot.size).toFloat()
    }

    fun hasPrimaryProfile(): Boolean = primaryProfile != null

    /** v3.10.23: gate query for the wake-fire path. */
    fun isProfileLocked(): Boolean = profileLocked

    /**
     * v3.10.23: gate query for wake suppression. Returns
     * true if the wake should be suppressed because the
     * recent audio doesn't match the user's profile.
     * Returns false if the profile isn't set yet (the
     * system has to work BEFORE it can learn — wake
     * fires unrestricted until the profile locks).
     */
    fun shouldSuppressWakeForSpeaker(recentK: Int = 8): Boolean {
        if (primaryProfile == null) return false
        val score = matchRecentSpeaker(recentK) ?: return false
        return score < SPEAKER_GATE_THRESHOLD
    }

    /**
     * v3.10.23: clear the primary profile + reset all
     * enrollment counters. Wipes SharedPreferences too
     * so the next cold start is a fresh enrollment.
     */
    fun clearPrimaryProfile() {
        primaryProfile = null
        profileLocked = false
        confirmedWakeFires = 0
        synchronized(enrollmentBuffer) { enrollmentBuffer.clear() }
        enrollmentSamplesTotal = 0L
        context?.getSharedPreferences(PROFILE_PREFS_NAME, android.content.Context.MODE_PRIVATE)
            ?.edit()?.remove(PROFILE_PREFS_KEY)?.apply()
        Log.i(tag, "Primary speaker profile cleared")
    }

    /**
     * v3.10.23: bump the confirmed-wake-fire counter.
     * Called by WakeWordModule from the wake-detect
     * path when a recent voice-active embedding was
     * within 2s of the wake fire (i.e. the user
     * actually said something back — not a stray TV).
     */
    fun noteConfirmedWakeFire() {
        confirmedWakeFires++
    }

    // v3.10.21: passive enrollment accumulator. Called
    // from WakeWordModule whenever an audio chunk is
    // classified as voice-active (rms > SPEECH_THRESHOLD
    // + zcr > VOICE_ZCR_THRESHOLD). Pushes the chunk's
    // 96-dim embedding into the enrollment buffer (which
    // keeps the last 64 frames = ~5s of speech).
    //
    // This runs CONTINUOUSLY while the OWW listener is
    // active — no user action required. Tobe's
    // "passive option" request: auto-learn the user's
    // voice in the background over time.
    fun accumulateEnrollmentSample(embedding: FloatArray) {
        synchronized(enrollmentBuffer) {
            enrollmentBuffer.addLast(embedding.copyOf())
            while (enrollmentBuffer.size > enrollmentBufferMax) {
                enrollmentBuffer.removeFirst()
            }
        }
        enrollmentSamplesTotal++
    }

    /**
     * v3.10.21: convenience wrapper — pull the most
     * recent embedding from `embeddingHistory` (which
     * predictScore stashes every chunk into) and push
     * it into the enrollment buffer. Called from
     * WakeWordModule's OWW thread loop immediately
     * after predictScore returns, when the previous
     * chunk was classified as voice-active.
     *
     * Cheap: no extra DSP, just a buffer copy.
     */
    fun accumulateLatestEmbedding() {
        val latest = synchronized(embeddingHistory) {
            if (embeddingHistory.isEmpty()) null
            else embeddingHistory.last().copyOf()
        } ?: return
        accumulateEnrollmentSample(latest)
    }

    /**
     * v3.10.23: number of voice-active samples seen
     * since the last clear. Used by the JS status
     * query (debug only — no UI). Monotonically
     * increases (until clearPrimaryProfile resets).
     */
    fun getEnrollmentSamplesTotal(): Long = enrollmentSamplesTotal

    /**
     * v3.10.21: how many samples are currently in the
     * rolling enrollment buffer (max 64). Useful for
     * debugging — "did the user's recent speech get
     * captured?"
     */
    fun getEnrollmentBufferSize(): Int = synchronized(enrollmentBuffer) { enrollmentBuffer.size }

    /**
     * v3.10.23: recompute the primary profile from the
     * current enrollment buffer. Throttled to once per
     * `cooldownMs` (5s) so we don't recompute every
     * chunk.
     *
     * If the auto-lock thresholds are met
     * (PROFILE_LOCK_SAMPLES samples OR
     * PROFILE_LOCK_WAKE_FIRES confirmed wake-fires),
     * the profile is locked and persisted to
     * SharedPreferences. Once locked, the gate becomes
     * active — wake detection requires the speaker to
     * match.
     *
     * Returns Pair<updated, justLocked>:
     *   updated    — true if the profile was recomputed
     *   justLocked — true if THIS call caused the
     *               unlocked→locked transition (so the
     *               caller can log it exactly once).
     */
    fun recomputePrimaryProfileIfReady(minSamples: Int = 16, cooldownMs: Long = 5000L): Pair<Boolean, Boolean> {
        if (profileLocked) return Pair(false, false)
        val now = System.currentTimeMillis()
        if (now - enrollmentLastUpdateMs < cooldownMs && primaryProfile != null) {
            return Pair(false, false)
        }
        val snapshot: List<FloatArray>
        synchronized(enrollmentBuffer) {
            if (enrollmentBuffer.size < minSamples) return Pair(false, false)
            snapshot = enrollmentBuffer.toList()
        }
        primaryProfile = averageAndNormalize(snapshot)
        enrollmentLastUpdateMs = now
        val locked = tryLockPrimaryProfile()
        Log.i(tag, "Recomputed primary speaker profile from ${snapshot.size} samples (cumulative $enrollmentSamplesTotal, confirmedWakes=$confirmedWakeFires, justLocked=$locked)")
        return Pair(true, locked)
    }

    /**
     * v3.10.23: check auto-lock thresholds; if met,
     * lock + persist. Returns true iff THIS call caused
     * the unlocked→locked transition.
     */
    private fun tryLockPrimaryProfile(): Boolean {
        if (profileLocked) return false
        if (primaryProfile == null) return false
        val enoughSamples = enrollmentSamplesTotal >= PROFILE_LOCK_SAMPLES
        val enoughWakes = confirmedWakeFires >= PROFILE_LOCK_WAKE_FIRES
        if (!enoughSamples && !enoughWakes) return false
        profileLocked = true
        persistPrimaryProfile()
        Log.i(tag, "Primary speaker profile LOCKED (samples=$enrollmentSamplesTotal, confirmedWakes=$confirmedWakeFires)")
        return true
    }

    /**
     * v3.10.23: average a list of 96-dim embeddings and
     * L2-normalize. Pure function over the snapshot.
     */
    private fun averageAndNormalize(snapshot: List<FloatArray>): FloatArray {
        val avg = FloatArray(96)
        for (emb in snapshot) {
            for (i in 0 until 96) avg[i] += emb[i]
        }
        val n = snapshot.size.toFloat()
        for (i in 0 until 96) avg[i] /= n
        var norm = 0.0
        for (i in 0 until 96) norm += avg[i] * avg[i]
        norm = Math.sqrt(norm)
        if (norm > 0.0) for (i in 0 until 96) avg[i] = (avg[i] / norm).toFloat()
        return avg
    }

    /**
     * v3.10.23: serialize the primary profile to base64
     * (raw little-endian float bytes) and write to
     * SharedPreferences. Called automatically on lock.
     */
    fun persistPrimaryProfile(): Boolean {
        val profile = primaryProfile ?: return false
        val ctx = context ?: return false
        val bytes = ByteArray(profile.size * 4)
        for (i in profile.indices) {
            val bits = java.lang.Float.floatToRawIntBits(profile[i])
            bytes[i * 4 + 0] = (bits and 0xff).toByte()
            bytes[i * 4 + 1] = ((bits shr 8) and 0xff).toByte()
            bytes[i * 4 + 2] = ((bits shr 16) and 0xff).toByte()
            bytes[i * 4 + 3] = ((bits shr 24) and 0xff).toByte()
        }
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        ctx.getSharedPreferences(PROFILE_PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .edit()
            .putString(PROFILE_PREFS_KEY, b64)
            .apply()
        return true
    }

    /**
     * v3.10.23: restore the primary profile from
     * SharedPreferences on cold start so the user
     * doesn't have to re-teach the app. Sets
     * profileLocked=true since the stored profile was
     * already considered "learned".
     */
    fun loadPersistedPrimaryProfile(): Boolean {
        val ctx = context ?: return false
        val prefs = ctx.getSharedPreferences(PROFILE_PREFS_NAME, android.content.Context.MODE_PRIVATE)
        val b64 = prefs.getString(PROFILE_PREFS_KEY, null) ?: return false
        return try {
            val bytes = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
            if (bytes.size != 96 * 4) return false
            val profile = FloatArray(96)
            for (i in 0 until 96) {
                val bits = (bytes[i * 4 + 0].toInt() and 0xff) or
                    ((bytes[i * 4 + 1].toInt() and 0xff) shl 8) or
                    ((bytes[i * 4 + 2].toInt() and 0xff) shl 16) or
                    ((bytes[i * 4 + 3].toInt() and 0xff) shl 24)
                profile[i] = java.lang.Float.intBitsToFloat(bits)
            }
            primaryProfile = profile
            profileLocked = true
            Log.i(tag, "Restored primary speaker profile from SharedPreferences (96 dims)")
            true
        } catch (e: Exception) {
            Log.w(tag, "Failed to decode stored profile, ignoring: ${e.message}")
            false
        }
    }

    /**
     * v3.10.23: serialize the primary profile to base64.
     * Debug / future use — no current JS consumer.
     */
    fun getPrimaryProfileBase64(): String? {
        val profile = primaryProfile ?: return null
        val bytes = ByteArray(profile.size * 4)
        for (i in profile.indices) {
            val bits = java.lang.Float.floatToRawIntBits(profile[i])
            bytes[i * 4 + 0] = (bits and 0xff).toByte()
            bytes[i * 4 + 1] = ((bits shr 8) and 0xff).toByte()
            bytes[i * 4 + 2] = ((bits shr 16) and 0xff).toByte()
            bytes[i * 4 + 3] = ((bits shr 24) and 0xff).toByte()
        }
        return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    }

    fun getConfirmedWakeFires(): Int = confirmedWakeFires

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

    /**
     * v3.10.1: scan the v3.9.0 directory registry
     * (filesDir/wake_models/<setId>/model.tflite) for
     * a set whose meta.json phrase matches the given
     * wakeword. Returns the absolute path of the
     * matching model's model.tflite, or null if none.
     *
     * Match strategy:
     *  1. Read SharedPreferences `wake_models` for
     *     the active_<agentId> binding. If the
     *     wakeword argument matches the active
     *     set's agentId (case-insensitive), prefer
     *     that set.
     *  2. Otherwise, scan all sets, compare phrase
     *     (case-insensitive, trimmed, exact match
     *     preferred, contains-match as fallback).
     *     Newest by createdAt wins ties.
     *
     * The reason for the SharedPreferences check
     * first: when initOww is called with the typed
     * phrase (e.g. "Hey Clawsuu"), the user usually
     * wants the currently-active wake model. The
     * active binding points to the setId whose
     * meta.json.phrase is "Hey Clawsuu". Going
     * straight to the active binding avoids
     * matching an old, deleted set that happens to
     * share the same phrase.
     */
    private fun findWakeModelByPhrase(context: android.content.Context, wakeword: String): String? {
        val root = java.io.File(context.filesDir, "wake_models")
        if (!root.isDirectory) return null
        val normalized = wakeword.lowercase().trim()
        // SharedPreferences: check if wakeword is
        // an agentId with an active binding whose
        // set's phrase matches. This is the common
        // case for initOww(companionName) callers
        // that already know the agentId.
        try {
            val prefs = context.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            for ((key, _) in prefs.all) {
                if (!key.startsWith("active_")) continue
                val agentId = key.removePrefix("active_")
                if (agentId.lowercase() != normalized) continue
                val setId = prefs.getString(key, null) ?: continue
                val modelFile = java.io.File(java.io.File(root, setId), "model.tflite")
                if (modelFile.exists()) return modelFile.absolutePath
            }
        } catch (_: Exception) {
            // ignore, fall through to scan
        }
        // Fallback: scan all sets, match by phrase.
        // Higher score wins; for equal score, newer
        // (larger createdAt) wins.
        val children = root.listFiles() ?: return null
        data class Match(val path: String, val score: Int, val createdAt: Long)
        var best: Match? = null
        for (setDir in children) {
            if (!setDir.isDirectory) continue
            val metaFile = java.io.File(setDir, "meta.json")
            if (!metaFile.exists()) continue
            val obj = try {
                org.json.JSONObject(metaFile.readText())
            } catch (_: Exception) { continue }
            val phrase = obj.optString("phrase")
            if (phrase.isEmpty()) continue
            val phraseNorm = phrase.lowercase().trim()
            // Exact match wins; contains-match is a
            // fallback for partial-phrase callers.
            val score = when {
                phraseNorm == normalized -> 2
                phraseNorm.contains(normalized) || normalized.contains(phraseNorm) -> 1
                else -> 0
            }
            if (score == 0) continue
            val createdAt = obj.optLong("createdAt")
            val modelFile = java.io.File(setDir, "model.tflite")
            if (!modelFile.exists()) continue
            val cur = best
            if (cur == null || score > cur.score ||
                (score == cur.score && createdAt > cur.createdAt)) {
                best = Match(modelFile.absolutePath, score, createdAt)
            }
        }
        return best?.path
    }
}
