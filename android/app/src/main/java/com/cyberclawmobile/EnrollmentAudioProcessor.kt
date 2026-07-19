package com.cyberclawmobile

import android.content.Context
import android.util.Log

/**
 * v3.10.60: Speaker enrollment processor that runs
 * independently of the OWW classifier detector.
 *
 * Purpose: bootstrap speaker enrollment from audio
 * sources that DON'T go through WakeWordModule's
 * OWW thread (e.g. CyberClawService's Vosk path).
 * Before v3.10.60, enrollment only accumulated from
 * the OWW thread's chunks — so if the user spent all
 * their wake time in voice mode (where the OWW
 * thread runs in background) but never had a fresh
 * trained model firing, the speaker profile would
 * never lock.
 *
 * The EnrollmentAudioProcessor owns its own
 * OpenWakeWordDetector instance loaded in EMBEDDING-
 * ONLY mode (melspec + embedding, no wake/exit/send
 * classifiers). This is cheaper than a full
 * classifier — no classifier interpreter, no
 * threshold checks, just the 96-dim embedding output
 * per chunk.
 *
 * Both WakeWordModule's OWW thread (for the foreground
 * TFLite path) and CyberClawService (for the BG Vosk
 * path) can push audio into this processor. The
 * speaker profile is shared via SharedPreferences
 * (key "speaker_profile_v1") so both paths see the
 * same locked profile.
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  EnrollmentAudioProcessor (singleton)        │
 *   │                                              │
 *   │  - OpenWakeWordDetector (embedding only)     │
 *   │  - profile (primaryProfile + profileLocked)  │
 *   │  - SharedPreferences persistence             │
 *   │                                              │
 *   │  API:                                         │
 *   │    processAudio(samples, count)              │
 *   │    shouldSuppressWake()                       │
 *   │    markConfirmedWake()                        │
 *   │    isProfileLocked()                          │
 *   │    getMatchScore()                            │
 *   │    getEnrollmentSampleCount()                 │
 *   └─────────────────────────────────────────────┘
 *              ▲                  ▲
 *              │                  │
 *      ┌───────┴──────┐    ┌──────┴──────────┐
 *      │ OWW thread   │    │ CyberClawService │
 *      │ (foreground) │    │ (BG, Vosk)       │
 *      └──────────────┘    └─────────────────┘
 *
 * v3.10.60 is the bootstrap: CyberClawService
 * (Vosk path) feeds audio and checks the speaker
 * gate. WakeWordModule's OWW thread still uses its
 * own enrollment + gate (existing v3.10.23 logic).
 * v3.10.61 will unify the two — make this processor
 * the sole profile owner and have the OWW thread
 * delegate here.
 *
 * The reason for the two-step rollout: the OWW
 * thread's enrollment is currently tied to its
 * detector's lifecycle (close() resets the
 * detector), while this processor is a long-lived
 * singleton. Unifying without breaking the OWW
 * path's existing behavior needs a careful refactor
 * that I'll do separately.
 */
class EnrollmentAudioProcessor private constructor(private val appContext: Context) {

    companion object {
        private const val TAG = "EnrollmentAudioProcessor"

        @Volatile private var instance: EnrollmentAudioProcessor? = null

        /**
         * Get the singleton instance. Created lazily on
         * first access. Safe to call from any thread.
         */
        @JvmStatic
        fun getInstance(context: Context): EnrollmentAudioProcessor {
            return instance ?: synchronized(this) {
                instance ?: EnrollmentAudioProcessor(
                    context.applicationContext
                ).also { instance = it }
            }
        }
    }

    private val detector: OpenWakeWordDetector
    private val lock = Any()

    // 1280-sample chunks (80ms at 16kHz) — matches
    // the openWakeWord natural frame size used
    // throughout the codebase.
    private var audioBuffer = ShortArray(4096)
    private var bufferFill = 0

    init {
        detector = OpenWakeWordDetector(appContext)
        // Load melspec + embedding only. No wake
        // classifier, no exit/send classifier. The
        // detector runs in "embedding-only" mode
        // (loadEmbeddingOnly sets the flag; the
        // predictScore path checks this flag and
        // skips classifier inference).
        val ok = detector.loadEmbeddingOnly()
        if (!ok) {
            Log.e(TAG, "Failed to load embedding models — enrollment will be non-functional")
        } else {
            // Restore any persisted profile from a
            // previous session. mark as locked since
            // a stored profile was already considered
            // "learned".
            try {
                detector.loadPersistedPrimaryProfile()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load persisted profile: ${e.message}")
            }
            Log.i(TAG, "Initialized with persisted profile: ${detector.hasPrimaryProfile()}, locked=${detector.isProfileLocked()}")
        }
    }

