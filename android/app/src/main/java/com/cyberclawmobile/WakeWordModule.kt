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
        rec.startRecording()

        emitDebug("ready", "Listening for \"$wakePhrase\"")

        listenThread = Thread {
            val buf = ShortArray(bufferSize / 2)
            val byteBuf = ByteArray(bufferSize)
            while (isListening) {
                val read = rec.read(buf, 0, buf.size)
                if (read <= 0) continue

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
            val SILENCE_THRESHOLD = 2000 // ~6% of max; filters out mic hiss/room noise
            val MIN_RECORDING_MS = 1500L  // always record at least 1.5s before silence check
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
                    if (recordingFor >= 60_000L) { // hard cap: 60s max recording
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
