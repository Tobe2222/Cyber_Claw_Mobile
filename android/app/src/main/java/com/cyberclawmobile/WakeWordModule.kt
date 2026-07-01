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

        if (PhoneticMatcher.matches(text, wakePhrase)) {
            Log.d("WakeWord", "Wake phrase detected: $text (target: $wakePhrase)")
            handler.post {
                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("wakeWordDetected", null)
            }
            emitDebug("detected", text)
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

    private var mediaRecorder: MediaRecorder? = null
    private var recordingPath: String? = null
    private var silenceTimer: java.util.Timer? = null

    @ReactMethod fun startRecorder(path: String, promise: Promise) {
        startRecorderWithSilence(path, 5000, promise)
    }

    @ReactMethod fun startRecorderWithSilence(path: String, silenceMs: Int, promise: Promise) {
        try {
            // FIX: Disable listening during recording to prevent dual audio reading from MIC
            isRecording = true
            isListening = false
            
            mediaRecorder?.release()
            silenceTimer?.cancel(); silenceTimer = null
            val outFile = File(path)
            outFile.parentFile?.mkdirs()
            recordingPath = path

            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(reactContext)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioSamplingRate(16000)
            recorder.setAudioChannels(1)
            recorder.setOutputFile(path)
            recorder.prepare()
            recorder.start()
            mediaRecorder = recorder

            // Auto-stop on silence: poll amplitude every 500ms, stop after silenceMs of quiet
            //
            // v3.2.23 — wait-for-speech-then-silence model (Alexa-style).
            // The previous version started the silence timer from
            // recorder start, so if the user hadn't spoken by 3-5s,
            // the loop closed their turn before they had time to
            // respond. Tobe reported this exact symptom in v3.2.22.
            //
            // New behavior: only emit `recorderSilence` AFTER the
            // user has actually spoken at least once. The timer
            // measures "post-speech silence", not "total silence".
            // `hasUserSpoken` is set true on the first non-silent
            // amplitude reading and resets on recorder.stop().
            // A `MAX_RECORDING_MS` hard cap still fires silence
            // after 30s of total recording time (covers the case
            // where the user speaks once and then stays quiet for
            // 30+ seconds).
            var silentFor = 0L
            var recordingFor = 0L
            var hasUserSpoken = false
            val SILENCE_THRESHOLD = 1000 // ~3% of max; filters out mic hiss but catches speaking breaks
            val MIN_RECORDING_MS = 500L   // shorter warmup — 500ms before silence-check begins
            val MAX_RECORDING_MS = 30_000L // hard cap: 30s total recording, then auto-send regardless
            val POLL_MS = 500L
            val timer = java.util.Timer()
            silenceTimer = timer
            timer.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    val rec = mediaRecorder ?: run { cancel(); return }
                    val amp = try { rec.maxAmplitude } catch (_: Exception) { -1 }
                    if (amp < 0) return // recorder stopped externally
                    recordingFor += POLL_MS
                    if (recordingFor >= MAX_RECORDING_MS) { // hard cap
                        cancel()
                        handler.post {
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("recorderSilence", null)
                        }
                        return
                    }
                    // v3.2.25 — reserved for future exit-phrase
                    // detection. The polling loop above already
                    // captures amplitude; future work can add a
                    // real-time envelope event here.
                    // Speech detection: amplitude above threshold
                    // means the user is talking. Mark `hasUserSpoken`
                    // so future silence checks know to fire.
                    if (amp >= SILENCE_THRESHOLD) {
                        hasUserSpoken = true
                        silentFor = 0L // reset silence counter on speech
                        return
                    }
                    if (!hasUserSpoken) return // still waiting for first speech
                    if (recordingFor < MIN_RECORDING_MS) return
                    // User has spoken, now measuring post-speech silence.
                    silentFor += POLL_MS
                    if (silentFor >= silenceMs) {
                        cancel()
                        handler.post {
                            // Emit silence event so JS can auto-stop recording
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("recorderSilence", null)
                        }
                    }
                }
            }, POLL_MS, POLL_MS)

            promise.resolve(path)
        } catch (e: Exception) {
            promise.reject("RECORD_ERROR", e.message)
        }
    }

    @ReactMethod fun stopRecorder(promise: Promise) {
        // FIX: Clear recording flag when stopping
        isRecording = false
        
        silenceTimer?.cancel(); silenceTimer = null
        try {
            mediaRecorder?.stop()
            mediaRecorder?.release()
            mediaRecorder = null
            promise.resolve(recordingPath ?: "")
        } catch (e: Exception) {
            mediaRecorder?.release()
            mediaRecorder = null
            promise.reject("RECORD_STOP_ERROR", e.message)
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

    @ReactMethod fun initOww(wakeword: String, threshold: Double = 0.5, promise: Promise) {
        try {
            owwWakeword = wakeword
            owwDetector?.close()
            owwDetector = OpenWakeWordDetector(reactContext).apply {
                val ok = loadModels(wakeword)
                setThreshold(threshold.toFloat())
                if (!ok) throw Exception("Failed to load TFLite models")
            }
            emitDebug("info", "OWW initialized: $wakeword @ $threshold")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OWW_INIT", e.message)
        }
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
            val dir = File(reactContext.filesDir, "wake_models")
            if (!dir.exists()) dir.mkdirs()
            val tflite = File(dir, "${agentId}.tflite")
            tflite.writeBytes(Base64.decode(base64, Base64.DEFAULT))
            emitDebug("info", "Wrote custom wake model: ${tflite.absolutePath} (${tflite.length()} bytes)")

            // Persist the binding so we can re-apply on app restart.
            // Key: wake_model_<agentId> -> {path, phrase, savedAt}
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            prefs.edit()
                .putString("${agentId}_path", tflite.absolutePath)
                .putString("${agentId}_phrase", phrase)
                .putLong("${agentId}_savedAt", System.currentTimeMillis())
                .apply()

            // Hot-swap into the running detector (if any). If the
            // detector isn't initialized yet, the loadOwwSavedModel
            // helper will pick up the file when initOww runs.
            val detector = owwDetector
            if (detector != null) {
                val ok = detector.setWakewordModelFromFile(tflite.absolutePath)
                if (ok) {
                    owwWakeword = phrase
                    emitDebug("info", "Hot-swapped wake model for $agentId: $phrase")
                } else {
                    emitDebug("warn", "Hot-swap failed; will retry on next initOww")
                }
            }
            promise.resolve(tflite.absolutePath)
        } catch (e: Exception) {
            promise.reject("WAKE_MODEL_SAVE", e.message)
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
        val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
        val path = prefs.getString("${agentId}_path", null) ?: return null
        val phrase = prefs.getString("${agentId}_phrase", null) ?: return null
        if (!File(path).exists()) {
            // Stale binding (file deleted); clean up.
            prefs.edit().remove("${agentId}_path").remove("${agentId}_phrase").remove("${agentId}_savedAt").apply()
            return null
        }
        val detector = owwDetector ?: return null
        val ok = detector.setWakewordModelFromFile(path)
        if (ok) {
            owwWakeword = phrase
            emitDebug("info", "Loaded saved wake model for $agentId: $phrase")
            return phrase
        }
        return null
    }

    // v3.2.0: list the agents that have a saved custom wake model.
    // Used by the UI to show "✓ trained" badges in the wake
    // menu without having to round-trip to the desktop.
    @ReactMethod fun getSavedWakeModels(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("wake_models", android.content.Context.MODE_PRIVATE)
            val all = prefs.all
            val result = com.facebook.react.bridge.Arguments.createMap()
            for ((key, value) in all) {
                if (key.endsWith("_phrase") && value is String) {
                    val agentId = key.removeSuffix("_phrase")
                    val path = prefs.getString("${agentId}_path", null)
                    val savedAt = prefs.getLong("${agentId}_savedAt", 0L)
                    if (path != null && File(path).exists()) {
                        val entry = com.facebook.react.bridge.Arguments.createMap()
                        entry.putString("agentId", agentId)
                        entry.putString("phrase", value)
                        entry.putString("path", path)
                        entry.putDouble("savedAt", savedAt.toDouble())
                        result.putMap(agentId, entry)
                    }
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

    @ReactMethod fun startOwwListening(promise: Promise) {
        if (isOwwListening) { promise.resolve(null); return }
        val detector = owwDetector
        if (detector == null) {
            promise.reject("OWW_NOT_INIT", "Call initOww first")
            return
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
                val readBuf = ShortArray(bufferSize / 2)
                val chunkBuf = ShortArray(chunkSamples)
                var chunkFill = 0
                var highScoreFrames = 0
                val HIGH_SCORE_RUN = 3  // 3 consecutive frames above threshold = wake word
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
                var lastDetectionAt = 0L

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
                            val score = detector.predictScore(chunkBuf) ?: 0f
                            val threshold = detector.getThreshold()
                            if (score >= threshold) {
                                highScoreFrames++
                                if (highScoreFrames >= HIGH_SCORE_RUN) {
                                    val now = System.currentTimeMillis()
                                    if (now - lastDetectionAt >= DETECTION_COOLDOWN_MS) {
                                        lastDetectionAt = now
                                        // Wake word detected!
                                        handler.post {
                                            val params = Arguments.createMap()
                                            params.putDouble("score", score.toDouble())
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
                                        Log.w("WakeWord", "OWW detection suppressed by cooldown (${DETECTION_COOLDOWN_MS - (now - lastDetectionAt)}ms remaining)")
                                    }
                                    highScoreFrames = 0
                                }
                            } else {
                                highScoreFrames = 0
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

    @ReactMethod fun stopOwwListening(promise: Promise) {
        isOwwListening = false
        try { owwRecord?.stop() } catch (_: Exception) {}
        try { owwRecord?.release() } catch (_: Exception) {}
        owwRecord = null
        try { owwThread?.join(2000) } catch (_: Exception) {}
        owwThread = null
        promise.resolve(null)
    }

    // ── Audio Playback ─────────────────────────────────────────────────────

    private var mediaPlayer: MediaPlayer? = null

    @ReactMethod fun startPlayer(path: String, promise: Promise) {
        try {
            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(path)
                prepare()
                start()
                setOnCompletionListener {
                    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("audioPlayerFinished", null)
                    release()
                    mediaPlayer = null
                }
            }
            promise.resolve(null)
        } catch (e: Exception) {
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
        // (re)create it.
        tts?.shutdown()
        ttsVoicesReady = false
        tts = TextToSpeech(reactContext) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.language = Locale.US
                tts?.setSpeechRate(0.95f)
                tts?.setPitch(1.1f)
                emitDebug("info", "TTS init OK, calling onReady")
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
                emitDebug("error", "TTS init failed: status=$status")
                onError("TTS init failed: status=$status")
            }
        }
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