    /**
     * Push audio samples into the enrollment pipeline.
     * Buffers internally and emits 1280-sample chunks
     * to the detector for embedding extraction. Voice-
     * active chunks (RMS + ZCR above threshold) are
     * accumulated into the enrollment buffer.
     *
     * Safe to call from any thread.
     */
    fun processAudio(samples: ShortArray, count: Int) {
        if (count <= 0) return
        synchronized(lock) {
            // Grow buffer if needed
            if (audioBuffer.size < bufferFill + count) {
                var newSize = audioBuffer.size * 2
                while (newSize < bufferFill + count) newSize *= 2
                val newBuf = ShortArray(newSize)
                System.arraycopy(audioBuffer, 0, newBuf, 0, bufferFill)
                audioBuffer = newBuf
            }
            System.arraycopy(samples, 0, audioBuffer, bufferFill, count)
            bufferFill += count

            // Emit 1280-sample chunks
            var processed = 0
            while (bufferFill - processed >= 1280) {
                val chunk = ShortArray(1280)
                System.arraycopy(audioBuffer, processed, chunk, 0, 1280)
                processed += 1280
                processChunkLocked(chunk)
            }
            // Shift remaining samples to the start
            if (processed > 0) {
                val remaining = bufferFill - processed
                System.arraycopy(audioBuffer, processed, audioBuffer, 0, remaining)
                bufferFill = remaining
            }
        }
    }

    /**
     * Process one 1280-sample chunk. Voice-active check
     * mirrors the OWW thread's PASSIVE_ENROLLMENT
     * thresholds (RMS >= 0.010, ZCR >= 0.02) so both
     * paths contribute equivalent samples.
     */
    private fun processChunkLocked(chunk: ShortArray) {
        val (rms, zcr) = computeEnergyAndZcr(chunk)
        if (rms < 0.010f || zcr < 0.02f) return

        // computeEmbedding only runs melspec + embedding
        // (no classifiers) — cheaper than predictScore.
        val embedding = detector.computeEmbedding(chunk) ?: return
        // accumulateLatestEmbedding adds the most
        // recent embedding (already stashed in
        // embeddingHistory by computeEmbedding) into
        // the enrollment buffer.
        detector.accumulateLatestEmbedding()
    }

    /**
     * PCM16 energy + zero-crossing rate. Mirrors
     * WakeWordModule.computeEnergyAndZcr (duplicated
     * here to avoid coupling to WakeWordModule — the
     * processor must work even before the React
     * context is up).
     */
    private fun computeEnergyAndZcr(pcm16: ShortArray): Pair<Float, Float> {
        var sumSq = 0.0
        var zc = 0
        var prev = 0
        for (s in pcm16) {
            val n = s.toInt()
            sumSq += (n.toDouble() * n.toDouble())
            if (prev != 0 && ((n > 0) != (prev > 0))) zc++
            prev = n
        }
        val rms = Math.sqrt(sumSq / pcm16.size).toFloat() / 32768f
        val zcr = zc.toFloat() / pcm16.size
        return rms to zcr
    }

    /**
     * Returns true if the recent audio doesn't match
     * the enrolled speaker's profile (and the profile
     * is locked). Returns false if the profile isn't
     * set yet (the system has to work before it can
     * learn).
     */
    fun shouldSuppressWake(): Boolean {
        return synchronized(lock) {
            detector.shouldSuppressWakeForSpeaker()
        }
    }

    /**
     * Bump the confirmed-wake-fire counter. Called
     * when a wake fires AND the audio was voice-active
     * — used as one of the conditions for the profile
     * to lock.
     */
    fun markConfirmedWake() {
        synchronized(lock) {
            detector.noteConfirmedWakeFire()
        }
    }

    /**
     * True if the profile has accumulated enough
     * samples + confirmed wakes to be considered
     * "locked" (i.e. the speaker gate is now active).
     */
    fun isProfileLocked(): Boolean {
        return synchronized(lock) {
            detector.isProfileLocked()
        }
    }

    /**
     * True if any profile is set (locked or not). For
     * UI display.
     */
    fun hasProfile(): Boolean {
        return synchronized(lock) {
            detector.hasPrimaryProfile()
        }
    }

    /**
     * Cosine similarity between the recent audio
     * (last ~640ms = 8 chunks) and the enrolled
     * profile. Returns null if no profile is set.
     */
    fun getMatchScore(): Float? {
        return synchronized(lock) {
            detector.matchRecentSpeaker()
        }
    }

    /**
     * Total voice-active chunks accumulated since
     * enrollment began. For UI display.
     */
    fun getEnrollmentSampleCount(): Long {
        return synchronized(lock) {
            detector.getEnrollmentSamplesTotal()
        }
    }

    /**
     * Clear the enrolled profile. Used by the
     * "Reset speaker profile" UI button.
     */
    fun clearProfile() {
        synchronized(lock) {
            detector.clearPrimaryProfileAndCounters()
        }
    }

    /**
     * v3.10.62: force-lock the profile regardless of
     * sample count. Called by the active-enrollment UI
     * after a 30-second recording pass completes, so
     * the speaker gate activates immediately without
     * waiting for PROFILE_LOCK_SAMPLES (1000).
     *
     * Requires at least 50 voice-active samples (the
     * default in the detector's forceLockProfile). If
     * fewer than 50 samples were accumulated during the
     * recording, the lock fails and the caller should
     * show "couldn't lock, try again in a quieter room".
     *
     * Returns true iff this call caused the lock.
     */
    fun forceLockProfile(minSamples: Int = 50): Boolean {
        return synchronized(lock) {
            detector.forceLockProfile(minSamples)
        }
    }

    /**
     * Release the detector's native resources. Call
     * when the app is shutting down (rarely needed —
     * the singleton persists for the app lifetime).
     */
    fun close() {
        synchronized(lock) {
            try {
                detector.close()
            } catch (e: Exception) {
                Log.w(TAG, "close failed: ${e.message}")
            }
        }
    }
}