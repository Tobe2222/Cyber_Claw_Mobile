package com.cyberclawmobile

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.io.IOException

class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    // Required by NativeEventEmitter on the JS side
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // v3.1.82 / v3.1.86: persistent wake-pending flag. Read by
    // App.tsx on mount + AppState=active to recover from
    // the race where MainActivity emitted wakeWordOpenedApp
    // BEFORE App.tsx's listener subscribed (cold start
    // from lock-screen notification, the JS context can
    // take longer to init than the 5s emit-retry budget
    // covers). The flag is set in MainActivity.checkWakeIntent
    // when the wake intent extra is present, and cleared
    // by the JS side once consumed. Stored in
    // SharedPreferences so it survives process death
    // (which AsyncStorage writes may not, in the brief
    // window between kill and JS consume).
    //
    // v3.1.86: also returns the timestamp at which the
    // flag was set. The JS side uses this to distinguish
    // fresh flags (real wake event in this session) from
    // stale flags (persisted across an app kill). Stale
    // flags are cleared without consuming, so the user
    // doesn't get spuriously yanked into Wake Mode on a
    // cold launch.
    @ReactMethod fun isWakePending(promise: Promise) {
      try {
        val prefs = reactContext.getSharedPreferences("wake_state", android.content.Context.MODE_PRIVATE)
        val pending = prefs.getBoolean("wake_pending", false)
        val setAt = prefs.getLong("wake_pending_at", 0L)
        val map = com.facebook.react.bridge.Arguments.createMap()
        map.putBoolean("pending", pending)
        map.putDouble("setAt", setAt.toDouble())
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("error", e.message)
      }
    }

    @ReactMethod fun clearWakePending(promise: Promise) {
      try {
        val prefs = reactContext.getSharedPreferences("wake_state", android.content.Context.MODE_PRIVATE)
        // v3.1.86: also clear the timestamp so a stale
        // timestamp from a prior session can't combine
        // with a freshly-set flag.
        prefs.edit()
          .putBoolean("wake_pending", false)
          .putLong("wake_pending_at", 0L)
          .apply()
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("error", e.message)
      }
    }

    private val handler = Handler(Looper.getMainLooper())

    private fun emit(event: String, state: String, text: String? = null) {
        val map = Arguments.createMap()
        map.putString("state", state)
        if (text != null) map.putString("text", text)
        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, map)
    }

    private fun emitDebug(state: String, text: String? = null) = emit("wakeWordDebug", state, text)

    // ── Vosk Wake Word ─────────────────────────────────────────────────────

    private var voskModel: Model? = null
    private var audioRecord: AudioRecord? = null
    private var listenThread: Thread? = null
    @Volatile private var isListening = false
    @Volatile private var isRecording = false
    private var wakePhrase = "hey clawsuu"

    private fun getModelDir(): File {
        val dir = File(reactContext.filesDir, "vosk-model-small-en")
        dir.mkdirs()
        return dir
    }

    private fun isModelReady(): Boolean {
        val dir = getModelDir()
        // Vosk model directory must contain am/final.mdl
        return File(dir, "am/final.mdl").exists()
    }

    private fun downloadModel(onDone: (Boolean) -> Unit) {
        emitDebug("downloading", "Downloading wake word model (~50MB)...")
        Thread {
            try {
                val zipFile = File(reactContext.cacheDir, "vosk-model-small-en.zip")
                val url = java.net.URL("https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.connect()
                val input = conn.inputStream
                val out = java.io.FileOutputStream(zipFile)
                val buf = ByteArray(8192)
                var n: Int
                while (input.read(buf).also { n = it } != -1) out.write(buf, 0, n)
                out.close(); input.close()

                // Unzip into filesDir/vosk-model-small-en
                val destDir = File(reactContext.filesDir, "vosk-model-small-en")
                destDir.mkdirs()
                val zis = java.util.zip.ZipInputStream(java.io.FileInputStream(zipFile))
                var entry = zis.nextEntry
                while (entry != null) {
                    // Strip top-level dir from zip (vosk-model-small-en-us-0.15/am/... -> am/...)
                    val name = entry.name.substringAfter("/")
                    if (name.isNotEmpty()) {
                        val outFile = File(destDir, name)
                        if (entry.isDirectory) outFile.mkdirs()
                        else {
                            outFile.parentFile?.mkdirs()
                            val fos = java.io.FileOutputStream(outFile)
                            val b = ByteArray(8192); var r: Int
                            while (zis.read(b).also { r = it } != -1) fos.write(b, 0, r)
                            fos.close()
                        }
                    }
                    zis.closeEntry(); entry = zis.nextEntry
                }
                zis.close()
                zipFile.delete()

                val model = Model(destDir.absolutePath)
                voskModel = model
                handler.post { emitDebug("model_ready", "Wake word model ready") }
                onDone(true)
            } catch (e: Exception) {
                Log.e("WakeWord", "Model download failed", e)
                handler.post { emitDebug("error", "Model download failed: ${e.message}") }
                onDone(false)
            }
        }.also { it.isDaemon = true; it.start() }
    }

    @ReactMethod fun start(phrase: String, promise: Promise) {
        wakePhrase = phrase.lowercase().trim()
        isListening = true

        val startListening = {
            try {
                startVoskListening()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("START_ERROR", e.message)
            }
        }

        if (voskModel != null) {
            startListening()
        } else if (isModelReady()) {
            try {
                voskModel = Model(getModelDir().absolutePath)
                startListening()
            } catch (e: Exception) {
                promise.reject("MODEL_ERROR", e.message)
            }
        } else {
            downloadModel { success ->
                if (success) {
                    startListening()
                } else {
                    promise.reject("MODEL_DOWNLOAD_FAILED", "Could not download Vosk model")
                }
            }
        }
    }

    private fun startVoskListening() {
        stopAudioRecord()

        val sampleRate = 16000
        val bufferSize = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(4096)

        val model = voskModel ?: throw IOException("Model not loaded")
        val recognizer = Recognizer(model, sampleRate.toFloat())
        // No grammar/setGrammar — causes SIGSEGV with standard models
        val rec = AudioRecord(
            android.media.MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize
        )
        audioRecord = rec
        
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            throw IOException("AudioRecord failed to initialize (state=${rec.state})")
        }
        
        try {
            rec.startRecording()
            if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw IOException("AudioRecord.startRecording() failed (state=${rec.recordingState})")
            }
        } catch (e: Exception) {
            Log.e("WakeWord", "Failed to start recording", e)
            emitDebug("error", "Microphone failed: ${e.message}")
            throw e
        }

        emitDebug("ready", "Listening for \"$wakePhrase\"")

        listenThread = Thread {
            val buf = ShortArray(bufferSize / 2)
            val byteBuf = ByteArray(bufferSize)
            var totalBytes = 0L
            var silentFrames = 0
            while (isListening) {
                val read = rec.read(buf, 0, buf.size)
                if (read <= 0) {
                    silentFrames++
                    if (silentFrames == 1) {
                        // First silent frame - unexpected
                        Log.w("WakeWord", "AudioRecord.read() returned $read")
                    }
                    if (silentFrames > 100) {
                        // Consistent silence = microphone issue
                        handler.post {
                            emitDebug("error", "Microphone not providing audio after 100 frames")
                        }
                    }
                    continue
                }
                silentFrames = 0
                totalBytes += read * 2

                // Convert shorts to bytes (little-endian PCM)
                for (i in 0 until read) {
                    byteBuf[i * 2] = (buf[i].toInt() and 0xFF).toByte()
                    byteBuf[i * 2 + 1] = (buf[i].toInt() shr 8 and 0xFF).toByte()
                }

                if (recognizer.acceptWaveForm(byteBuf, read * 2)) {
                    val result = recognizer.result
                    checkWakeWord(result)
                } else {
                    val partial = recognizer.partialResult
                    checkWakeWord(partial)
                }
            }
            recognizer.close()
        }.also { it.isDaemon = true; it.start() }
    }

    private fun checkWakeWord(json: String) {
        val text = Regex("\"(text|partial)\"\\s*:\\s*\"([^\"]+)\"")
            .find(json)?.groupValues?.get(2)?.lowercase() ?: return
        if (text.isBlank() || text == "[unk]") return

        emitDebug("partial", text)

        // v3.10.4: same stricter threshold + token-count
        // guard as CyberClawService. The
        // PhoneticMatcher default of 0.55 fires on
        // "hey" for target "hey clawsuu" (avgScore
        // 0.57) — Tobe's v3.10.3 false trigger source.
        // Threshold 0.7 + require >= N-1 words
        // knocks out the single-word partials while
        // keeping fuzzy full-phrase matches.
        if (PhoneticMatcher.matches(text, wakePhrase, threshold = 0.7)) {
            val heardWords = text.split(Regex("\\s+")).filter { it.isNotBlank() }
            val targetWords = wakePhrase.split(Regex("\\s+")).filter { it.isNotBlank() }
            if (heardWords.size >= targetWords.size - 1 && heardWords.isNotEmpty()) {
                Log.d("WakeWord", "Wake phrase detected: $text (target: $wakePhrase)")
                handler.post {
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("wakeWordDetected", null)
                }
                emitDebug("detected", text)
            }
        }
    }

    @ReactMethod fun stop(promise: Promise) {
        isListening = false
        
        // FIX: Interrupt the blocked read() call to unblock the thread
        listenThread?.interrupt()
        
        // FIX: Wait for thread to actually stop (up to 1 second)
        try {
            listenThread?.join(1000)
        } catch (_: Exception) {}
        
        stopAudioRecord()
        promise.resolve(null)
    }

    private fun stopAudioRecord() {
        isListening = false
        
        // Close audio input to unblock any pending read()
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
        
        // FIX: Properly interrupt and join the thread
        try {
            listenThread?.interrupt()
            listenThread?.join(500)  // Wait up to 500ms for thread to exit
        } catch (_: Exception) {}
        listenThread = null
    }

    @ReactMethod fun test(promise: Promise) {
        emitDebug("test", "ok")
        promise.resolve(null)
    }

    // ── Audio Recording ────────────────────────────────────────────────────
    //
    // v3.9.4: switched from MediaRecorder (compressed m4a) to
    // AudioRecord (raw PCM16 → WAV). Two reasons:
    //
    //   1. Send-phrase detection. The v3.6.0 send classifier
    //      runs inside OpenWakeWordDetector.predictScore(pcm16),
    //      which needs 1280-sample (80ms @ 16kHz) PCM16
    //      chunks. MediaRecorder produces compressed m4a —
    //      there's no way to extract raw PCM chunks in real
    //      time without decoding the m4a on a separate thread,
    //      which would add 50-200ms latency (breaking the
    //      send-phrase UX where the user expects instant
    //      response after saying "send it"). AudioRecord
    //      gives us raw PCM natively.
    //
    //   2. No second mic client. Android only allows ONE
    //      app to read from MIC at a time per stream type.
    //      The OWW listening thread uses AudioRecord on MIC
    //      for its detector. If both OWW and the recorder
    //      open MIC simultaneously, one of them gets silent
    //      data (or fails outright). v3.9.4 explicitly stops
    //      the OWW thread for the duration of the recording
    //      turn so the recorder has exclusive MIC access,
    //      and restarts OWW when the turn ends.
    //
    // The recording thread below does BOTH the silence/wait-
    // for-speech logic AND the send/exit-phrase detection in
    // one pass. Per 80ms chunk it:
    //   - feeds the chunk to OpenWakeWordDetector.predictScore()
    //     → checks sendScore vs sendThreshold and exitScore vs
    //     exitThreshold with the same HIGH_SCORE_RUN/cooldown
    //     pattern as the OWW thread. Emits owwSendDetected /
    //     owwExitDetected on hit. Skips wake score (voice
    //     mode is past the wake step).
    //   - computes RMS+ZCR on the chunk → emits owwVad at
    //     ~1Hz cadence for the JS gibberish gate (carries
    //     forward the v3.9.3 behavior, but now with REAL
    //     PCM energy rather than MediaRecorder.maxAmplitude,
    //     which was the best we could do on m4a).
    //   - tracks hasUserSpoken + silentFor for the existing
    //     v3.2.23 wait-for-speech-then-silence timer; emits
    //     recorderSilence after silenceMs of post-speech
    //     quiet (or MAX_RECORDING_MS hard cap).
    //
    // On stop: drains any pending PCM, writes a standard
    // 16-bit mono 16kHz WAV file (reuses writeWav below).
    // JS API signature unchanged — SimpleAudioRecorder.start()
    // / stop() work identically, just the file extension the
    // JS callers construct for the temp path should now be
    // .wav (not .m4a) since that's what's actually produced.
    private var recorderAudioRecord: AudioRecord? = null
    private var recorderThread: Thread? = null
    @Volatile private var isRecorderActive = false
    // PCM16 samples accumulate here while recording; flushed
    // to a WAV file on stopRecorder(). Buffer is sized to
    // comfortably hold 30s of audio (30s * 16kHz * 2 bytes =
    // 960KB; we start at 32KB and grow as needed).
    private val recorderPcmBuf = java.io.ByteArrayOutputStream(32 * 1024)
    private var recordingPath: String? = null
    private var recorderSampleRate = 16000
    // v3.9.4: the OWW thread holds MIC when running. Since
    // the recorder now also needs MIC (as AudioRecord), we
    // explicitly stop the OWW thread before grabbing MIC and
    // restart it after release. `owwWasListeningBeforeRecord`
    // captures whether OWW was active so we only restart it
    // if the user was actually in wake-listening mode (in
    // voice-mode the user might already have OWW stopped).
    private var owwWasListeningBeforeRecord = false

    @ReactMethod fun startRecorder(path: String, promise: Promise) {
        startRecorderWithSilence(path, 5000, true, promise)
    }

    /**
     * v3.10.28: added `useSmartSilence` arg. When true
     * (default for the new call sites), the recorder
     * uses RELATIVE silence detection: silence
     * threshold is computed from the gap between the
     * user's speech floor and the ambient noise floor,
     * not a fixed absolute RMS. This makes the silence
     * detector work in cafés / traffic / HVAC / any
     * environment where ambient noise exceeds the old
     * hardcoded 0.005 silence threshold.
     *
     * When false, the v3.10.12 absolute thresholds
     * (0.010 speech / 0.005 silence) are used —
     * identical to v3.10.27 behavior. The toggle is in
     * Voice mode settings ("Smart silence
     * (noise-aware)"), default on.
     */
    @ReactMethod fun startRecorderWithSilence(path: String, silenceMs: Int, useSmartSilence: Boolean, promise: Promise) {
        try {
            // v3.9.4: stop the OWW listening thread before
            // grabbing MIC. Android only allows ONE app to
            // read from MIC per stream type at a time; both
            // the OWW thread (AudioRecord on MIC) and the new
            // recorder (AudioRecord on MIC) would conflict.
            // Capture the pre-existing state so we can restore
            // it on stopRecorder().
            owwWasListeningBeforeRecord = isOwwListening
            if (isOwwListening) {
                // stopOwwListening() is synchronous-ish — it
                // sets isOwwListening=false and joins the
                // thread with a 2s timeout. Good enough for
                // our purposes; if join times out we proceed
                // anyway since the recorder opening will
                // force the OWW AudioRecord read() to fail.
                stopOwwListeningInternal()
            }
            isRecording = true
            // (isListening = false is now redundant for the
            // OWW case — we stopped it above — but the legacy
            // Vosk wake-word loop (if ever re-enabled) still
            // checks this flag, so leave it for backward
            // compat.)
            isListening = false

            val outFile = File(path)
            outFile.parentFile?.mkdirs()
            recordingPath = path

            val sampleRate = 16000
            recorderSampleRate = sampleRate
            // 1280 samples = 80ms @ 16kHz — openWakeWord's
            // natural frame size. Buffer must be a multiple
            // of chunkSamples for clean chunking; round up
            // to a power of two so AudioRecord's internal
            // ring buffer is happy too.
            val chunkSamples = 1280
            val minBuffer = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(chunkSamples * 2)
            // Use minBuffer directly. AudioRecord's read()
            // blocks until at least one chunk of bytes is
            // available, so we don't need a multi-chunk
            // ring buffer here. Our 1280-sample frame sync
            // is done on top of whatever read() returns.
            val bufferSize = minBuffer

            val rec = AudioRecord(
                android.media.MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                isRecording = false
                tryRestartOwwAfterRecord()
                promise.reject("RECORD_ERROR", "AudioRecord failed to initialize (state=${rec.state})")
                return
            }
            recorderAudioRecord = rec
            try {
                rec.startRecording()
                if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    try { rec.release() } catch (_: Exception) {}
                    recorderAudioRecord = null
                    isRecording = false
                    tryRestartOwwAfterRecord()
                    promise.reject("RECORD_ERROR", "AudioRecord.startRecording failed (state=${rec.recordingState})")
                    return
                }
            } catch (e: Exception) {
                try { rec.release() } catch (_: Exception) {}
                recorderAudioRecord = null
                isRecording = false
                tryRestartOwwAfterRecord()
                promise.reject("RECORD_ERROR", "startRecording threw: ${e.message}")
                return
            }

            // Reset PCM buffer + flags for this recording turn.
            synchronized(recorderPcmBuf) {
                recorderPcmBuf.reset()
            }
            recorderSilentForMs = 0L
            recorderRecordingForMs = 0L
            recorderHasUserSpoken = false
            // v3.10.28: reset smart-silence calibration
            // state on every new recording turn. The
            // speech + noise floors need ~1.5s of
            // speech / ambient to converge; if we
            // re-used them across turns, the
            // calibration would be stale (a 30-minute
            // old speech floor in a now-quiet room is
            // wrong).
            smartSilenceSpeechFloor = 0f
            smartSilenceNoiseFloor = 0.005f
            smartSilenceSpeechSampleCount = 0
            smartSilenceLastVadReportMs = 0L
            smartSilenceEnabled = useSmartSilence
            // Reset detector send/exit high-score counters on
            // each new recording turn so a stale hit from a
            // previous turn can't fire immediately on the new
            // turn's first chunk.
            recorderSendHighScoreFrames = 0
            recorderExitHighScoreFrames = 0
            recorderLastSendAt = 0L
            recorderLastExitAt = 0L
            recorderVadEmitTick = 0
            recorderLastVadAt = 0L
            // v3.10.38: reset the sustained-speech counter
            // on every new recording turn. Without this,
            // a sustained-speech streak from the previous
            // turn (now stopped) would carry over and the
            // first non-speech chunk in the new turn
            // wouldn't reset it (it'd already be at 0 by
            // virtue of recorderHasUserSpoken being false,
            // but the counter is only reset by my new
            // explicit line — not by the older path).
            // Reset explicitly for clarity.
            recorderSpeechFrameCount = 0

            isRecorderActive = true

            // Recording thread: reads PCM, writes to in-memory
            // buffer + per-chunk sends it to the OWW detector
            // for send/exit-phrase + VAD. 80ms chunks (1280
            // samples) match the OWW detector's natural frame
            // size, same as startOwwListening above.
            recorderThread = Thread {
                val readBuf = ShortArray(bufferSize / 2)
                val chunkBuf = ShortArray(chunkSamples)
                var chunkFill = 0
                val sampleRate = recorderSampleRate

                while (isRecorderActive) {
                    val read = try {
                        rec.read(readBuf, 0, readBuf.size)
                    } catch (e: Exception) {
                        Log.w("WakeWord", "Recorder read() threw: ${e.message}")
                        -1
                    }
                    if (read <= 0) {
                        // No data or recorder closed externally.
                        // Brief sleep avoids hot-spinning when MIC
                        // is unavailable. The loop exits via
                        // isRecorderActive = false in stopRecorder.
                        try { Thread.sleep(10) } catch (_: Exception) {}
                        continue
                    }

                    // Track total samples accumulated for VAD
                    // and silence bookkeeping.
                    val nowMs = System.currentTimeMillis()
                    // For every sample we read, accumulate into
                    // the chunkBuf AND the long-term PCM buffer.
                    // We do this in one pass so the chunkBuf
                    // (for detector inference) and the WAV
                    // payload are always in lockstep.
                    var i = 0
                    while (i < read && isRecorderActive) {
                        val toCopy = minOf(read - i, chunkSamples - chunkFill)
                        System.arraycopy(readBuf, i, chunkBuf, chunkFill, toCopy)
                        // Append the chunk samples to the PCM
                        // output buffer as little-endian int16.
                        synchronized(recorderPcmBuf) {
                            for (j in 0 until toCopy) {
                                val s = readBuf[i + j].toInt()
                                recorderPcmBuf.write(s and 0xFF)
                                recorderPcmBuf.write(s shr 8 and 0xFF)
                            }
                        }
                        chunkFill += toCopy
                        i += toCopy

                        if (chunkFill == chunkSamples) {
                            processRecorderChunk(chunkBuf, nowMs, silenceMs.toLong())
                            chunkFill = 0
                        }
                    }
                }

                // Loop exited (stopRecorder set isRecorderActive=false).
                // Any partial chunkFill samples at the end are
                // discarded — they're <80ms which is below
                // detector inference granularity anyway, and
                // keeping them would shift WAV byte counts.
            }.also { it.isDaemon = true; it.start() }

            promise.resolve(path)
        } catch (e: Exception) {
            isRecording = false
            isRecorderActive = false
            tryRestartOwwAfterRecord()
            promise.reject("RECORD_ERROR", e.message)
        }
    }

    @ReactMethod fun stopRecorder(promise: Promise) {
        // Clear recording flag when stopping.
        isRecording = false

        // Signal the recorder thread to exit, then close
        // the AudioRecord. The thread is daemonized, but we
        // still join briefly to ensure clean shutdown.
        isRecorderActive = false
        try { recorderAudioRecord?.stop() } catch (_: Exception) {}
        try { recorderAudioRecord?.release() } catch (_: Exception) {}
        recorderAudioRecord = null
        try {
            recorderThread?.join(2000)
        } catch (_: Exception) {}
        recorderThread = null

        // Write the accumulated PCM as a WAV file to recordingPath.
        // We do this synchronously on the JS thread because the
        // Promise resolves with the path; the JS side reads the
        // file immediately after. The PCM is already in memory
        // (recorderPcmBuf) so writing it out is a single
        // synchronous write — typically <50ms even for 30s of
        // 16kHz audio.
        val outPath = recordingPath ?: ""
        try {
            if (outPath.isNotEmpty()) {
                val pcm: ByteArray
                synchronized(recorderPcmBuf) {
                    pcm = recorderPcmBuf.toByteArray()
                }
                val outFile = File(outPath)
                outFile.parentFile?.mkdirs()
                writeWav(outFile, pcm, recorderSampleRate)
                emitDebug("info", "Recorder WAV written: $outPath (${pcm.size} bytes PCM)")
            }
        } catch (e: Exception) {
            Log.e("WakeWord", "Failed to write recorder WAV: ${e.message}", e)
            promise.reject("RECORD_STOP_ERROR", "WAV write failed: ${e.message}")
            // Still try to restart OWW below so the app stays
            // in a sane state even after a write failure.
            tryRestartOwwAfterRecord()
            return
        }

        // Restart the OWW listening thread if it was running
        // before this recording turn started. In voice-mode
        // turns the user often stays in voice mode (the JS
        // side calls startRecordingTurn() to loop into the
        // next turn), in which case we DON'T want OWW running
        // — but if the user exits voice mode, OWW should be
        // ready. To handle both cleanly, we always restore
        // OWW to its pre-record state. The JS side will call
        // stopOwwListening() explicitly if it wants voice mode
        // to stay active.
        tryRestartOwwAfterRecord()

        promise.resolve(outPath)
    }

    /**
     * Restart the OWW listening thread iff it was running
     * before the current recording turn started. Idempotent
     * if OWW is already running.
     */
    private fun tryRestartOwwAfterRecord() {
        if (!owwWasListeningBeforeRecord) return
        if (isOwwListening) return
        // We don't have an OWW Promise to resolve here; this
        // is best-effort. Failures are logged but not bubbled
        // up — stopRecorder's promise is for the WAV file,
        // not the OWW restart.
        try {
            startOwwListening(noOpPromise("Failed to restart OWW after recording"))
        } catch (e: Exception) {
            Log.w("WakeWord", "startOwwListening after record threw: ${e.message}")
        }
        owwWasListeningBeforeRecord = false
    }

    /**
     * Build a no-op Promise that logs failures but never
     * blocks the caller. Used when invoking a Promise-based
     * API (like startOwwListening) from a non-Promise context
     * (e.g. the recorder's stopRecorder, which has its own
     * Promise to resolve with the WAV path).
     */
    private fun noOpPromise(failurePrefix: String): Promise {
        val log = { msg: String? -> Log.w("WakeWord", "$failurePrefix: $msg") }
        return object : Promise {
            override fun resolve(value: Any?) {}
            override fun reject(code: String?, message: String?) { log("$code: $message") }
            override fun reject(code: String?, throwable: Throwable?) { log("$code: ${throwable?.message}") }
            override fun reject(throwable: Throwable) { log(throwable.message) }
            override fun reject(code: String?, message: String?, throwable: Throwable?) { log("$code: $message / ${throwable?.message}") }
            override fun reject(throwable: Throwable, userInfo: com.facebook.react.bridge.WritableMap) { log(throwable.message) }
            override fun reject(code: String?, userInfo: com.facebook.react.bridge.WritableMap) { log("$code: (userInfo)") }
            override fun reject(code: String?, throwable: Throwable?, userInfo: com.facebook.react.bridge.WritableMap) { log("$code: ${throwable?.message}") }
            override fun reject(code: String?, message: String?, userInfo: com.facebook.react.bridge.WritableMap) { log("$code: $message") }
            override fun reject(code: String?, message: String?, throwable: Throwable?, userInfo: com.facebook.react.bridge.WritableMap?) { log("$code: $message / ${throwable?.message}") }
            override fun reject(message: String) { log(message) }
        }
    }

    /**
     * Internal synchronous-ish version of stopOwwListening.
     * Used by startRecorderWithSilence to free MIC before
     * opening the recorder's AudioRecord. The public
     * stopOwwListening ReactMethod is identical but takes a
     * Promise; this one swallows it so we can call it from
     * a non-Promise context (startRecorderWithSilence
     * resolves its own Promise).
     */
    private fun stopOwwListeningInternal() {
        isOwwListening = false
        try { owwRecord?.stop() } catch (_: Exception) {}
        try { owwRecord?.release() } catch (_: Exception) {}
        owwRecord = null
        try { owwThread?.join(2000) } catch (_: Exception) {}
        owwThread = null
    }

    // ---- per-chunk recorder-thread state ----
    // These are owned by the recorder thread (no need for
    // @Volatile or synchronization — only that thread reads
    // and writes them). Marked @Volatile for safety because
    // stopRecorder() and the recorder thread may briefly
    // overlap on shutdown.
    @Volatile private var recorderSilentForMs = 0L
    @Volatile private var recorderRecordingForMs = 0L
    @Volatile private var recorderHasUserSpoken = false
    // v3.10.38: sustained-speech frame counter. A single
    // 80ms chunk above SPEECH_RMS_THRESHOLD now only
    // increments this counter; recorderHasUserSpoken
    // only flips true after MIN_RECORDER_SPEECH_FRAMES
    // consecutive speech chunks (= sustained speech
    // before silence can fire). Tobe's v3.10.36 report
    // (recurring in v3.10.37 testing): "On the second my
    // turn it still jumped to responding for some reason,
    // no sending and transcribing." Likely cause: a
    // brief ambient noise (cough, table click, mic
    // rustle, audio cue bleed) at the start of a turn
    // crossed RMS 0.010 for a single chunk, marked
    // recorderHasUserSpoken=true, and primed the silence
    // window. The 6s silence window then fired on a
    // low-content audio, the LLM responded quickly, and
    // the cycle continued. The minimum-frames guard
    // ensures clicks/transients don't trip the speech
    // flag — only sustained user intent to speak does.
    @Volatile private var recorderSpeechFrameCount = 0
    @Volatile private var recorderSendHighScoreFrames = 0
    @Volatile private var recorderExitHighScoreFrames = 0
    @Volatile private var recorderLastSendAt = 0L
    @Volatile private var recorderLastExitAt = 0L
    @Volatile private var recorderVadEmitTick = 0
    @Volatile private var recorderLastVadAt = 0L
    // v3.10.28: smart-silence calibration state. Reset
    // at the start of every recording turn. See
    // processRecorderChunk for the update logic.
    //
    // speechFloor: rolling 10th-percentile of RMS
    // values observed on speech frames. Represents the
    // user's typical quiet speech level. When the user
    // goes silent, the floor stays put (it's a slow
    // statistic, not the peak). Updated only on frames
    // where the absolute speech threshold (0.010) is
    // crossed — so quiet inter-word gaps don't pollute
    // the floor.
    @Volatile private var smartSilenceSpeechFloor = 0f
    // noiseFloor: rolling 10th-percentile of RMS values
    // observed on ALL frames (passive, always updates).
    // Represents the ambient environment's typical
    // energy. Slow time constant (~10s to converge) so a
    // sudden door closing doesn't cause a rapid
    // re-calibration that the user would feel as the
    // silence detector "lagging" behind a real change.
    @Volatile private var smartSilenceNoiseFloor = 0.005f
    // How many speech frames we've accumulated for the
    // speech floor. Used to gate the transition from
    // absolute to relative thresholds: we don't switch
    // until we have enough speech samples for the
    // floor to be meaningful (~30 frames = ~2.4s of
    // speech).
    @Volatile private var smartSilenceSpeechSampleCount = 0
    // Last time we included the smart-silence stats in
    // the owwVad event. Throttled to ~5Hz to avoid
    // bridge traffic.
    @Volatile private var smartSilenceLastVadReportMs = 0L
    // The per-turn toggle value. Cached here so the
    // recorder thread doesn't need to re-read the
    // argument on every chunk.
    @Volatile private var smartSilenceEnabled = true

    /**
     * Per-chunk (80ms) work in the recorder thread.
     * Runs the OWW detector on the chunk (send + exit scores
     * only — wake is skipped in voice mode), emits periodic
     * VAD events, and updates silence bookkeeping. Same
     * architecture as startOwwListening's chunk handler but
     * trimmed to the send + exit paths.
     */
    private fun processRecorderChunk(chunkBuf: ShortArray, nowMs: Long, silenceMs: Long) {
        // Chunk size is fixed at 1280; approximate the
        // elapsed wall time as 80ms for the silence timer.
        // 80ms × ~12.5 chunks/sec is accurate enough for
        // the silence threshold (1-3 seconds).
        val CHUNK_MS = 80L
        recorderRecordingForMs += CHUNK_MS

        // ---- send / exit phrase detection ----
        val detector = owwDetector
        if (detector != null) {
            val sendThreshold = detector.getSendThreshold()
            val exitThreshold = detector.getExitThreshold()
            val pair = try { detector.predictScore(chunkBuf) } catch (e: Exception) {
                Log.w("WakeWord", "predictScore threw in recorder thread: ${e.message}")
                OpenWakeWordDetector.TripleScores(null, null, null)
            }
            val sendScore = pair.send
            val exitScore = pair.exit

            // Send phrase. Same HIGH_SCORE_RUN + cooldown as
            // the OWW thread so behavior is consistent across
            // the two paths. 3 consecutive frames at 80ms each
            // = ~240ms confirmation window — short enough
            // to feel instant, long enough to avoid single-
            // frame false positives.
            val SEND_HIGH_SCORE_RUN = 3
            val DETECTION_COOLDOWN_MS = 2000L
            if (sendScore != null && sendScore >= sendThreshold) {
                recorderSendHighScoreFrames++
                if (recorderSendHighScoreFrames >= SEND_HIGH_SCORE_RUN) {
                    if (nowMs - recorderLastSendAt >= DETECTION_COOLDOWN_MS) {
                        recorderLastSendAt = nowMs
                        handler.post {
                            val params = Arguments.createMap()
                            params.putDouble("score", sendScore.toDouble())
                            params.putString("sendword", detector.sendNameOrEmpty())
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("owwSendDetected", params)
                        }
                    } else {
                        Log.w("WakeWord", "Send detection (recorder path) suppressed by cooldown")
                    }
                    recorderSendHighScoreFrames = 0
                }
            } else {
                recorderSendHighScoreFrames = 0
            }

            // Exit phrase. Same pattern as send. The JS
            // WakeModeScreen.tsx listener fires a voice-mode
            // close on owwExitDetected; that handler is
            // identical to the OWW thread's exit path so
            // behavior is consistent.
            //
            // v3.9.7 — bumped from 3 to 5 frames for the
            // recorder path specifically. Tobe reported the
            // exit phrase firing "a couple of times" during
            // conversation without him saying the configured
            // exit word. The OWW path uses 3 (240ms
            // confirmation) because the wake word is
            // short and distinct. The exit phrase ("thanks",
            // default) is a 1-syllable common word that
            // appears all the time in natural speech — it
            // needs a longer confirmation window to avoid
            // false positives. 5 × 80ms = 400ms
            // confirmation is still well within natural
            // perception time but filters out single-frame
            // detector spikes that the 3-frame window let
            // through.
            val EXIT_HIGH_SCORE_RUN = 5
            if (exitScore != null && exitScore >= exitThreshold) {
                recorderExitHighScoreFrames++
                if (recorderExitHighScoreFrames >= EXIT_HIGH_SCORE_RUN) {
                    if (nowMs - recorderLastExitAt >= DETECTION_COOLDOWN_MS) {
                        recorderLastExitAt = nowMs
                        handler.post {
                            val params = Arguments.createMap()
                            params.putDouble("score", exitScore.toDouble())
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("owwExitDetected", params)
                        }
                    } else {
                        Log.w("WakeWord", "Exit detection (recorder path) suppressed by cooldown")
                    }
                    recorderExitHighScoreFrames = 0
                }
            } else {
                recorderExitHighScoreFrames = 0
            }
        }

        // ---- VAD emission ----
        // ~1Hz cadence — matches the v3.9.3 polling-loop
        // behavior that was tied to MediaRecorder's 500ms
        // amplitude poll. Emit on every 13th 80ms chunk
        // (13 × 80ms = 1040ms ≈ 1Hz). The OWW thread emits
        // at a higher ~4Hz rate (every 3 chunks × 80ms =
        // 240ms) for its wake-mode use case, but for voice
        // mode the v3.9.3 design chose 1Hz and the JS gate
        // works fine with that, so we keep it.
        recorderVadEmitTick++
        val VAD_EMIT_EVERY_CHUNKS = 13  // 13 × 80ms = 1040ms ≈ 1Hz
        if (recorderVadEmitTick >= VAD_EMIT_EVERY_CHUNKS) {
            recorderVadEmitTick = 0
            val (rms, zcr) = computeEnergyAndZcr(chunkBuf)
            if (nowMs - recorderLastVadAt >= 200L) {  // ~5Hz hard cap
                recorderLastVadAt = nowMs
                handler.post {
                    val params = Arguments.createMap()
                    params.putDouble("rms", rms.toDouble())
                    params.putDouble("zcr", zcr.toDouble())
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("owwVad", params)
                }
            }
        }

        // ---- silence/wait-for-speech bookkeeping ----
        // v3.2.23 model: only fire recorderSilence AFTER the
        // user has spoken at least once. While waiting for
        // first speech, we just track that we're still
        // listening. RMS energy is a much better "has the
        // user spoken" signal than MediaRecorder.maxAmplitude
        // because it's continuous (not quantized to whatever
        // the encoder happened to capture last poll).
        //
        // v3.9.5 — hysteresis. The previous single-threshold
        // design (SPEECH_RMS_THRESHOLD = 0.01) cut users off
        // mid-conversation because natural speech has 100-
        // 300ms inter-word gaps where RMS dips below 0.01
        // (briefly back to ambient-noise levels). Each dip
        // started the silence counter, and once accumulated
        // to silenceMs, the recording ended mid-sentence.
        // Tobe reported this exactly: "the silence detector
        // is too sensitive or not working correctly. It
        // cuts me off mid conversation."
        //
        // Fix: separate thresholds. Speech detection (which
        // resets the counter) uses the higher
        // SPEECH_RMS_THRESHOLD. Silence detection (which
        // accumulates counter) uses the lower
        // SILENCE_RMS_THRESHOLD. The gap between them
        // (hysteresis band) absorbs natural inter-word
        // drops without the silence timer firing. Calibrated
        // for typical conversational speech:
        //   • Speech: RMS ≈ 0.02-0.10 (sustained words)
        //   • Inter-word gap: RMS ≈ 0.008-0.012 (brief dips)
        //   • Ambient noise floor: RMS ≈ 0.001-0.005
        // v3.10.12: lowered thresholds from 0.015/0.008
        // to 0.010/0.005. Tobe's v3.10.11 report: "it
        // cutted me off while talking again. I was mid
        // sentence" with silenceMs=7000. The VAD was
        // classifying his soft speech as "hysteresis
        // band" (between 0.008 and 0.015), which neither
        // reset the silence timer NOR accumulated silence
        // — the intent was to absorb natural inter-word
        // drops without firing. But for soft-spoken users
        // (low mic gain, phone distance, quiet mic on
        // headset), their speech RMS can sit in this
        // band continuously, which means the silence
        // timer keeps growing on every chunk without ever
        // resetting. After 7s the user gets cut off
        // mid-sentence.
        //
        // New thresholds: speech 0.010 (was 0.015),
        // silence 0.005 (was 0.008). The hysteresis band
        // is now 0.005 wide instead of 0.007 — still wide
        // enough to absorb inter-word drops in normal
        // speech but narrow enough that soft-spoken
        // users' RMS gets recognised as speech.
        //
        // With thresholds at 0.010 and 0.005, the gap
        // (0.005 wide) absorbs inter-word drops without
        // bleeding into ambient noise (room noise floor
        // typically 0.001-0.003 per the comment above).
        val (rms, _) = computeEnergyAndZcr(chunkBuf)
        val SPEECH_RMS_THRESHOLD = 0.010f
        val SILENCE_RMS_THRESHOLD = 0.005f
        val MIN_RECORDING_MS = 500L
        val MAX_RECORDING_MS = 30_000L
        // v3.10.38: minimum consecutive speech frames
        // before recorderHasUserSpoken flips true. At
        // 12.5Hz (80ms chunks), 5 frames = 400ms of
        // sustained above-threshold audio. A typical
        // user utterance (a syllable cluster) is
        // 200-400ms; clicks/coughs/transients are
        // <80ms. Requiring 5 frames filters out the
        // transient noise that was causing premature
        // silence-window firing on the second turn of
        // multi-turn loops (Tobe's v3.10.36 report).
        val MIN_RECORDER_SPEECH_FRAMES = 5
        // v3.10.28: number of definite-speech frames
        // required before smart-silence kicks in.
        // At 12.5Hz (80ms chunks), 30 frames = 2.4s
        // of speech. Enough for the EMA to converge
        // to a stable floor (alpha=0.04 → ~95% of
        // value in 75 samples, but the user typically
        // has variability across their speech so we
        // need a longer window than the EMA half-life
        // to get a usable floor).
        val SMART_SILENCE_CALIBRATION_FRAMES = 30

        if (recorderRecordingForMs >= MAX_RECORDING_MS) {
            // v3.10.28: max-recording silence event.
            // Carries the same calibration stats as
            // the regular silence event so the JS
            // side can log the final state.
            handler.post {
                val params = Arguments.createMap()
                params.putBoolean("maxRecordingHit", true)
                params.putBoolean("useSmartSilence", smartSilenceEnabled)
                params.putDouble("noiseFloor", smartSilenceNoiseFloor.toDouble())
                params.putDouble("speechFloor", smartSilenceSpeechFloor.toDouble())
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("recorderSilence", params)
            }
            return
        }
        // Speech band: above SPEECH_RMS_THRESHOLD, we're
        // confident the user is talking. Reset silence counter.
        // v3.10.38: sustained-speech guard. A single chunk
        // crossing threshold now only increments
        // recorderSpeechFrameCount; recorderHasUserSpoken
        // only flips true after MIN_RECORDER_SPEECH_FRAMES
        // (5, = 400ms) consecutive speech chunks. Clicks /
        // coughs / audio cue bleeds / background rustles
        // shorter than ~400ms don't trip the flag. This was
        // the root cause of Tobe's "on the second my turn
        // it jumped to responding for some reason, no
        // sending and transcribing" report — a single
        // ambient-noise chunk early in the recording turn
        // was enough to mark recorderHasUserSpoken=true,
        // primed the silence window, and a low-content
        // audio got sent producing an instant LLM response
        // that cycled the multi-turn loop without the user
        // actually speaking.
        if (rms >= SPEECH_RMS_THRESHOLD) {
            recorderSpeechFrameCount++
            if (recorderSpeechFrameCount >= MIN_RECORDER_SPEECH_FRAMES) {
                recorderHasUserSpoken = true
                recorderSilentForMs = 0L
            }
            return
        }
        // Non-speech frame: reset the run-length counter
        // (any gap breaks the streak). Note: this is
        // ANDed with the smart-silence hysteresis logic
        // below — the counter only resets for definite
        // non-speech frames, which preserves the spirit of
        // the v3.10.28 hysteresis band where RMS in the
        // gap between silence and speech thresholds
        // doesn't count either way.
        recorderSpeechFrameCount = 0
        if (!recorderHasUserSpoken) return
        // Hysteresis band: RMS is between SILENCE and SPEECH
        // v3.10.28: noise-aware silence detection.
        // Replaces the v3.10.12 absolute-threshold
        // design with a self-calibrating, noise-
        // relative design that works in cafés, traffic,
        // and HVAC noise where ambient RMS exceeds
        // the old 0.005 silence threshold.
        //
        // Algorithm:
        //   1. Update `smartSilenceNoiseFloor` (slow
        //      EMA) on every chunk — the ambient
        //      environment's typical RMS. Slow time
        //      constant so a sudden door closing
        //      doesn't cause a rapid re-calibration.
        //   2. If RMS is above the absolute speech
        //      threshold (0.010), the user is
        //      definitely talking. Update
        //      `smartSilenceSpeechFloor` (also slow
        //      EMA, but faster than the noise floor).
        //      Reset the silence counter. Mark
        //      `recorderHasUserSpoken`.
        //   3. Else, if smart-silence is enabled AND
        //      we have enough speech samples
        //      (>=SMART_SILENCE_CALIBRATION_FRAMES,
        //      ~30 = ~2.4s of speech), use a
        //      proportional threshold:
        //        silence = rms < (noiseFloor +
        //          0.30 × (speechFloor - noiseFloor))
        //      with a small hysteresis band on top of
        //      that. In a coffee shop this gives
        //      ~0.024 (vs the old absolute 0.005)
        //      — a 5x bigger gap that absorbs the
        //      ambient noise.
        //   4. Else (warm-up OR toggle-off), use the
        //      v3.10.12 absolute thresholds. Same
        //      code as before for this branch.
        //
        // The two paths converge: if the noise floor
        // is below 0.005 (quiet room) the smart path
        // gives a threshold very close to the
        // absolute 0.005 (since speechFloor is large
        // and the ratio applies). If the user toggles
        // smart silence off, the absolute path is
        // used verbatim — same behavior as v3.10.27.
        //
        // Implementation: we keep the existing
        // SPEECH_RMS_THRESHOLD = 0.010 as the
        // "definitely speech" gate (used by both
        // paths), then branch on smartSilenceEnabled
        // + smartSilenceSpeechSampleCount to decide
        // the silence threshold.

        // Step 1: always update the noise floor. Slow
        // EMA (alpha=0.005 = ~5% per 100 chunks =
        // ~4s half-life) so a sudden ambient change
        // doesn't flip the calibration too fast.
        // Floor starts at 0.005 (the v3.10.12 default)
        // so a quiet environment is the "zero" state.
        if (rms > 0f) {
            val alphaN = 0.005f
            smartSilenceNoiseFloor = smartSilenceNoiseFloor * (1f - alphaN) + rms * alphaN
            // Floor can't go below 0.001 (the floor of
            // a real microphone on a real device).
            if (smartSilenceNoiseFloor < 0.001f) smartSilenceNoiseFloor = 0.001f
        }

        // Step 2: speech path. The absolute
        // SPEECH_RMS_THRESHOLD gate is the same for
        // both smart and absolute modes — we just
        // need to know "is the user definitely
        // talking right now" to update the speech
        // floor and reset the silence counter.
        if (rms >= SPEECH_RMS_THRESHOLD) {
            // Update speech floor (faster EMA than
            // noise floor, alpha=0.04, so the user's
            // speech level tracks within ~1.5s of
            // changes).
            val alphaS = 0.04f
            if (smartSilenceSpeechFloor == 0f) {
                // First speech sample — seed the
                // floor with the current RMS so we
                // don't have to wait for the EMA to
                // climb.
                smartSilenceSpeechFloor = rms
            } else {
                smartSilenceSpeechFloor = smartSilenceSpeechFloor * (1f - alphaS) + rms * alphaS
            }
            smartSilenceSpeechSampleCount++
            recorderHasUserSpoken = true
            recorderSilentForMs = 0L
            return
        }

        // Below the absolute speech threshold.
        // Compute the silence threshold for this
        // chunk (smart or absolute mode).
        val smartReady = smartSilenceEnabled &&
            smartSilenceSpeechSampleCount >= SMART_SILENCE_CALIBRATION_FRAMES
        val effectiveSilenceThreshold: Float
        val effectiveSpeechThreshold: Float
        if (smartReady) {
            // Proportional: silence = 30% of the
            // way from the noise floor to the speech
            // floor. Speech threshold = 70% of the
            // way (mirrors the silence threshold for
            // symmetry, so the hysteresis band is
            // 40% wide — wide enough to absorb
            // inter-word drops).
            val gap = smartSilenceSpeechFloor - smartSilenceNoiseFloor
            if (gap < 0.01f) {
                // Speech floor isn't really above
                // the noise floor (silence-only or
                // very weak speech). Fall back to
                // the absolute path for safety so
                // we don't get a degenerate
                // threshold of (0.005 + 0.30×0.001)
                // = 0.0053.
                effectiveSilenceThreshold = SILENCE_RMS_THRESHOLD
                effectiveSpeechThreshold = SPEECH_RMS_THRESHOLD
            } else {
                effectiveSilenceThreshold = smartSilenceNoiseFloor + 0.30f * gap
                effectiveSpeechThreshold = smartSilenceNoiseFloor + 0.70f * gap
            }
        } else {
            // Warm-up or toggle-off: use the
            // v3.10.12 absolute thresholds.
            effectiveSilenceThreshold = SILENCE_RMS_THRESHOLD
            effectiveSpeechThreshold = SPEECH_RMS_THRESHOLD
        }

        // Hysteresis band: between silence and
        // speech thresholds, don't reset the
        // silence counter (we're not in clear
        // speech) but DON'T accumulate either (this
        // is the inter-word gap zone). Bail
        // without touching recorderSilentForMs.
        if (rms >= effectiveSilenceThreshold && rms < effectiveSpeechThreshold) {
            return
        }

        // Below the silence threshold: actually
        // quiet enough to count as silence.
        if (!recorderHasUserSpoken) return
        if (recorderRecordingForMs < MIN_RECORDING_MS) return
        recorderSilentForMs += CHUNK_MS
        if (recorderSilentForMs >= silenceMs) {
            // v3.10.28: emit the calibration stats
            // alongside the silence event so the JS
            // side can log them once per silence
            // event. Throttled separately from the
            // per-chunk owwVad event so we don't
            // flood the bridge.
            handler.post {
                val params = Arguments.createMap()
                params.putBoolean("useSmartSilence", smartSilenceEnabled)
                params.putBoolean("smartReady", smartReady)
                params.putDouble("noiseFloor", smartSilenceNoiseFloor.toDouble())
                params.putDouble("speechFloor", smartSilenceSpeechFloor.toDouble())
                params.putDouble("silenceThreshold", effectiveSilenceThreshold.toDouble())
                params.putDouble("speechThreshold", effectiveSpeechThreshold.toDouble())
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("recorderSilence", params)
            }
        }
    }

    // ── Raw PCM Recording (for sample matching) ────────────────────────────

    private var rawAudioRecord: AudioRecord? = null
    private var rawRecordThread: Thread? = null
    @Volatile private var isRawRecording = false
    private var rawOutputPath: String? = null

    /**
     * Record raw PCM16 mono 16kHz audio to a WAV file.
     * The JS side reads this file, extracts features, and runs DTW matching.
     */
    @ReactMethod fun startSampleRecord(outputPath: String, promise: Promise) {
        if (isRawRecording) {
            promise.reject("ALREADY_RECORDING", "Raw recording already in progress")
            return
        }
        try {
            isRawRecording = true
            rawOutputPath = outputPath

            val sampleRate = 16000
            val bufferSize = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(4096)

            val rec = AudioRecord(
                android.media.MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                isRawRecording = false
                promise.reject("INIT_ERROR", "AudioRecord failed to initialize")
                return
            }
            rawAudioRecord = rec
            rec.startRecording()

            // Collect raw PCM bytes in memory
            val pcmBytes = java.io.ByteArrayOutputStream()

            rawRecordThread = Thread {
                val buf = ShortArray(bufferSize / 2)
                while (isRawRecording) {
                    val read = rec.read(buf, 0, buf.size)
                    if (read > 0) {
                        for (i in 0 until read) {
                            pcmBytes.write(buf[i].toInt() and 0xFF)
                            pcmBytes.write(buf[i].toInt() shr 8 and 0xFF)
                        }
                    }
                }
                // Write WAV file
                try {
                    val pcm = pcmBytes.toByteArray()
                    val outFile = File(outputPath)
                    outFile.parentFile?.mkdirs()
                    writeWav(outFile, pcm, sampleRate)
                    handler.post {
                        val params = Arguments.createMap()
                        params.putString("path", outputPath)
                        params.putInt("bytes", pcm.size)
                        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("sampleRecordDone", params)
                    }
                } catch (e: Exception) {
                    Log.e("WakeWord", "Failed to write WAV", e)
                    handler.post { emitDebug("error", "WAV write failed: ${e.message}") }
                }
            }.also { it.isDaemon = true; it.start() }

            promise.resolve(outputPath)
        } catch (e: Exception) {
            isRawRecording = false
            promise.reject("START_ERROR", e.message)
        }
    }

    @ReactMethod fun stopSampleRecord(promise: Promise) {
        isRawRecording = false
        try { rawAudioRecord?.stop() } catch (_: Exception) {}
        try { rawAudioRecord?.release() } catch (_: Exception) {}
        rawAudioRecord = null
        try { rawRecordThread?.join(2000) } catch (_: Exception) {}
        rawRecordThread = null
        promise.resolve(rawOutputPath ?: "")
    }

    /** Write a standard 16-bit mono PCM WAV file */
    private fun writeWav(file: File, pcm: ByteArray, sampleRate: Int) {
        val numChannels = 1
        val bitsPerSample = 16
        val byteRate = sampleRate * numChannels * bitsPerSample / 8
        val blockAlign = numChannels * bitsPerSample / 8
        val dataSize = pcm.size
        val headerSize = 44
        val totalSize = headerSize + dataSize - 8

        file.outputStream().use { out ->
            fun writeInt16(v: Int) { out.write(v and 0xFF); out.write(v shr 8 and 0xFF) }
            fun writeInt32(v: Int) { out.write(v and 0xFF); out.write(v shr 8 and 0xFF); out.write(v shr 16 and 0xFF); out.write(v shr 24 and 0xFF) }
            out.write("RIFF".toByteArray())
            writeInt32(totalSize)
            out.write("WAVE".toByteArray())
            out.write("fmt ".toByteArray())
            writeInt32(16)         // PCM chunk size
            writeInt16(1)          // PCM format
            writeInt16(numChannels)
            writeInt32(sampleRate)
            writeInt32(byteRate)
            writeInt16(blockAlign)
            writeInt16(bitsPerSample)
            out.write("data".toByteArray())
            writeInt32(dataSize)
            out.write(pcm)
        }
    }

    // ── Sample Matching Listener (looping chunks for JS-side DTW) ────────────

    private var sampleListenRecord: AudioRecord? = null
    private var sampleListenThread: Thread? = null
    @Volatile private var isSampleListening = false

    /**
     * Continuously record ~2s PCM16 chunks and emit them to JS as base64 WAV.
     * JS side extracts features + runs DTW, fires wakeWordDetected if matched.
     */
    @ReactMethod fun startSampleListening(promise: Promise) {
        if (isSampleListening) { promise.resolve(null); return }
        try {
            isSampleListening = true
            val sampleRate = 16000
            val chunkSamples = sampleRate * 2  // 2 second chunks
            val bufferSize = AudioRecord.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(4096)

            val rec = AudioRecord(
                android.media.MediaRecorder.AudioSource.MIC,
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                isSampleListening = false
                promise.reject("INIT_ERROR", "AudioRecord failed to initialize")
                return
            }
            sampleListenRecord = rec
            rec.startRecording()

            sampleListenThread = Thread {
                val readBuf = ShortArray(bufferSize / 2)
                val chunkBuf = java.io.ByteArrayOutputStream(chunkSamples * 2)
                var samplesCollected = 0

                while (isSampleListening) {
                    val read = rec.read(readBuf, 0, readBuf.size)
                    if (read <= 0) continue

                    // Append to chunk buffer
                    for (i in 0 until read) {
                        chunkBuf.write(readBuf[i].toInt() and 0xFF)
                        chunkBuf.write(readBuf[i].toInt() shr 8 and 0xFF)
                    }
                    samplesCollected += read

                    // Emit chunk every ~2s
                    if (samplesCollected >= chunkSamples) {
                        val pcm = chunkBuf.toByteArray()
                        chunkBuf.reset()
                        samplesCollected = 0

                        // Build WAV in memory and base64-encode
                        val wavBytes = buildWavBytes(pcm, sampleRate)
                        val b64 = android.util.Base64.encodeToString(wavBytes, android.util.Base64.NO_WRAP)

                        handler.post {
                            val params = Arguments.createMap()
                            params.putString("wav", b64)
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("sampleAudioChunk", params)
                        }
                    }
                }
            }.also { it.isDaemon = true; it.start() }

            promise.resolve(null)
        } catch (e: Exception) {
            isSampleListening = false
            promise.reject("START_ERROR", e.message)
        }
    }

    @ReactMethod fun stopSampleListening(promise: Promise) {
        isSampleListening = false
        try { sampleListenRecord?.stop() } catch (_: Exception) {}
        try { sampleListenRecord?.release() } catch (_: Exception) {}
        sampleListenRecord = null
        try { sampleListenThread?.join(2000) } catch (_: Exception) {}
        sampleListenThread = null
        promise.resolve(null)
    }

    /** Build WAV bytes in memory (no file I/O) */
    private fun buildWavBytes(pcm: ByteArray, sampleRate: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream(44 + pcm.size)
        fun w16(v: Int) { out.write(v and 0xFF); out.write(v shr 8 and 0xFF) }
        fun w32(v: Int) { out.write(v and 0xFF); out.write(v shr 8 and 0xFF); out.write(v shr 16 and 0xFF); out.write(v shr 24 and 0xFF) }
        out.write("RIFF".toByteArray()); w32(36 + pcm.size)
        out.write("WAVE".toByteArray()); out.write("fmt ".toByteArray())
        w32(16); w16(1); w16(1); w32(sampleRate); w32(sampleRate * 2); w16(2); w16(16)
        out.write("data".toByteArray()); w32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }

    // ── openWakeWord Listener (v3.1.95) ───────────────────────────────────
    // Replaces the DTW sample-matcher that was triggering on any
    // consonant-vowel speech pattern. Uses the openWakeWord
    // TFLite pipeline (melspectrogram → embedding → wake-word
    // classifier) for proper ML-based detection.
    //
    // Models are bundled in assets/openwakeword/ as .tflite
    // files. Pre-trained: hey_jarvis, hey_mycroft, alexa,
    // hey_rhasspy. Default: hey_jarvis. Custom training is a
    // separate desktop-side pipeline (see CHANGES_3.1.95).
    private var owwDetector: OpenWakeWordDetector? = null
    private var owwRecord: AudioRecord? = null
    private var owwThread: Thread? = null
    @Volatile private var isOwwListening = false
    private var owwWakeword = "hey_jarvis"
    // v3.10.8: latest scores captured from the OWW
    // listening thread. Updated on every 80ms chunk.
    // Exposed via getLatestScores() so the JS-side
    // test button on the Wake settings page can poll
    // and report the peak wake / exit / send score
    // observed during a test window. @Volatile
    // because the writer is the OWW thread and the
    // reader is the JS thread (or a test harness
    // thread); without it the JS side could read a
    // stale value indefinitely.
    @Volatile private var latestWakeScore: Float? = null
    @Volatile private var latestExitScore: Float? = null
    @Volatile private var latestSendScore: Float? = null

    // v3.10.21: passive speaker enrollment threshold.
    // Set to the same value as the existing speech
    // band (SPEECH_RMS_THRESHOLD = 0.010) so we enroll
    // on every chunk where the user's voice is active.
    // The ZCR threshold (0.02) matches the WakeModeScreen
    // owwVad handler's speech classification — these
    // are independent classifiers with the same intent.
    private val PASSIVE_ENROLLMENT_RMS_THRESHOLD = 0.010f
    private val PASSIVE_ENROLLMENT_ZCR_THRESHOLD = 0.02f
    // Per-chunk flag computed by the OWW thread. Read
    // immediately after predictScore returns — if true,
    // push the latest embedding into the enrollment
    // buffer. Single-threaded access (OWW thread is
    // the only writer/reader).
    private var pendingEnrollmentSample = false

    @ReactMethod fun initOww(wakeword: String, threshold: Double = 0.5, promise: Promise) {
        // v3.10.40: retry initOww once on transient failure.
        // Tobe's v3.10.38 report: "initOww failed: Failed to
        // load TFLite models" at cold start, after which
        // startOwwListening rejected with "Call initOww
        // first" because owwDetector stayed null. The wake
        // listener was permanently dead for that session —
        // no auto-recovery. The failure is often transient:
        //   - TFLite Interpreter constructor occasionally
        //     throws on cold start while Android's HAL
        //     service is warming up.
        //   - AssetManager.openFd can hit a race during
        //     Activity onCreate.
        //   - Custom-trained wake models that haven't been
        //     copied from a previous session can fail the
        //     fallback path during the very first init.
        // Strategy: try once at the caller's request. If
        // it throws, sleep 500ms and try once more. If the
        // retry also throws, surface the rejection to the
        // caller. Two bounded attempts keep cold-start
        // latency under 1s worst-case.
        var attempt = 0
        fun attemptInit() {
            attempt++
            try {
                owwWakeword = wakeword
                owwDetector?.close()
                owwDetector = OpenWakeWordDetector(reactContext).apply {
                    val ok = loadModels(wakeword)
                    setThreshold(threshold.toFloat())
                    if (!ok) throw Exception("Failed to load TFLite models (attempt $attempt)")
                }
                emitDebug("info", "OWW initialized (attempt $attempt): $wakeword @ $threshold")
                promise.resolve(true)
            } catch (e: Exception) {
                if (attempt < 2) {
                    emitDebug("warn", "initOww attempt $attempt failed: ${e.message}; retrying in 500ms")
                    handler.postDelayed({
                        try { attemptInit() } catch (_: Exception) {}
                    }, 500L)
                } else {
                    promise.reject("OWW_INIT", e.message)
                }
            }
        }
        attemptInit()
    }

    // v3.2.0: receive a freshly-trained .tflite (base64) and
    // hot-swap it into the running OpenWakeWordDetector's
    // wake-word classifier slot. Persists the file to
    // filesDir/wake_models/<agentId>.tflite so it survives
    // app restarts (loadOwwSavedModel below re-applies it on
    // boot).
    //
    // Why hot-swap rather than re-init: the OWW listening
    // thread is already running with the AudioRecord open.
    // A full re-init would require stopping + restarting the
    // thread, which causes a brief window where wake events
    // are missed. setWakewordModelFromFile is a one-interpreter
    // atomic swap that keeps the melspec + embedding models
    // alive across the change.
    @ReactMethod fun setWakeModelFromBase64(agentId: String, base64: String, phrase: String, promise: Promise) {
        try {
            if (agentId.isBlank() || base64.isBlank()) {
                promise.reject("ARG", "agentId and base64 required")
                return
            }
            // v3.9.0: route through the new registry. Each
            // fresh training creates a NEW set (instead of
            // overwriting the legacy single-file model). The
            // setId defaults to `<phrase>-<timestamp>` so the
            // user can identify it in the manager; renaming
            // afterwards is supported.
            //
            // v3.9.8 — auto-cleanup of stale wake sets for
            // the same (agentId, phrase) pair. Before v3.9.8,
            // every training appended a new set without
            // touching the old ones, so retraining the same
            // phrase 3 times left 3 stale sets in the manager
            // (all identical-looking, all 204.0 KB, all
            // timestamped the same minute). Tobe hit this and
            // asked "which is the correct version? Why are
            // there more than one?". Cleanup happens BEFORE
            // we write the new set, and skips:
            //   - Sets for different (agentId, phrase)
            //   - The set we're about to create (by name
            //     match on `setId`)
            //   - Any set that's currently bound as active
            //     for a DIFFERENT agent (defensive — shouldn't
            //     happen but doesn't cost us anything)
            // The active binding for THIS agent is moved to
            // the new set below, so the old active set (if
            // any) is safe to delete.
            migrateWakeSetsSync()
            val root = File(reactContext.filesDir, "wake_models")
            if (root.isDirectory) {
                val existing = root.listFiles() ?: emptyArray()
                for (child in existing) {
                    if (!child.isDirectory) continue
                    val meta = readMeta(child) ?: continue
                    // Same agent + same phrase = stale candidate.
                    if (meta.agentId == agentId && meta.phrase.equals(phrase, ignoreCase = true)) {
                        // Defensive: never delete a set that's
                        // active for a *different* agent.
                        // Shouldn't be possible (sets are scoped
                        // to one agent) but free check.
                        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
                        val activeForOther = prefs.all.keys.any {
                            it.startsWith("active_") && it != "active_$agentId" && prefs.getString(it, null) == meta.setId
                        }
                        if (activeForOther) continue
                        try {
                            child.listFiles()?.forEach { it.delete() }
                            child.delete()
                            emitDebug("info", "Cleaned up stale wake set: ${meta.setId} (phrase=${meta.phrase})")
                        } catch (e: Exception) {
                            emitDebug("warn", "Failed to clean up stale wake set ${meta.setId}: ${e.message}")
                        }
                    }
                }
            }
            val now = System.currentTimeMillis()
            val safePhrase = phrase.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "wake" }
            val baseSetId = "$safePhrase-$now"
            val setId = uniqueWakeSetId(baseSetId)
            val setDir = File(reactContext.filesDir, "wake_models/$setId")
            setDir.mkdirs()
            val tflite = File(setDir, "model.tflite")
            tflite.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            writeMeta(setDir, WakeSetMeta(
                setId = setId,
                phrase = phrase,
                scope = "agent:$agentId",
                agentId = agentId,
                createdAt = now,
                // v3.10.1: the human-friendly display name
                // defaults to whatever the user typed in
                // the trainer. The user can rename later
                // (manager's Rename button) and the rename
                // path (renameWakeSet) only touches setId
                // for the folder, not displayName, so the
                // typed phrase is preserved as the
                // canonical name across renames.
                displayName = phrase,
            ))
            emitDebug("info", "Wrote wake set: ${setDir.absolutePath} (${tflite.length()} bytes)")

            // Set the active binding to the new set.
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            prefs.edit().putString("active_$agentId", setId).apply()

            // Hot-swap into the running detector (if any).
            val detector = owwDetector
            if (detector != null) {
                val ok = detector.setWakewordModelFromFile(tflite.absolutePath)
                if (ok) {
                    owwWakeword = phrase
                    emitDebug("info", "Hot-swapped wake model for $agentId: $phrase (set $setId)")
                } else {
                    emitDebug("warn", "Hot-swap failed; will retry on next initOww")
                }
            }
            promise.resolve(setDir.absolutePath)
        } catch (e: Exception) {
            promise.reject("WAKE_MODEL_SAVE", e.message)
        }
    }

    /** Resolve a unique setId by appending `-<n>` if needed. */
    private fun uniqueWakeSetId(base: String): String {
        val root = File(reactContext.filesDir, "wake_models")
        var candidate = base
        var n = 1
        while (File(root, candidate).exists()) {
            candidate = "$base-$n"
            n++
        }
        return candidate
    }

    // v3.5.0: hot-swap the exit-phrase model. Parallel to
    // setWakeModelFromBase64 but for the exit classifier.
    // Persists to filesDir/exit_models/<phrase>.tflite and a
    // SharedPreferences binding (exit_phrase_<phrase>_path).
    //
    // The exit model is identified by phrase (not agentId) because
    // exit phrases are user-level (one active phrase), not
    // per-companion. We persist by phrase so a re-train replaces
    // the same file.
    @ReactMethod fun setExitModelFromBase64(phrase: String, base64: String, promise: Promise) {
        try {
            if (phrase.isBlank() || base64.isBlank()) {
                promise.reject("ARG", "phrase and base64 required")
                return
            }
            val dir = File(reactContext.filesDir, "exit_models")
            if (!dir.exists()) dir.mkdirs()
            val safeName = phrase.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
            val tflite = File(dir, "${safeName}.tflite")
            tflite.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            emitDebug("info", "Wrote exit model: ${tflite.absolutePath} (${tflite.length()} bytes)")

            // Persist the binding so we can re-apply on app restart.
            val prefs = reactContext.getSharedPreferences("exit_models", android.content.Context.MODE_PRIVATE)
            prefs.edit()
                .putString("active_phrase", phrase)
                .putString("active_path", tflite.absolutePath)
                .putLong("active_savedAt", System.currentTimeMillis())
                .apply()

            // Hot-swap into the running detector (if any).
            val detector = owwDetector
            if (detector != null) {
                val ok = detector.setExitModelFromFile(phrase, tflite.absolutePath)
                if (ok) {
                    emitDebug("info", "Hot-swapped exit model: '$phrase'")
                } else {
                    emitDebug("warn", "Exit hot-swap failed; will retry on next initOww")
                }
            }
            promise.resolve(tflite.absolutePath)
        } catch (e: Exception) {
            promise.reject("EXIT_MODEL_SAVE", e.message)
        }
    }

    // v3.5.0: set the exit-phrase detection threshold. Default
    // 0.5 to match the wake default. The JS layer reads it from
    // AsyncStorage ('cyberclaw-exit-threshold') and passes it
    // through here (similar to the wake threshold).
    @ReactMethod fun setExitThreshold(threshold: Double, promise: Promise) {
        try {
            owwDetector?.setExitThreshold(threshold.toFloat())
            emitDebug("info", "Exit threshold set: $threshold")
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("EXIT_THRESHOLD", e.message)
        }
    }

    // v3.5.0: load a saved exit-phrase model on app boot, if
    // one exists. Parallel to loadOwwSavedModel. Reads the
    // 'exit_models' SharedPreferences for the most recent
    // active phrase. Returns the phrase string or null.
    @ReactMethod fun loadOwwSavedExitModel(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("exit_models", android.content.Context.MODE_PRIVATE)
            val path = prefs.getString("active_path", null)
            val phrase = prefs.getString("active_phrase", null)
            if (path == null || phrase == null) {
                promise.resolve(null)
                return
            }
            if (!File(path).exists()) {
                prefs.edit().remove("active_phrase").remove("active_path").remove("active_savedAt").apply()
                promise.resolve(null)
                return
            }
            val detector = owwDetector
            if (detector == null) {
                // Detector not yet initialized — return the
                // phrase so the JS side can defer the load
                // until after initOww.
                promise.resolve(phrase)
                return
            }
            val ok = detector.setExitModelFromFile(phrase, path)
            promise.resolve(if (ok) phrase else null)
        } catch (e: Exception) {
            Log.w("WakeWord", "Failed to load saved exit model: ${e.message}")
            promise.resolve(null)
        }
    }

    // v3.6.0: hot-swap the send-word model. Parallel to
    // setExitModelFromBase64 but for the send classifier.
    // Persists to filesDir/send_models/<phrase>.tflite and a
    // SharedPreferences binding (send_word_<phrase>_path).
    //
    // The send model is identified by phrase (not agentId)
    // because send words are user-level (one active word per
    // device), not per-companion. We persist by phrase so a
    // re-train replaces the same file.
    //
    // Send word differs from exit phrase in two ways:
    //  - exit closes voice mode, send just commits the
    //    current utterance
    //  - exit is per-companion, send is global
    @ReactMethod fun setSendModelFromBase64(phrase: String, base64: String, promise: Promise) {
        try {
            if (phrase.isBlank() || base64.isBlank()) {
                promise.reject("ARG", "phrase and base64 required")
                return
            }
            val dir = File(reactContext.filesDir, "send_models")
            if (!dir.exists()) dir.mkdirs()
            val safeName = phrase.lowercase().replace(Regex("[^a-z0-9]+"), "_").trim('_')
            val tflite = File(dir, "${safeName}.tflite")
            tflite.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            emitDebug("info", "Wrote send model: ${tflite.absolutePath} (${tflite.length()} bytes)")

            // Persist the binding so we can re-apply on app restart.
            val prefs = reactContext.getSharedPreferences("send_models", android.content.Context.MODE_PRIVATE)
            prefs.edit()
                .putString("active_phrase", phrase)
                .putString("active_path", tflite.absolutePath)
                .putLong("active_savedAt", System.currentTimeMillis())
                .apply()

            // Hot-swap into the running detector (if any).
            val detector = owwDetector
            if (detector != null) {
                val ok = detector.setSendModelFromFile(phrase, tflite.absolutePath)
                if (ok) {
                    emitDebug("info", "Hot-swapped send model: '$phrase'")
                } else {
                    emitDebug("warn", "Send hot-swap failed; will retry on next initOww")
                }
            }
            promise.resolve(tflite.absolutePath)
        } catch (e: Exception) {
            promise.reject("SEND_MODEL_SAVE", e.message)
        }
    }

    // v3.6.0: set the send-word detection threshold. Default
    // 0.5 to match wake and exit. The JS layer reads it from
    // AsyncStorage ('cyberclaw-send-threshold') and passes it
    // through here.
    @ReactMethod fun setSendThreshold(threshold: Double, promise: Promise) {
        try {
            owwDetector?.setSendThreshold(threshold.toFloat())
            emitDebug("info", "Send threshold set: $threshold")
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("SEND_THRESHOLD", e.message)
        }
    }

    // v3.6.0: load a saved send-word model on app boot, if one
    // exists. Parallel to loadOwwSavedExitModel. Reads the
    // 'send_models' SharedPreferences for the most recent
    // active phrase. Returns the phrase string or null.
    @ReactMethod fun loadOwwSavedSendModel(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("send_models", android.content.Context.MODE_PRIVATE)
            val path = prefs.getString("active_path", null)
            val phrase = prefs.getString("active_phrase", null)
            if (path == null || phrase == null) {
                promise.resolve(null)
                return
            }
            if (!File(path).exists()) {
                prefs.edit().remove("active_phrase").remove("active_path").remove("active_savedAt").apply()
                promise.resolve(null)
                return
            }
            val detector = owwDetector
            if (detector == null) {
                // Detector not yet initialized — return the
                // phrase so the JS side can defer the load
                // until after initOww.
                promise.resolve(phrase)
                return
            }
            val ok = detector.setSendModelFromFile(phrase, path)
            promise.resolve(if (ok) phrase else null)
        } catch (e: Exception) {
            Log.w("WakeWord", "Failed to load saved send model: ${e.message}")
            promise.resolve(null)
        }
    }

    // v3.2.0: look up the saved wake model for an agent (if any)
    // and apply it. Called from initOww so a freshly-trained
    // custom wake word auto-loads on every app launch.
    //
    // Returns the phrase that was trained, or null if no model
    // is saved for this agent. The caller can use this to fall
    // back to a pre-trained model if the agent hasn't been
    // trained yet.
    fun loadOwwSavedModel(agentId: String): String? {
        if (agentId.isBlank()) return null
        // v3.9.0: route through the new registry.
        migrateWakeSetsSync()
        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
        val activeSetId = prefs.getString("active_$agentId", null) ?: return null
        val meta = readMetaForWakeSet(activeSetId) ?: return null
        val modelFile = File(File(reactContext.filesDir, "wake_models/$activeSetId"), "model.tflite")
        if (!modelFile.exists()) {
            // Stale binding; clear it.
            prefs.edit().remove("active_$agentId").apply()
            return null
        }
        val detector = owwDetector ?: return meta.phrase  // defer load until initOww
        val ok = detector.setWakewordModelFromFile(modelFile.absolutePath)
        if (ok) {
            owwWakeword = meta.phrase
            emitDebug("info", "Loaded saved wake model for $agentId (set $activeSetId): ${meta.phrase}")
            return meta.phrase
        }
        return null
    }

    // v3.2.0: list the agents that have a saved custom wake model.
    // Used by the UI to show "✓ trained" badges in the wake
    // menu without having to round-trip to the desktop.
    @ReactMethod fun getSavedWakeModels(promise: Promise) {
        try {
            // v3.9.0: route through the new registry. For
            // backward compat, the returned shape stays
            // { agentId: { agentId, phrase, path, savedAt, setId, active } }
            // so the existing badge UI keeps working.
            //
            // v3.9.9 — only return the ACTIVE set per
            // agent. Previously all sets were iterated and
            // `result.putMap(agentId, entry)` overwrote
            // earlier entries — so with 4 stale sets for
            // "clawsuu" (a pre-v3.9.8 condition), the JS
            // side got the LAST set in filesystem iteration
            // order, which may or may not be the active
            // one. The badge UI then showed either the
            // wrong phrase or "No trained wake phrases yet"
            // depending on which set won the race.
            // Filtering to active-only is correct: the JS
            // side only ever cares which wake model is
            // currently hot-swapped into the detector.
            // The full list (for the manager) goes through
            // listWakeSets() which keeps showing all sets.
            migrateWakeSetsSync()
            dedupeWakeSetsSync()
            val result = com.facebook.react.bridge.Arguments.createMap()
            val root = File(reactContext.filesDir, "wake_models")
            if (root.isDirectory) {
                for (setDir in root.listFiles() ?: emptyArray()) {
                    if (!setDir.isDirectory) continue
                    val meta = readMeta(File(setDir, "meta.json")) ?: continue
                    val agentId = meta.agentId ?: continue
                    // Skip non-active sets — the badge UI
                    // only wants the currently-bound model.
                    if (!isActiveWakeSet(meta)) continue
                    val modelFile = File(setDir, "model.tflite")
                    if (!modelFile.exists()) continue
                    val entry = com.facebook.react.bridge.Arguments.createMap()
                    entry.putString("agentId", agentId)
                    entry.putString("phrase", meta.phrase)
                    entry.putString("path", modelFile.absolutePath)
                    entry.putDouble("savedAt", meta.createdAt.toDouble())
                    entry.putString("setId", meta.setId)
                    // v3.10.1: include displayName for the
                    // JS-side badge UI. Falls back to phrase
                    // on the JS side when null (old meta
                    // files pre-v3.10.1 don't have the
                    // field).
                    entry.putString("displayName", meta.displayName ?: meta.phrase)
                    entry.putBoolean("active", true)
                    result.putMap(agentId, entry)
                }
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("WAKE_MODEL_LIST", e.message)
        }
    }

    // v3.2.0: delete the saved wake model for an agent. Falls
    // back to the previously-active model on next initOww.
    @ReactMethod fun deleteSavedWakeModel(agentId: String, promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            val path = prefs.getString("${agentId}_path", null)
            if (path != null) {
                File(path).delete()
            }
            prefs.edit()
                .remove("${agentId}_path")
                .remove("${agentId}_phrase")
                .remove("${agentId}_savedAt")
                .apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WAKE_MODEL_DELETE", e.message)
        }
    }

    // =====================================================================
    // v3.9.0: Trainer Manager — wake-word set registry
    // =====================================================================
    //
    // Prior to v3.9.0, the wake-word storage was a single file
    // per agent: filesDir/wake_models/<agentId>.tflite with
    // SharedPreferences keys `<agentId>_path` / `<agentId>_phrase`
    // / `<agentId>_savedAt`. Re-training the same agent
    // overwrote the file in place, so there was no way to
    // keep multiple wake-word sets side-by-side (no list,
    // no activate-old-set, no rename, no export).
    //
    // v3.9.0 introduces a registry:
    //   filesDir/wake_models/<setId>/
    //     model.tflite
    //     meta.json   { setId, phrase, scope: "agent:<id>",
    //                   createdAt, sizeBytes }
    // The SharedPreferences active binding moves to
    //   active_wake_<agentId> -> setId
    // so the user can have multiple wake-word sets per agent
    // and switch which one is hot.
    //
    // On first read, the old `<agentId>_path` /
    // `<agentId>_phrase` / `<agentId>_savedAt` keys are
    // migrated to the new shape in-place: the file moves
    // from filesDir/wake_models/<agentId>.tflite to
    // filesDir/wake_models/<setId>/model.tflite and a
    // meta.json is written next to it. The setId for the
    // migrated set is `<agentId>__legacy` (deterministic,
    // easy to rename later via the JS UI).
    //
    // The OLD APIs (`setWakeModelFromBase64`, `getSavedWakeModels`,
    // `loadOwwSavedModel`, `deleteSavedWakeModel`) continue to
    // work and now route through the new registry internally.
    // The OLD JS callers don't need to change. The NEW APIs
    // below are what the trainer manager UI uses.

    /**
     * Ensure the v3.8 -> v3.9 storage migration has run for
     * the wake category. Idempotent: if the new registry is
     * already populated, this is a no-op. Returns the count
     * of legacy sets migrated (0 if none).
     */
    @ReactMethod fun migrateWakeSets(promise: Promise) {
        try {
            val count = migrateWakeSetsSync()
            promise.resolve(count)
        } catch (e: Exception) {
            promise.reject("MIGRATE", e.message)
        }
    }

    /**
     * List every wake-word set on disk.
     * Returns a WritableMap { "<setId>" -> { setId, phrase, scope, agentId, createdAt, sizeBytes, active } }
     * `active` is true iff this setId matches the active binding
     * for the set's scope.
     */
    @ReactMethod fun listWakeSets(promise: Promise) {
        try {
            migrateWakeSetsSync()
            // v3.9.9: dedupe before listing. After this
            // runs, the manager shows one set per
            // (agent, phrase). Idempotent — a no-op if
            // everything is already unique.
            dedupeWakeSetsSync()
            val result = Arguments.createMap()
            val root = File(reactContext.filesDir, "wake_models")
            if (root.isDirectory) {
                val children = root.listFiles() ?: emptyArray()
                for (child in children) {
                    if (!child.isDirectory) continue
                    val setId = child.name
                    val metaFile = File(child, "meta.json")
                    val modelFile = File(child, "model.tflite")
                    if (!metaFile.exists() || !modelFile.exists()) continue
                    val entry = readMeta(metaFile) ?: continue
                    val active = isActiveWakeSet(entry)
                    val map = Arguments.createMap()
                    map.putString("setId", entry.setId)
                    map.putString("phrase", entry.phrase)
                    // v3.10.1: include displayName for
                    // the manager card title. Falls
                    // back to phrase when the field is
                    // absent (legacy meta).
                    map.putString("displayName", entry.displayName ?: entry.phrase)
                    map.putString("scope", entry.scope)
                    if (entry.agentId != null) map.putString("agentId", entry.agentId)
                    map.putDouble("createdAt", entry.createdAt.toDouble())
                    map.putDouble("sizeBytes", modelFile.length().toDouble())
                    map.putBoolean("active", active)
                    result.putMap(setId, map)
                }
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("LIST_WAKE_SETS", e.message)
        }
    }

    /**
     * Get the active setId for an agent (or null if none).
     * The string `__global` is also accepted for categories
     * that are user-scoped, but wake is always per-agent so
     * this is mainly used by the exit / send categories.
     */
    @ReactMethod fun getActiveWakeSet(agentId: String, promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            promise.resolve(prefs.getString("active_$agentId", null))
        } catch (e: Exception) {
            promise.reject("GET_ACTIVE", e.message)
        }
    }

    /**
     * Set the active setId for an agent and hot-swap it
     * into the running detector (if any). Persists the
     * binding so the same set loads on app restart.
     */
    @ReactMethod fun setActiveWakeSet(agentId: String, setId: String, promise: Promise) {
        try {
            migrateWakeSetsSync()
            val meta = readMetaForWakeSet(setId)
                ?: return promise.reject("ARG", "set not found: $setId")
            if (meta.agentId != agentId) {
                return promise.reject("ARG", "set $setId is not scoped to agent $agentId")
            }
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            prefs.edit().putString("active_$agentId", setId).apply()
            // Hot-swap into the running detector (if any).
            val modelFile = File(File(reactContext.filesDir, "wake_models/$setId"), "model.tflite")
            val detector = owwDetector
            if (detector != null && modelFile.exists()) {
                val ok = detector.setWakewordModelFromFile(modelFile.absolutePath)
                if (ok) {
                    owwWakeword = meta.phrase
                    emitDebug("info", "Activated wake set $setId for $agentId: ${meta.phrase}")
                } else {
                    emitDebug("warn", "Wake set activation: hot-swap failed for $setId")
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SET_ACTIVE", e.message)
        }
    }

    /**
     * Rename a set. Moves the directory on disk, updates
     * meta.json's `setId`, and rewrites the active binding
     * if this set was active. The OLD setId must exist; the
     * NEW setId must not already exist.
     */
    @ReactMethod fun renameWakeSet(oldSetId: String, newSetId: String, promise: Promise) {
        try {
            if (newSetId.isBlank() || newSetId.contains('/') || newSetId.contains("..")) {
                return promise.reject("ARG", "invalid setId: $newSetId")
            }
            migrateWakeSetsSync()
            val oldDir = File(reactContext.filesDir, "wake_models/$oldSetId")
            val newDir = File(reactContext.filesDir, "wake_models/$newSetId")
            if (!oldDir.isDirectory) return promise.reject("ARG", "set not found: $oldSetId")
            if (newDir.exists()) return promise.reject("ARG", "set already exists: $newSetId")
            val meta = readMetaForWakeSet(oldSetId)
                ?: return promise.reject("ARG", "meta missing for $oldSetId")
            if (!oldDir.renameTo(newDir)) {
                return promise.reject("IO", "rename failed")
            }
            // Rewrite meta.json with the new setId.
            writeMeta(newDir, meta.copy(setId = newSetId))
            // Update active binding if it pointed at the old setId.
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            if (meta.agentId != null) {
                val activeKey = "active_${meta.agentId}"
                if (prefs.getString(activeKey, null) == oldSetId) {
                    prefs.edit().putString(activeKey, newSetId).apply()
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("RENAME", e.message)
        }
    }

    /**
     * Delete a set. Removes the directory and clears any
     * active binding that pointed at this setId.
     */
    @ReactMethod fun deleteWakeSet(setId: String, promise: Promise) {
        try {
            migrateWakeSetsSync()
            val dir = File(reactContext.filesDir, "wake_models/$setId")
            val meta = readMetaForWakeSet(setId)
            if (dir.exists()) {
                dir.listFiles()?.forEach { it.delete() }
                dir.delete()
            }
            if (meta?.agentId != null) {
                val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
                if (prefs.getString("active_${meta.agentId}", null) == setId) {
                    prefs.edit().remove("active_${meta.agentId}").apply()
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("DELETE_SET", e.message)
        }
    }

    /**
     * Read a set's .tflite bytes as base64, for export.
     * Returns a WritableMap { base64, sizeBytes, path }.
     */
    @ReactMethod fun readWakeSet(setId: String, promise: Promise) {
        try {
            migrateWakeSetsSync()
            val modelFile = File(File(reactContext.filesDir, "wake_models/$setId"), "model.tflite")
            if (!modelFile.exists()) return promise.reject("ARG", "set not found: $setId")
            val bytes = modelFile.readBytes()
            val map = Arguments.createMap()
            map.putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            map.putDouble("sizeBytes", bytes.size.toDouble())
            map.putString("path", modelFile.absolutePath)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("READ_SET", e.message)
        }
    }

    // ----- internal: meta.json read/write + migration -----

    data class WakeSetMeta(
        val setId: String,
        val phrase: String,
        val scope: String,        // "agent:<id>" (always, for wake)
        val agentId: String?,
        val createdAt: Long,
        // v3.10.1: human-friendly display name. Defaults
        // to the typed phrase (e.g. "Hey Clawsuu") so the
        // manager card top-line reads naturally instead of
        // the filesystem slug `hey-clawsuu-1784025212000`.
        // Tobe renamed sets via the manager's Rename button
        // just to make the display look right; this field
        // captures that intent at creation time so no
        // manual rename is needed.
        val displayName: String? = null,
    )

    private fun readMeta(file: File): WakeSetMeta? {
        return try {
            val raw = file.readText()
            val obj = org.json.JSONObject(raw)
            WakeSetMeta(
                setId = obj.optString("setId"),
                phrase = obj.optString("phrase"),
                scope = obj.optString("scope"),
                agentId = obj.optString("agentId").takeIf { it.isNotEmpty() },
                createdAt = obj.optLong("createdAt"),
                // Old meta.json files (pre-v3.10.1) have
                // no displayName key. readMeta treats
                // missing as null, and the manager UI
                // falls back to phrase. Backward
                // compatible — no migration required.
                displayName = obj.optString("displayName").takeIf { it.isNotEmpty() },
            )
        } catch (_: Exception) { null }
    }

    private fun readMetaForWakeSet(setId: String): WakeSetMeta? {
        val f = File(File(reactContext.filesDir, "wake_models/$setId"), "meta.json")
        if (!f.exists()) return null
        return readMeta(f)
    }

    private fun writeMeta(setDir: File, meta: WakeSetMeta) {
        val obj = org.json.JSONObject()
        obj.put("setId", meta.setId)
        obj.put("phrase", meta.phrase)
        obj.put("scope", meta.scope)
        if (meta.agentId != null) obj.put("agentId", meta.agentId)
        obj.put("createdAt", meta.createdAt)
        // v3.10.1: persist the human-friendly display
        // name. Omit when null so the on-disk meta
        // stays small (the field is optional in the
        // data class and readMeta handles missing).
        if (meta.displayName != null) obj.put("displayName", meta.displayName)
        File(setDir, "meta.json").writeText(obj.toString())
    }

    /**
     * Idempotent migration from v3.8 -> v3.9 storage.
     * For each agentId with a `<agentId>_path` SharedPreferences
     * entry whose file still exists at the v3.8 path:
     *   - mkdir filesDir/wake_models/<setId>/   (setId = `<agentId>__legacy`)
     *   - move the .tflite into the new dir as model.tflite
     *   - write meta.json
     *   - set the active binding to the new setId
     *   - remove the legacy SharedPreferences keys
     * Returns the count migrated.
     */
    private fun migrateWakeSetsSync(): Int {
        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
        val root = File(reactContext.filesDir, "wake_models")
        if (!root.exists()) root.mkdirs()
        var migrated = 0
        val legacyAgents = mutableListOf<String>()
        for ((key, _) in prefs.all) {
            if (key.endsWith("_path")) {
                val agentId = key.removeSuffix("_path")
                val legacyPath = prefs.getString(key, null) ?: continue
                val legacyFile = File(legacyPath)
                if (!legacyFile.exists()) {
                    // Stale binding; clean up but don't migrate.
                    prefs.edit()
                        .remove("${agentId}_path")
                        .remove("${agentId}_phrase")
                        .remove("${agentId}_savedAt")
                        .apply()
                    continue
                }
                val newSetId = "${agentId}__legacy"
                val newDir = File(root, newSetId)
                if (newDir.exists()) continue  // already migrated
                newDir.mkdirs()
                // Move file.
                val newModel = File(newDir, "model.tflite")
                if (!legacyFile.renameTo(newModel)) {
                    // renameTo across devices can fail; fall back to copy.
                    legacyFile.copyTo(newModel, overwrite = true)
                    legacyFile.delete()
                }
                // Write meta.
                val phrase = prefs.getString("${agentId}_phrase", "") ?: ""
                val savedAt = prefs.getLong("${agentId}_savedAt", System.currentTimeMillis())
                writeMeta(newDir, WakeSetMeta(
                    setId = newSetId,
                    phrase = phrase,
                    scope = "agent:$agentId",
                    agentId = agentId,
                    createdAt = savedAt,
                    // v3.10.1: also set the display
                    // name to the legacy phrase so
                    // migrated sets show the
                    // human-friendly name in the
                    // manager (same as fresh-trained
                    // sets).
                    displayName = phrase,
                ))
                // Set active binding.
                prefs.edit().putString("active_$agentId", newSetId).apply()
                legacyAgents.add(agentId)
                migrated++
            }
        }
        // Now remove the legacy keys for the migrated agents
        // (do this in a separate pass to keep the loop simple).
        if (legacyAgents.isNotEmpty()) {
            val editor = prefs.edit()
            for (agentId in legacyAgents) {
                editor.remove("${agentId}_path")
                editor.remove("${agentId}_phrase")
                editor.remove("${agentId}_savedAt")
            }
            editor.apply()
        }
        return migrated
    }

    /**
     * v3.9.9 — one-shot dedupe of stale wake sets for
     * the same (agentId, phrase) pair. The v3.9.8 fix
     * added cleanup-on-new-training but couldn't reach
     * sets that already existed on disk before the
     * upgrade. Tobe hit exactly this on v3.9.8: 4
     * timestamped-the-same-minute orphans from
     * previous trainings, all visible in the manager.
     *
     * Strategy: for each (agentId, phrase) group with
     * multiple sets, keep exactly one — prefer the one
     * that's currently bound as active_<agentId>; fall
     * back to the newest by createdAt. Delete the rest.
     *
     * Runs idempotently on every getSavedWakeModels /
     * listWakeSets / setWakeModelFromBase64 call. Cheap
     * (small N, single directory scan).
     */
    private fun dedupeWakeSetsSync(): Int {
        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
        val root = File(reactContext.filesDir, "wake_models")
        if (!root.isDirectory) return 0
        // Group sets by (agentId, phrase).
        // key = "<agentId>|<phrase-lowercase>" for case-insensitive
        // phrase match (matches the v3.9.8 same-key check).
        val groups = mutableMapOf<String, MutableList<WakeSetMeta>>()
        val metaByKey = mutableMapOf<String, File>()
        for (setDir in root.listFiles() ?: emptyArray()) {
            if (!setDir.isDirectory) continue
            val meta = readMeta(File(setDir, "meta.json")) ?: continue
            val agentId = meta.agentId ?: continue
            val phraseKey = "${agentId}|${meta.phrase.lowercase()}"
            groups.getOrPut(phraseKey) { mutableListOf() }.add(meta)
            metaByKey[meta.setId] = setDir
        }
        var deleted = 0
        for ((_, sets) in groups) {
            if (sets.size <= 1) continue
            // Pick the survivor: prefer the active one for
            // this agent, then newest by createdAt.
            val activeSetId = prefs.getString("active_${sets[0].agentId}", null)
            val survivor = sets.firstOrNull { it.setId == activeSetId }
                ?: sets.maxByOrNull { it.createdAt }
                ?: continue
            // Delete all others.
            for (meta in sets) {
                if (meta.setId == survivor.setId) continue
                val dir = metaByKey[meta.setId] ?: continue
                try {
                    dir.listFiles()?.forEach { it.delete() }
                    dir.delete()
                    deleted++
                    emitDebug("info", "Dedup: removed stale wake set ${meta.setId}")
                } catch (e: Exception) {
                    emitDebug("warn", "Dedup: failed to remove ${meta.setId}: ${e.message}")
                }
            }
        }
        return deleted
    }

    private fun isActiveWakeSet(meta: WakeSetMeta): Boolean {
        if (meta.agentId == null) return false
        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
        return prefs.getString("active_${meta.agentId}", null) == meta.setId
    }

    @ReactMethod fun startOwwListening(promise: Promise) {
        if (isOwwListening) { promise.resolve(null); return }
        // v3.10.40: removed `val detector = owwDetector` capture
        // at the top — after the lazy-init block below was
        // added, the captured value was stale (the lazy-init
        // could reassign owwDetector = fresh). The OWW thread
        // below re-reads owwDetector directly with a null-safe
        // early-out so we always use the freshly-assigned
        // detector whether the lazy-init ran or not.
        if (owwDetector == null) {
            // v3.10.40: self-heal — if initOww never ran or
            // failed earlier in this session, lazy-init now
            // with the bundled default ('hey_jarvis') before
            // giving up. Previously this rejected with
            // OWW_NOT_INIT and the wake listener stayed dead
            // for the whole session. Tobe hit this in
            // v3.10.38: the wake test page (and the home
            // screen's listener) called startOwwListening
            // after initOww had failed at app start, the
            // detector was null, and every subsequent test
            // said "Wake listener wasn't running".
            //
            // The lazy-init target phrase is resolved
            // below: we first scan SharedPreferences for
            // an active custom-trained wake set and use
            // that phrase (so the wake test exercises
            // the user's actual trained model, not the
            // bundled jarvis one). If no active set
            // exists, we fall back to the bundled
            // 'hey_jarvis' as a last resort.
            //
            // v3.10.55: Try to find an active custom-trained wake
            // set BEFORE falling back to the bundled
            // 'hey_jarvis' model. Without this, the wake
            // test button (which also calls startOwwListening)
            // would lazy-init with the bundled jarvis model
            // and score the user's custom phrase against the
            // wrong classifier — producing 0% on every test
            // even when the mic and detector are healthy.
            // Tobe hit this on 2026-07-19: "0% on 4 tries"
            // with avgRms 0.065 (mic working, model wrong).
            // Scan the wake_models SharedPreferences for any
            // active_<agentId> entry; if found, use that
            // agent's wake phrase as the lazy-init target so
            // the test exercises the user's actual trained
            // model.
            //
            // Tie-breaking: if multiple agents have active wake
            // sets, pick the first key alphabetically. This is
            // deterministic and good enough — the test isn't
            // multi-agent aware anyway, and at worst we test
            // a different agent's model (still better than
            // testing the bundled jarvis classifier against
            // a custom phrase). The "right" agentId should be
            // passed in via initOww before this fallback ever
            // runs, so the multi-agent case is rare.
            var lazyInitWakeword = "hey_jarvis"
            try {
                val prefs = reactContext.getSharedPreferences(
                    "wake_models", android.content.Context.MODE_PRIVATE
                )
                val activeKey = prefs.all.keys
                    .filter { it.startsWith("active_") }
                    .sorted()
                    .firstOrNull()
                if (activeKey != null) {
                    val setId = prefs.getString(activeKey, null)
                    if (setId != null) {
                        val meta = readMetaForWakeSet(setId)
                        if (meta?.phrase != null && meta.phrase.isNotBlank()) {
                            lazyInitWakeword = meta.phrase
                            emitDebug(
                                "info",
                                "Lazy-init using active wake set for $activeKey: '${meta.phrase}'"
                            )
                        }
                    }
                }
            } catch (_: Exception) {
                // best-effort: if SharedPreferences read fails,
                // fall through to bundled hey_jarvis as before
            }
            try {
                if (lazyInitWakeword == "hey_jarvis") {
                    emitDebug("warn", "startOwwListening called with null detector; lazy-init 'hey_jarvis' first")
                } else {
                    emitDebug("warn", "startOwwListening called with null detector; lazy-init '$lazyInitWakeword' (from active wake set)")
                }
                owwDetector?.close()
                val fresh = OpenWakeWordDetector(reactContext)
                val ok = fresh.loadModels(lazyInitWakeword)
                fresh.setThreshold(0.5f)
                if (ok) {
                    owwDetector = fresh
                    owwWakeword = lazyInitWakeword
                    emitDebug("info", "Lazy-init completed; wake listener now using '$lazyInitWakeword'")
                } else {
                    promise.reject("OWW_NOT_INIT", "Call initOww first (and lazy-init failed)")
                    return
                }
            } catch (e: Exception) {
                promise.reject("OWW_NOT_INIT", "Call initOww first (lazy-init error: ${e.message})")
                return
            }
        }
        try {
            isOwwListening = true
            val sampleRate = 16000
            val chunkSamples = 1280  // 80ms at 16kHz — openWakeWord's natural frame size
            val bufferSize = AudioRecord.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(chunkSamples * 2)

            val rec = AudioRecord(
                android.media.MediaRecorder.AudioSource.MIC,
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                isOwwListening = false
                promise.reject("INIT_ERROR", "AudioRecord failed")
                return
            }
            owwRecord = rec
            rec.startRecording()

            owwThread = Thread {
                // v3.10.40 fix: re-read owwDetector from the field
                // (NOT the captured `val detector` from earlier)
                // AFTER the lazy-init block above has had a chance
                // to populate it. The captured local val holds the
                // pre-lazy-init value (which can still be null if
                // the lazy-init failed — in which case we'd reject
                // earlier and never get here). Reading the field
                // ensures we use the freshly-assigned detector when
                // the lazy-init path took the recovery branch.
                // The `?: return@Thread` early-out keeps the null
                // case safe — if somehow owwDetector is null when
                // we got here, the loop never starts and the
                // MicThread is shut down by the parent function's
                // later cleanup path. Better than a NPE.
                val detector = owwDetector ?: run {
                    Log.e("WakeWord", "OWW listener thread started with null detector; aborting")
                    return@Thread
                }
                val readBuf = ShortArray(bufferSize / 2)
                val chunkBuf = ShortArray(chunkSamples)
                var chunkFill = 0
                var highScoreFrames = 0
                var exitHighScoreFrames = 0
                var sendHighScoreFrames = 0
                val HIGH_SCORE_RUN = 3  // 3 consecutive frames above threshold = wake word
                val EXIT_HIGH_SCORE_RUN = 3  // 3 consecutive frames above exit threshold = exit phrase
                // v3.6.0: send classifier runs alongside exit
                // and wake. SEND_HIGH_SCORE_RUN is the number
                // of consecutive 80ms frames above the send
                // threshold before the event fires. The send
                // word is short (e.g. "send") so 3 frames
                // (~240ms) is a reasonable confirm window.
                val SEND_HIGH_SCORE_RUN = 3
                // v3.2.30: cooldown after a detection. Without
                // this, a single sustained "hey..." in the
                // user's speech (or background conversation
                // that happens to match the wake word) would
                // fire owwWakeDetected repeatedly as
                // highScoreFrames immediately counts back up
                // to HIGH_SCORE_RUN on the next frame — the
                // classic "wake word loop" symptom. 2000ms is
                // long enough for a real follow-up utterance
                // to start (which would be a separate wake
                // event anyway) but short enough that the user
                // can re-trigger the wake within a couple of
                // seconds of wanting to.
                val DETECTION_COOLDOWN_MS = 2000L
                var lastWakeAt = 0L
                var lastExitAt = 0L
                var lastSendAt = 0L
                // v3.6.0: counter for emitting periodic VAD
                // events. The JS layer uses these to mark
                // speech activity in the active recording turn
                // (drives the gibberish gate — drop the
                // recording if VAD never crossed the speech
                // threshold during the turn). Emitting on
                // every chunk would flood the JS bridge
                // (12.5Hz × ~50 bytes per event = 625 B/s of
                // bridge traffic just for VAD), so we emit at
                // ~5Hz: every 2-3 chunks. VAD_ENERGY_SEND_EVERY.
                var chunkCount = 0
                val VAD_ENERGY_SEND_EVERY = 3
                var lastVadAt = 0L
                val VAD_ENERGY_MIN_GAP_MS = 200L  // ~5Hz cap

                while (isOwwListening) {
                    val read = rec.read(readBuf, 0, readBuf.size)
                    if (read <= 0) continue

                    var i = 0
                    while (i < read && isOwwListening) {
                        val toCopy = minOf(read - i, chunkSamples - chunkFill)
                        System.arraycopy(readBuf, i, chunkBuf, chunkFill, toCopy)
                        chunkFill += toCopy
                        i += toCopy

                        if (chunkFill == chunkSamples) {
                            // v3.2.30: read the threshold from
                            // the detector instead of the
                            // hardcoded 0.5f that v3.1.95
                            // shipped with. Without this fix,
                            // setThreshold(threshold.toFloat())
                            // in initOww is a no-op as far as
                            // the listening loop is concerned —
                            // the detector would still fire on
                            // 0.5 regardless of what the JS
                            // layer asked for. Result: user-
                            // configured foreground/background
                            // thresholds (Settings → 🎤 Wake
                            // Word → Foreground match
                            // threshold / Background match
                            // threshold) had no effect.
                            //
                            // v3.5.0: dual classifier. The
                            // detector now returns BOTH wake and
                            // exit scores from the same
                            // melspec+embedding pass. Each has
                            // its own threshold and its own
                            // HIGH_SCORE_RUN counter so they
                            // can fire independently.
                            // v3.10.21: passive speaker enrollment.
                            // Compute rms + zcr first; if voice-
                            // active, push the latest embedding
                            // (which predictScore will compute
                            // next) into the enrollment buffer.
                            // Cheap (one DSP pass per chunk = 80ms)
                            // and runs CONTINUOUSLY as long as the
                            // OWW listener is running — no user
                            // action required. Tobe's "passive
                            // option" request.
                            val (rms, zcr) = computeEnergyAndZcr(chunkBuf)
                            if (rms >= PASSIVE_ENROLLMENT_RMS_THRESHOLD &&
                                zcr >= PASSIVE_ENROLLMENT_ZCR_THRESHOLD) {
                                // We add the embedding AFTER
                                // predictScore below, since the
                                // detector stashes the latest
                                // embedding into embeddingHistory
                                // as part of predictScore. Defer
                                // the actual accumulation to a
                                // post-predict call.
                                pendingEnrollmentSample = true
                            } else {
                                pendingEnrollmentSample = false
                            }
                            val pair = detector.predictScore(chunkBuf)
                            val wakeScore = pair.wake
                            val exitScore = pair.exit
                            val sendScore = pair.send
                            // v3.10.21: capture the latest
                            // embedding for passive
                            // enrollment (after
                            // predictScore stashed it).
                            if (pendingEnrollmentSample) {
                                detector.accumulateLatestEmbedding()
                            }
                            // v3.10.8: stash the latest scores
                            // so getLatestScores() (called from
                            // JS for the Wake test button) can
                            // read them. The OWW thread is the
                            // only writer; the JS side reads
                            // via the @Volatile field.
                            latestWakeScore = wakeScore
                            latestExitScore = exitScore
                            latestSendScore = sendScore
                            val threshold = detector.getThreshold()
                            val exitThreshold = detector.getExitThreshold()
                            val sendThreshold = detector.getSendThreshold()

                            // Wake word check
                            if (wakeScore != null && wakeScore >= threshold) {
                                highScoreFrames++
                                if (highScoreFrames >= HIGH_SCORE_RUN) {
                                    val now = System.currentTimeMillis()
                                    if (now - lastWakeAt >= DETECTION_COOLDOWN_MS) {
                                        // v3.10.23: speaker gate.
                                        // If the primary profile
                                        // is locked and the recent
                                        // audio doesn't match the
                                        // enrolled user, suppress
                                        // the wake event entirely.
                                        // If no profile is set yet,
                                        // the gate is a no-op
                                        // (system has to work
                                        // before it can learn).
                                        // v3.10.23: also bump the
                                        // confirmed-wake-fire
                                        // counter when the audio
                                        // WAS voice-active within
                                        // the last 2s (recent
                                        // embedding from the
                                        // wake-fire moment is in
                                        // the rolling history).
                                        val pendingWasVoice = pendingEnrollmentSample
                                        if (pendingWasVoice) detector.noteConfirmedWakeFire()
                                        if (detector.shouldSuppressWakeForSpeaker()) {
                                            // Not the enrolled
                                            // user. Don't open voice
                                            // mode. Log so we can
                                            // see how often this
                                            // fires in dev builds.
                                            val sm = detector.matchRecentSpeaker() ?: 0f
                                            Log.i("WakeWord", "OWW wake suppressed by speaker gate (match=${"%.2f".format(sm)} < $0.50)")
                                            highScoreFrames = 0
                                            chunkFill = 0
                                            continue
                                        }
                                        lastWakeAt = now
                                        // Wake word detected!
                                        handler.post {
                                            val params = Arguments.createMap()
                                            params.putDouble("score", wakeScore.toDouble())
                                            params.putString("wakeword", owwWakeword)
                                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                                .emit("owwWakeDetected", params)
                                        }
                                    } else {
                                        // v3.2.30: inside the
                                        // cooldown window.
                                        // Don't emit a duplicate
                                        // event (would race with
                                        // the JS busy flag and
                                        // could double-open
                                        // Voice Mode if the JS
                                        // side ever resets
                                        // busy=true between
                                        // events). Reset the
                                        // high-score counter so
                                        // we re-arm cleanly when
                                        // the cooldown expires.
                                        Log.w("WakeWord", "OWW detection suppressed by cooldown (${DETECTION_COOLDOWN_MS - (now - lastWakeAt)}ms remaining)")
                                    }
                                    highScoreFrames = 0
                                }
                            } else {
                                highScoreFrames = 0
                            }

                            // Exit phrase check (v3.5.0)
                            if (exitScore != null && exitScore >= exitThreshold) {
                                exitHighScoreFrames++
                                if (exitHighScoreFrames >= EXIT_HIGH_SCORE_RUN) {
                                    val now = System.currentTimeMillis()
                                    if (now - lastExitAt >= DETECTION_COOLDOWN_MS) {
                                        lastExitAt = now
                                        // Exit phrase detected!
                                        handler.post {
                                            val params = Arguments.createMap()
                                            params.putDouble("score", exitScore.toDouble())
                                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                                .emit("owwExitDetected", params)
                                        }
                                    } else {
                                        Log.w("WakeWord", "Exit detection suppressed by cooldown (${DETECTION_COOLDOWN_MS - (now - lastExitAt)}ms remaining)")
                                    }
                                    exitHighScoreFrames = 0
                                }
                            } else {
                                exitHighScoreFrames = 0
                            }

                            // Send word check (v3.6.0). The send
                            // word is the explicit "I'm done with
                            // my turn" cue the user says to commit
                            // the current utterance to the LLM.
                            // It is independent of exit (which
                            // closes voice mode) — both can be
                            // trained, both have their own cooldown.
                            if (sendScore != null && sendScore >= sendThreshold) {
                                sendHighScoreFrames++
                                if (sendHighScoreFrames >= SEND_HIGH_SCORE_RUN) {
                                    val now = System.currentTimeMillis()
                                    if (now - lastSendAt >= DETECTION_COOLDOWN_MS) {
                                        lastSendAt = now
                                        // Send word detected!
                                        handler.post {
                                            val params = Arguments.createMap()
                                            params.putDouble("score", sendScore.toDouble())
                                            // Echo the send word text
                                            // so the JS layer can
                                            // log/display what fired.
                                            params.putString("sendword", detector.sendNameOrEmpty())
                                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                                .emit("owwSendDetected", params)
                                        }
                                    } else {
                                        Log.w("WakeWord", "Send detection suppressed by cooldown (${DETECTION_COOLDOWN_MS - (now - lastSendAt)}ms remaining)")
                                    }
                                    sendHighScoreFrames = 0
                                }
                            } else {
                                sendHighScoreFrames = 0
                            }

                            // v3.6.0: periodic VAD event for the
                            // JS gibberish gate. Emits the current
                            // chunk's RMS energy + zero-crossing
                            // rate. JS uses these to mark whether
                            // the active recording turn has seen
                            // any speech-like audio at all. If
                            // not, stopAndSendRecording drops the
                            // recording instead of sending it to
                            // STT. Emitted at ~5Hz to keep bridge
                            // traffic bounded.
                            chunkCount++
                            if (chunkCount >= VAD_ENERGY_SEND_EVERY) {
                                chunkCount = 0
                                // v3.10.23: piggyback on the
                                // periodic VAD tick to drive
                                // the auto-enrollment loop.
                                // recomputePrimaryProfileIfReady
                                // is throttled internally (5s
                                // cooldown) so calling it every
                                // 3 chunks (~600ms) is harmless
                                // — most calls return immediately
                                // with no work.
                                val (recompUpdated, recompLocked) = detector.recomputePrimaryProfileIfReady()
                                if (recompLocked) {
                                    // Profile just locked on
                                    // this call. Emit a single
                                    // event so any JS subscriber
                                    // can react (no UI today —
                                    // the wake gate goes active
                                    // automatically).
                                    handler.post {
                                        val params = Arguments.createMap()
                                        params.putBoolean("locked", true)
                                        params.putInt("samplesTotal", detector.getEnrollmentSamplesTotal().toInt())
                                        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                            .emit("speakerProfileLocked", params)
                                    }
                                }
                                val (rms, zcr) = computeEnergyAndZcr(chunkBuf)
                                val now = System.currentTimeMillis()
                                if (now - lastVadAt >= VAD_ENERGY_MIN_GAP_MS) {
                                    lastVadAt = now
                                    handler.post {
                                        val params = Arguments.createMap()
                                        params.putDouble("rms", rms.toDouble())
                                        params.putDouble("zcr", zcr.toDouble())
                                        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                            .emit("owwVad", params)
                                    }
                                }
                            }

                            chunkFill = 0
                        }
                    }
                }
            }.also { it.isDaemon = true; it.start() }

            emitDebug("info", "OWW listening: $owwWakeword")
            promise.resolve(null)
        } catch (e: Exception) {
            isOwwListening = false
            promise.reject("START_ERROR", e.message)
        }
    }

    // v3.10.8: return the latest scores captured by
    // the OWW listening thread. JS-side callers (the
    // Wake test button) poll this during a test window
    // to compute peak wake/exit/send scores, so the
    // user can see how confident the model was that
    // they said the wake word. Returns nulls if the
    // OWW thread isn't running yet (e.g. before the
    // first startOwwListening).
    @ReactMethod fun getLatestScores(promise: Promise) {
        try {
            val result = Arguments.createMap().apply {
                putDouble("wake", (latestWakeScore ?: 0.0).toDouble())
                putDouble("exit", (latestExitScore ?: 0.0).toDouble())
                putDouble("send", (latestSendScore ?: 0.0).toDouble())
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("GET_SCORES_ERROR", e.message)
        }
    }

    // v3.10.45: score a recorded WAV file with the
    // currently-loaded OWW detector. Used by the JS
    // wake test path when the live OWW listener
    // can't be started (e.g. the device's MIC path
    // is in a bad state). The JS side records 4s of
    // audio via the existing recorder path
    // (startRecorderWithSilence + stopRecorder), then
    // hands the file to this method. We read the
    // WAV, split it into 1280-sample chunks, run
    // predictScore on each, and return the peak wake
    // score + peak RMS. The result panel displays
    // the same way as the live-listener test.
    //
    // Why a separate method instead of starting the
    // OWW listener inline: Tobe hit a v3.10.44 bug
    // where startOwwListening's AudioRecord init
    // would silently fail to start (no
    // recordingState check, no try/catch on
    // startRecording) while the recorder's
    // AudioRecord worked fine. The recorder path
    // already had the safeguards. Rather than
    // patching the OWW listener's init (which would
    // require understanding the device-specific
    // AudioRecord state, hard without a device),
    // route the test through the recorder and score
    // the file offline.
    //
    // This does NOT replace the live listener. The
    // live listener is still the production wake
    // detection path. scoreWavFile is a test-only
    // utility for the Wake settings test button.
    @ReactMethod fun scoreWavFile(path: String, promise: Promise) {
        try {
            val file = java.io.File(path)
            if (!file.exists()) {
                promise.reject("FILE_NOT_FOUND", "WAV file not found: $path")
                return
            }
            val wavBytes = file.readBytes()
            if (wavBytes.size < 44) {
                promise.reject("INVALID_WAV", "WAV file too small (${wavBytes.size} bytes)")
                return
            }
            // Sanity-check the WAV header: bytes 0-3
            // should be "RIFF", 8-11 "WAVE". If not,
            // we don't know how to skip the header.
            if (wavBytes[0] != 'R'.code.toByte() ||
                wavBytes[1] != 'I'.code.toByte() ||
                wavBytes[2] != 'F'.code.toByte() ||
                wavBytes[3] != 'F'.code.toByte()
            ) {
                promise.reject("INVALID_WAV", "Missing RIFF header")
                return
            }
            // Skip 44-byte standard PCM WAV header.
            val pcmBytes = wavBytes.copyOfRange(44, wavBytes.size)
            if (pcmBytes.size < 2) {
                promise.reject("INVALID_WAV", "No PCM data after header")
                return
            }
            val samples = ShortArray(pcmBytes.size / 2)
            for (i in samples.indices) {
                val lo = pcmBytes[i * 2].toInt() and 0xFF
                val hi = pcmBytes[i * 2 + 1].toInt()
                samples[i] = ((hi shl 8) or lo).toShort()
            }
            // Peak RMS over the whole file. PCM16 sample
            // normalized: s / 32768. Squared + averaged
            // = mean square, sqrt = RMS in [0, 1].
            var sumSquares = 0.0
            for (s in samples) {
                val f = s / 32768.0
                sumSquares += f * f
            }
            val rms = Math.sqrt(sumSquares / samples.size).toFloat()
            // Run the wake model on each 1280-sample
            // chunk. If owwDetector is null (initOww
            // never ran), skip scoring and return only
            // RMS — the user can still see whether the
            // mic heard audio.
            val detector = owwDetector
            val threshold: Float
            val wakeword: String
            if (detector != null) {
                threshold = detector.getThreshold()
                wakeword = owwWakeword
            } else {
                threshold = 0.5f
                wakeword = owwWakeword
            }
            var peak = 0f
            var fired = false
            var firedScore: Float? = null
            var chunksScored = 0
            if (detector != null) {
                val chunkSamples = 1280
                var i = 0
                while (i + chunkSamples <= samples.size) {
                    val chunk = ShortArray(chunkSamples)
                    System.arraycopy(samples, i, chunk, 0, chunkSamples)
                    val pair = detector.predictScore(chunk)
                    val wakeScore = pair.wake
                    if (wakeScore != null && wakeScore > peak) peak = wakeScore
                    if (!fired && wakeScore != null && wakeScore >= threshold) {
                        fired = true
                        firedScore = wakeScore
                    }
                    chunksScored++
                    i += chunkSamples
                }
            }
            val result = Arguments.createMap().apply {
                putDouble("peak", peak.toDouble())
                putDouble("rms", rms.toDouble())
                putBoolean("fired", fired)
                if (firedScore != null) putDouble("firedScore", firedScore.toDouble())
                putString("wakeword", wakeword)
                putInt("chunksScored", chunksScored)
                putInt("samplesTotal", samples.size)
                // v3.10.50: diagnostic info so the JS
                // can surface what model was actually
                // loaded. Tobe hit peak=0 in v3.10.48
                // despite the JS test path calling
                // initOww(wakeword, 0.5) — the
                // diagnostic tip said 'model never
                // matched' but didn't tell us WHICH
                // model was loaded. Including the
                // current detector's wakeword here
                // lets the JS side say 'Loaded model:
                // hey_jarvis' vs 'Loaded model: hey
                // clawsuu' so the user can tell at a
                // glance whether initOww took effect.
                // The wakeword arg above is the value
                // passed to scoreWavFile; the new
                // fields are the detector's actual
                // state after initOww ran.
                putString("loadedWakeword", owwWakeword)
                putBoolean("detectorLoaded", detector != null)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("SCORE_ERROR", e.message)
        }
    }

    // v3.10.23: speaker enrollment. Averages the most
    // recent voice-active embeddings in the OWW
    // detector's buffer into a single 96-dim GLOBAL
    // profile (one profile for the user, not per-
    // companion). Returns true if enrollment succeeded.
    //
    // Kept as a debug/manual hook — the auto-lock
    // path (tryLockPrimaryProfile) is what runs in
    // practice, called by recomputeSpeakerProfile.
    // The JS layer is not expected to call this in
    // production; it exists for explicit "save my
    // voice now" commands in dev tools.
    @ReactMethod fun enrollSpeaker(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) {
                promise.reject("ENROLL_NO_DETECTOR", "OWW detector not initialized")
                return
            }
            val ok = det.enrollPrimaryProfileFromBuffer()
            if (ok) promise.resolve(true) else promise.reject("ENROLL_TOO_FEW_SAMPLES", "Not enough audio samples yet — talk for a few seconds before re-enrolling")
        } catch (e: Exception) {
            promise.reject("ENROLL_ERROR", e.message)
        }
    }

    @ReactMethod fun hasSpeakerEnrollment(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) { promise.resolve(false); return }
            promise.resolve(det.hasPrimaryProfile())
        } catch (e: Exception) {
            promise.reject("HAS_ENROLL_ERROR", e.message)
        }
    }

    @ReactMethod fun clearSpeakerEnrollment(promise: Promise) {
        try {
            val det = owwDetector
            if (det != null) det.clearPrimaryProfile()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("CLEAR_ENROLL_ERROR", e.message)
        }
    }

    // v3.10.23: compute speaker match score against the
    // primary profile. Returns null if no profile is
    // set yet (caller should treat as "no preference").
    // Otherwise returns cosine similarity in [-1, 1];
    // typical same-speaker scores are 0.7-0.9.
    @ReactMethod fun matchSpeaker(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) { promise.resolve(null); return }
            val score = det.matchRecentSpeaker()
            promise.resolve(score?.toDouble())
        } catch (e: Exception) {
            promise.reject("MATCH_ERROR", e.message)
        }
    }

    // v3.10.23: passive enrollment status. Returns:
    //  - "samplesTotal": total voice-active samples
    //    seen since last clear (cumulative, mono-
    //    tonically increases)
    //  - "bufferSize": current rolling buffer size
    //    (0-64; used for debugging)
    //  - "hasEnrollment": whether a profile is
    //    currently set (NOT per-companion — global)
    //  - "profileLocked": whether the profile is
    //    locked (auto-lock thresholds met)
    //  - "confirmedWakeFires": count of confirmed
    //    wake-fires used by the auto-lock threshold
    //  - "matchScore": current cosine similarity vs
    //    profile (null if no profile)
    @ReactMethod fun getSpeakerStatus(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) {
                promise.resolve(Arguments.createMap().apply {
                    putInt("samplesTotal", 0)
                    putInt("bufferSize", 0)
                    putBoolean("hasEnrollment", false)
                    putBoolean("profileLocked", false)
                    putInt("confirmedWakeFires", 0)
                    putNull("matchScore")
                })
                return
            }
            val result = Arguments.createMap().apply {
                putInt("samplesTotal", det.getEnrollmentSamplesTotal().toInt())
                putInt("bufferSize", det.getEnrollmentBufferSize())
                putBoolean("hasEnrollment", det.hasPrimaryProfile())
                putBoolean("profileLocked", det.isProfileLocked())
                putInt("confirmedWakeFires", det.getConfirmedWakeFires())
                val score = det.matchRecentSpeaker()
                if (score != null) putDouble("matchScore", score.toDouble())
                else putNull("matchScore")
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("STATUS_ERROR", e.message)
        }
    }

    /**
     * v3.10.23: recompute the primary profile from the
     * current enrollment buffer. If auto-lock thresholds
     * are met, locks + persists the profile in this call.
     *
     * Returns: WritableMap { updated: Boolean,
     * justLocked: Boolean }. The justLocked flag is true
     * iff THIS call caused the unlocked→locked
     * transition (so the caller can log it once).
     *
     * Called by:
     *  - WakeWordModule itself, from the OWW loop, every
     *    5s (drives the auto-lock path).
     *  - Debug "force recompute now" buttons.
     */
    @ReactMethod fun recomputeSpeakerProfile(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) {
                promise.resolve(Arguments.createMap().apply {
                    putBoolean("updated", false)
                    putBoolean("justLocked", false)
                })
                return
            }
            val (updated, justLocked) = det.recomputePrimaryProfileIfReady()
            promise.resolve(Arguments.createMap().apply {
                putBoolean("updated", updated)
                putBoolean("justLocked", justLocked)
            })
        } catch (e: Exception) {
            promise.reject("RECOMPUTE_ERROR", e.message)
        }
    }

    /**
     * v3.10.23: load the persisted primary profile from
     * SharedPreferences. Called once at app boot (from
     * JS, after initOww) so the user doesn't have to
     * re-teach the app on every cold start. Returns
     * true if a profile was loaded.
     */
    @ReactMethod fun loadPersistedSpeakerProfile(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) { promise.resolve(false); return }
            val ok = det.loadPersistedPrimaryProfile()
            if (ok && det.hasPrimaryProfile()) {
                // v3.10.23: emit a status event so any
                // subscriber can react (no UI today —
                // the gate goes active automatically).
                val params = Arguments.createMap()
                params.putBoolean("loaded", true)
                params.putBoolean("locked", det.isProfileLocked())
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("speakerProfileLoaded", params)
            }
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.reject("LOAD_PROFILE_ERROR", e.message)
        }
    }

    /**
     * v3.10.23: serialize the primary profile to base64.
     * Debug / future use — no current JS consumer.
     */
    @ReactMethod fun getSpeakerProfileBytes(promise: Promise) {
        try {
            val det = owwDetector
            if (det == null) { promise.resolve(null); return }
            promise.resolve(det.getPrimaryProfileBase64())
        } catch (e: Exception) {
            promise.reject("GET_PROFILE_ERROR", e.message)
        }
    }

    @ReactMethod fun stopOwwListening(promise: Promise) {
        isOwwListening = false
        try { owwRecord?.stop() } catch (_: Exception) {}
        try { owwRecord?.release() } catch (_: Exception) {}
        owwRecord = null
        try { owwThread?.join(2000) } catch (_: Exception) {}
        owwThread = null
        promise.resolve(null)
    }

    // v3.6.0: compute RMS energy and zero-crossing rate of a
    // PCM16 audio chunk. Used by the periodic owwVad event so
    // the JS layer can decide whether the active recording
    // turn has seen any speech-like audio (drives the
    // gibberish gate — drop recordings where VAD never
    // crossed the speech threshold).
    //
    // Returns Pair(RMS, ZCR), both in [0, 1].
    //
    // RMS: sqrt(mean(s^2)) where s = sample/32768. A silent
    //   chunk has RMS near 0; sustained speech is around
    //   0.05-0.2; loud speech/laughs can hit 0.5+.
    //
    // ZCR: zero-crossings / sample_count. Speech has moderate
    //   ZCR (~0.05-0.15). Pure white noise is much higher
    //   (~0.3-0.5). A DC offset (clipping) is 0.
    //
    // We keep this in the wake-word module rather than the
    // detector because it's a tiny per-chunk computation
    // that doesn't need the melspec pipeline.
    private fun computeEnergyAndZcr(pcm16: ShortArray): Pair<Float, Float> {
        if (pcm16.isEmpty()) return Pair(0f, 0f)
        var sumSquares = 0.0
        var crossings = 0
        var prev = 0
        for (i in pcm16.indices) {
            val s = pcm16[i].toInt()
            sumSquares += (s * s).toDouble()
            if (i > 0) {
                // sign comparison: any sign change (incl. zero crossings)
                // counts as a zero crossing.
                if ((s >= 0) != (prev >= 0)) crossings++
            }
            prev = s
        }
        val rms = Math.sqrt(sumSquares / pcm16.size / (32768.0 * 32768.0)).toFloat()
        val zcr = crossings.toFloat() / pcm16.size
        return Pair(rms.coerceIn(0f, 1f), zcr.coerceIn(0f, 1f))
    }

    // ── Audio Playback ─────────────────────────────────────────────────────

    private var mediaPlayer: MediaPlayer? = null

    @ReactMethod fun startPlayer(path: String, queueIfPlaying: Boolean, promise: Promise) {
        try {
            // v3.10.18: queueIfPlaying mode. When true and
            // a MediaPlayer is currently playing, instead
            // of starting a new player (which would
            // truncate the current one), use
            // setNextMediaPlayer to queue this one. This
            // is the smart cue-after-response path Tobe
            // asked for: when the response audio finishes,
            // the framework automatically starts the cue
            // — no JS-side settle delay, no race with the
            // audio HAL buffer drain.
            val existing = mediaPlayer
            if (queueIfPlaying && existing != null && existing.isPlaying) {
                val next = MediaPlayer()
                if (path.startsWith("file:///android_asset/")) {
                    val assetRel = path.removePrefix("file:///android_asset/")
                    val afd = reactContext.assets.openFd(assetRel)
                    next.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                    afd.close()
                } else {
                    next.setDataSource(path)
                }
                next.setOnErrorListener { _, what, extra ->
                    emitDebug("error", "Next MediaPlayer error what=$what extra=$extra for path=$path")
                    try { next.release() } catch (_: Exception) {}
                    true
                }
                next.setOnCompletionListener {
                    // Emit on the LAST in the chain.
                    try {
                        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit("audioPlayerFinished", null)
                    } catch (_: Exception) {}
                    try { next.release() } catch (_: Exception) {}
                    if (mediaPlayer === next) mediaPlayer = null
                }
                next.prepare()
                existing.setNextMediaPlayer(next)
                // Don't update mediaPlayer to `next` yet —
                // the existing player still owns the audio
                // session. Once existing completes, the
                // framework transitions to `next`.
                promise.resolve(null)
                return
            }

            mediaPlayer?.release()
            val mp = MediaPlayer()
            // v3.10.8: handle three path shapes properly.
            //  - "file:///android_asset/..." — bundled assets
            //    MUST go through AssetManager.openFd() with
            //    explicit offset/length. setDataSource(String)
            //    on these URIs SILENTLY FAILS in some Android
            //    builds (the MediaPlayer enters the Error
            //    state without throwing, and start() does
            //    nothing). Tobe's "no your turn sound" bug
            //    across v3.9.8 → v3.10.7 was likely this
            //    exact failure path.
            //  - "file:///..." (non-asset) — setDataSource
            //    handles the file:// URI directly.
            //  - bare filesystem path — setDataSource(String)
            //    handles it directly.
            if (path.startsWith("file:///android_asset/")) {
                val assetRel = path.removePrefix("file:///android_asset/")
                val afd = reactContext.assets.openFd(assetRel)
                mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
            } else {
                mp.setDataSource(path)
            }
            mp.setOnErrorListener { _, what, extra ->
                emitDebug("error", "MediaPlayer error what=$what extra=$extra for path=$path")
                try { mp.release() } catch (_: Exception) {}
                mediaPlayer = null
                true
            }
            mp.setOnCompletionListener {
                try {
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("audioPlayerFinished", null)
                } catch (_: Exception) {}
                try { mp.release() } catch (_: Exception) {}
                mediaPlayer = null
            }
            mp.prepare()
            mp.start()
            mediaPlayer = mp
            promise.resolve(null)
        } catch (e: Exception) {
            try { mediaPlayer?.release() } catch (_: Exception) {}
            mediaPlayer = null
            promise.reject("PLAY_ERROR", e.message)
        }
    }

    @ReactMethod fun stopPlayer(promise: Promise) {
        try {
            mediaPlayer?.stop()
            mediaPlayer?.release()
            mediaPlayer = null
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PLAY_STOP_ERROR", e.message)
        }
    }

    // ── Native Text-to-Speech ───────────────────────────────────────────────

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    // v3.1.89: track whether voice data has actually
    // finished loading. TextToSpeech.onInit returns SUCCESS
    // as soon as the engine binds, but voice data for the
    // requested locale is loaded async — and engine.speak()
    // before voices are ready can silently drop the
    // utterance on some devices. We use this flag as a
    // diagnostic (logged on each speak) but no longer gate
    // speak() on it — the engine's own queue handles
    // backpressure, and the JS-side fallback timeout
    // covers the worst-case cold-start delay.
    private var ttsVoicesReady = false

    private fun getTts(onReady: (TextToSpeech) -> Unit, onError: (String) -> Unit) {
        // If engine exists and is bound, just hand it over
        // immediately. The speak() call will queue the
        // utterance, and the engine's own internal queue
        // handles backpressure if voice data isn't loaded
        // yet (the first utterance after wake may take
        // 2-3s to actually start producing audio, but it
        // WILL start, not silently drop).
        if (tts != null && ttsReady) {
            onReady(tts!!)
            return
        }
        // Engine doesn't exist or init hasn't finished:
        // (re)create it. v3.10.39: wrap the bind in a
        // single-attempt retry — the Android TTS service
        // often returns status=-1 (ERROR) on the very
        // first bind at cold start while the system service
        // is still spinning up. Retrying once after a
        // short delay (~1000ms) catches that race; if the
        // second attempt also fails, give up and let the
        // JS-side WebView speechSynthesis fallback run.
        var attempt = 0
        // The JS-side fallback timer is anchored to the
        // FIRST bind attempt's start time, not the per-
        // attempt time. If both attempts fail within 1s
        // each, total bound time is 2s; the JS-side 3.5s
        // fallback timer covers it (Tobe's v3.10.34 default).
        fun attemptBind() {
            attempt++
            tts?.shutdown()
            ttsVoicesReady = false
            tts = TextToSpeech(reactContext) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.language = Locale.US
                    tts?.setSpeechRate(0.95f)
                    tts?.setPitch(1.1f)
                    emitDebug("info", "TTS init OK (attempt $attempt), calling onReady")
                    onReady(tts!!)
                } else {
                    // v3.1.83: notify the caller of init failure
                    // instead of silently swallowing it. Previously
                    // getTts only called onReady on success, so if
                    // the system TTS service was busy/unavailable
                    // at cold start, speakText's promise never
                    // resolved AND never rejected, and the JS
                    // catch + WebView speechSynthesis fallback
                    // never ran. The greeting was silently dropped.
                    emitDebug("error", "TTS init failed (attempt $attempt): status=$status")
                    if (attempt < 2) {
                        // v3.10.39: retry once after 1000ms
                        // — the Android TTS service often
                        // returns ERROR on the very first
                        // bind at cold start while the
                        // system service is still spinning up.
                        // A second try after a brief delay
                        // catches that race. The retry's
                        // onError is suppressed — we only
                        // bubble up to the caller after the
                        // second attempt completes.
                        handler.postDelayed({
                            attemptBind()
                        }, 1000L)
                    } else {
                        // Second attempt also failed —
                        // surface the error to the caller
                        // (JS-side WebView speechSynthesis
                        // fallback will take over).
                        onError("TTS init failed: status=$status")
                    }
                }
            }
        }
        attemptBind()
    }

    @ReactMethod fun speakText(text: String, promise: Promise) {
        getTts({ engine ->
            // v3.1.89: always call actuallySpeak directly.
            // The onStart callback in actuallySpeak will
            // mark ttsVoicesReady=true when the first
            // utterance actually begins speaking. The JS
            // side has its own fallback timeout (3.5s in
            // v3.1.89) that covers the worst-case slow
            // first utterance after wake.
            actuallySpeak(text, promise)
        }, { err ->
            // v3.1.83: surface the failure to JS so the
            // WebView speechSynthesis fallback actually
            // runs. Previously this branch never executed
            // because getTts had no onError callback.
            promise.reject("TTS_INIT_FAILED", err)
        })
    }

    private fun actuallySpeak(text: String, promise: Promise) {
        val engine = tts ?: run {
            promise.reject("TTS_NULL", "tts engine is null")
            return
        }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                if (!ttsVoicesReady) {
                    ttsVoicesReady = true
                    emitDebug("info", "TTS voices ready (via real speak)")
                }
            }
            override fun onDone(utteranceId: String?) {
                handler.post {
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("ttsDone", null)
                }
            }
            override fun onError(utteranceId: String?) {
                handler.post {
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("ttsDone", null)
                }
            }
        })
        val status = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "claw-tts")
        // v3.1.89: log the engine.speak() return code so we
        // can tell from JS logs whether the utterance was
        // actually accepted into the queue or silently
        // rejected. SUCCESS == 0.
        emitDebug("info", "TTS speak() returned $status for \"${text.take(40)}\"")
        if (status == TextToSpeech.SUCCESS) {
            promise.resolve(null)
        } else {
            promise.reject("TTS_SPEAK_FAILED", "engine.speak returned $status")
        }
    }

    @ReactMethod fun stopSpeaking(promise: Promise) {
        tts?.stop()
        promise.resolve(null)
    }

    // v3.1.87: initialize the Android TextToSpeech engine
    // without speaking anything. Called from App.tsx on mount
    // to "pre-warm" the engine so the first real speak()
    // after a wake event doesn't have to wait for cold-start
    // init (which can take 1-2 seconds and was the root cause
    // of the silent-drop bugs in v3.1.83 / v3.1.85).
    //
    // The init is async — the Promise resolves on init success
    // and rejects on init failure. Either way, the engine is in
    // a known state by the time the Promise settles.
    @ReactMethod fun prewarmTts(promise: Promise) {
        getTts({ engine ->
            promise.resolve(true)
        }, { err ->
            promise.reject("TTS_INIT_FAILED", err)
        })
    }

    // v3.1.90: probe installed TTS engines via the system
    // PackageManager. Returns true if at least one engine
    // responds to the TTS_SERVICE intent, false otherwise.
    // Useful for diagnosing "init failed: status=-1" on
    // devices where no engine is installed (e.g. stripped
    // Android skins without Google TTS).
    @ReactMethod fun hasTtsEngine(promise: Promise) {
        try {
            val pm = reactContext.packageManager
            val intent = android.content.Intent(
                android.speech.tts.TextToSpeech.Engine.ACTION_CHECK_TTS_DATA
            )
            val resolves = pm.queryIntentActivities(intent, 0)
            promise.resolve(resolves.isNotEmpty())
        } catch (e: Exception) {
            promise.reject("TTS_PROBE_ERROR", e.message)
        }
    }

    // v3.1.90: launch the system TTS install activity.
    // The system shows a dialog with available engines
    // (Google TTS, Samsung TTS, etc.) and lets the user
    // install one. Returns true if the install activity
    // was successfully launched.
    @ReactMethod fun installTtsData(promise: Promise) {
        try {
            val intent = android.content.Intent(
                android.speech.tts.TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA
            )
            intent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            // ACTION_INSTALL_TTS_DATA is deprecated in API 29+
            // but still works. Use it as a best-effort.
            // We use reactContext (the application context) to
            // start the activity — FLAG_ACTIVITY_NEW_TASK is
            // already set above so this is safe even from a
            // non-Activity context.
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("TTS_INSTALL_ERROR", e.message)
        }
    }
}
