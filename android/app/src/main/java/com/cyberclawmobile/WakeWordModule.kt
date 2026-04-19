package com.cyberclawmobile

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * WakeWordModule — runs SpeechRecognizer on the main (UI) thread, which is required by Android.
 * The recognizer is started/stopped from JS and continuously listens in a loop.
 */
class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    private var recognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var wakePhrase = "hey clawsuu"

    @ReactMethod
    fun start(phrase: String, promise: Promise) {
        wakePhrase = phrase.ifBlank { "hey clawsuu" }.lowercase().trim()
        running = true
        Log.d("WakeWord", "Starting with phrase: '$wakePhrase'")
        handler.post { startListening() }
        promise.resolve(true)
    }

    @ReactMethod
    fun stop(promise: Promise) {
        running = false
        handler.post {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun test(promise: Promise) {
        // Fire a fake wake event — use this to verify the JS bridge is alive
        Log.d("WakeWord", "test() called — emitting wakeWordDetected")
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("wakeWordDetected", null)
        promise.resolve(true)
    }

    @ReactMethod
    fun addListener(eventName: String) {}
    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun startListening() {
        if (!running) return
        if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
            Log.w("WakeWord", "Speech recognition not available on this device")
            return
        }

        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(reactContext)
            ?: currentActivity?.let { SpeechRecognizer.createSpeechRecognizer(it) }
        recognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(p: Bundle?) { Log.d("WakeWord", "Ready") }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rms: Float) {}
            override fun onBufferReceived(b: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(t: Int, p: Bundle?) {}

            override fun onPartialResults(b: Bundle?) {
                checkResults(b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION))
            }
            override fun onResults(b: Bundle?) {
                checkResults(b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION))
                scheduleRestart(300)
            }
            override fun onError(error: Int) {
                Log.d("WakeWord", "Error: $error")
                // 7=no match, 6=no speech, 5=client-side — just restart
                scheduleRestart(if (error in listOf(5, 6, 7)) 100L else 800L)
            }
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
            // Don't show UI
            putExtra("android.speech.extra.DICTATION_MODE", true)
        }
        recognizer?.startListening(intent)
    }

    private fun checkResults(matches: List<String>?) {
        if (matches == null) return
        for (match in matches) {
            if (match.lowercase().contains(wakePhrase)) {
                Log.i("WakeWord", "Detected: $match")
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("wakeWordDetected", null)
                break
            }
        }
    }

    private fun scheduleRestart(delayMs: Long) {
        if (!running) return
        handler.postDelayed({ startListening() }, delayMs)
    }
}
