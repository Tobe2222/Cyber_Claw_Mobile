package com.cyberclawmobile

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
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
            var silentFor = 0L
            var recordingFor = 0L
            val SILENCE_THRESHOLD = 1000 // ~3% of max; filters out mic hiss but catches speaking breaks
            val MIN_RECORDING_MS = 2000L  // always record at least 2s before silence check
            val MAX_RECORDING_MS = 15_000L // absolute max: 15s then auto-send
            val POLL_MS = 500L
            val timer = java.util.Timer()
            silenceTimer = timer
            timer.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    val rec = mediaRecorder ?: run { cancel(); return }
                    val amp = try { rec.maxAmplitude } catch (_: Exception) { -1 }
                    if (amp < 0) return // recorder stopped externally
                    recordingFor += POLL_MS
                    if (recordingFor < MIN_RECORDING_MS) return // don't silence-check yet
                    if (recordingFor >= MAX_RECORDING_MS) { // hard cap: auto-send after 15s
                        cancel()
                        handler.post {
                            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                .emit("recorderSilence", null)
                        }
                        return
                    }
                    if (amp < SILENCE_THRESHOLD) {
                        silentFor += POLL_MS
                        if (silentFor >= silenceMs) {
                            cancel()
                            handler.post {
                                // Emit silence event so JS can auto-stop recording
                                reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                                    .emit("recorderSilence", null)
                            }
                        }
                    } else {
                        silentFor = 0L
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
}
