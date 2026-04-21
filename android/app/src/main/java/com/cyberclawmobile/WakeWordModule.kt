package com.cyberclawmobile

import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.Log
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream

class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    // ── Wake Word ──────────────────────────────────────────────────────────

    private var recognizer: SpeechRecognizer? = null
    private var isListening = false
    private val handler = Handler(Looper.getMainLooper())
    private var errorCount = 0
    private var wakePhrase = "hey claw"

    private fun emitDebug(state: String, text: String? = null) {
        val map = Arguments.createMap()
        map.putString("state", state)
        if (text != null) map.putString("text", text)
        reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("wakeWordDebug", map)
    }

    private fun buildIntent(partial: Boolean = true, maxResults: Int = 3): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
        }
    }

    private fun checkResults(matches: List<String>?) {
        if (matches == null) return
        val phrase = wakePhrase.lowercase()
        val hit = matches.any { it.lowercase().contains(phrase) }
        if (hit) {
            Log.d("WakeWord", "Wake phrase detected!")
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("wakeWordDetected", null)
        }
    }

    private fun scheduleRestart(delayMs: Long) {
        if (!isListening) return
        handler.postDelayed({ startRecognizer() }, delayMs)
    }

    private fun startRecognizer() {
        if (!isListening) return
        handler.post {
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(reactContext)
            recognizer?.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { emitDebug("ready") }
                override fun onBeginningOfSpeech() { emitDebug("listening") }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { emitDebug("processing") }
                override fun onPartialResults(partialResults: Bundle?) {
                    val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    if (!matches.isNullOrEmpty()) emitDebug("partial", matches[0])
                    checkResults(matches)
                }
                override fun onResults(results: Bundle?) {
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    if (!matches.isNullOrEmpty()) emitDebug("heard", matches[0])
                    errorCount = 0
                    checkResults(matches)
                    scheduleRestart(300)
                }

                override fun onError(error: Int) {
                    val msg = errorName(error)
                    Log.d("WakeWord", "onError: $msg (count=$errorCount)")
                    emitDebug("error", msg)
                    if (error == 5) {
                        Log.e("WakeWord", "Speech Recognition not available (client error) — wake word disabled")
                        emitDebug("unavailable", "Speech Recognition not available on this device")
                        stopListening(null)
                        return
                    }
                    if (error == 6 || error == 7) {
                        errorCount = 0
                        scheduleRestart(500L)
                    } else {
                        errorCount++
                        if (errorCount > 5) {
                            Log.e("WakeWord", "Too many errors, pausing 60s")
                            emitDebug("paused", "retry in 60s")
                            errorCount = 0
                            scheduleRestart(60_000L)
                        } else {
                            val delay = minOf(2000L * (1L shl (errorCount - 1)), 30_000L)
                            scheduleRestart(delay)
                        }
                    }
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            recognizer?.startListening(buildIntent(partial = true, maxResults = 3))
        }
    }

    @ReactMethod fun start(phrase: String, promise: Promise) {
        wakePhrase = phrase
        isListening = true
        errorCount = 0
        startRecognizer()
        promise.resolve(null)
    }

    @ReactMethod fun stop(promise: Promise) {
        stopListening(promise)
    }

    private fun stopListening(promise: Promise?) {
        isListening = false
        handler.post {
            recognizer?.destroy()
            recognizer = null
        }
        promise?.resolve(null)
    }

    @ReactMethod fun test(promise: Promise) {
        emitDebug("test", "ok")
        promise.resolve(null)
    }

    // ── Audio Recording ────────────────────────────────────────────────────

    private var mediaRecorder: MediaRecorder? = null
    private var recordingPath: String? = null

    @ReactMethod fun startRecorder(path: String, promise: Promise) {
        try {
            mediaRecorder?.release()
            val outFile = File(path)
            outFile.parentFile?.mkdirs()
            recordingPath = path

            @Suppress("DEPRECATION")
            val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(reactContext)
            } else {
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
            promise.resolve(path)
        } catch (e: Exception) {
            promise.reject("RECORD_ERROR", e.message)
        }
    }

    @ReactMethod fun stopRecorder(promise: Promise) {
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

    // ── Helpers ────────────────────────────────────────────────────────────

    private fun errorName(code: Int) = when (code) {
        1 -> "network timeout"
        2 -> "network"
        3 -> "audio"
        4 -> "server"
        5 -> "client"
        6 -> "no speech"
        7 -> "no match"
        8 -> "recognizer busy"
        9 -> "insufficient permissions"
        else -> "unknown($code)"
    }
}
