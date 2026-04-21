package com.cyberclawmobile

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    override fun getConstants(): Map<String, Any> = mapOf(
        "WAKE_DETECTED" to "wakeWordDetected",
        "WAKE_DEBUG"    to "wakeWordDebug"
    )

    private var recognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var wakePhrase = "hey clawsuu"
    private var errorCount = 0
    private var restartJob: Runnable? = null

    // Always use Activity context when available — required on newer Android
    private fun getCtx() = reactContext.currentActivity ?: reactContext

    private fun buildIntent(partial: Boolean = false, maxResults: Int = 3): Intent {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxResults)
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
        if (partial) intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        return intent
    }

    @ReactMethod
    fun start(phrase: String, promise: Promise) {
        wakePhrase = phrase.ifBlank { "hey clawsuu" }.lowercase().trim()
        running = true
        errorCount = 0
        Log.d("WakeWord", "start() phrase='$wakePhrase'")
        handler.post { startListening() }
        promise.resolve(true)
    }

    @ReactMethod
    fun stop(promise: Promise) {
        running = false
        errorCount = 0
        restartJob?.let { handler.removeCallbacks(it) }
        handler.post {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun recognize(promise: Promise) {
        Log.d("WakeWord", "recognize() via Activity intent")
        val activity = reactContext.currentActivity
        if (activity is MainActivity) {
            activity.startSpeechRecognition(promise)
        } else {
            promise.reject("error", "Activity not available")
        }
    }

    @ReactMethod
    fun test(promise: Promise) {
        Log.d("WakeWord", "test() - emitting wakeWordDetected")
        emitEvent("wakeWordDetected", null)
        promise.resolve(true)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun startListening() {
        if (!running) return

        // Kill previous recognizer cleanly before creating a new one
        try { recognizer?.cancel() } catch (_: Exception) {}
        try { recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null

        recognizer = SpeechRecognizer.createSpeechRecognizer(getCtx())

        emitDebug("listening", "")
        recognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { emitDebug("ready", "") }
            override fun onBeginningOfSpeech() { emitDebug("heard", "") }
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { emitDebug("end", "") }
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val top = matches?.firstOrNull() ?: ""
                if (top.isNotBlank()) emitDebug("partial", top)
                checkResults(matches)
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val top = matches?.firstOrNull() ?: ""
                emitDebug("result", top)
                errorCount = 0  // reset on success
                checkResults(matches)
                scheduleRestart(300)
            }

            override fun onError(error: Int) {
                val msg = errorName(error)
                Log.d("WakeWord", "onError: $msg (count=$errorCount)")
                emitDebug("error", msg)
                // error 5 = "client" = Speech Recognition service not available on device
                // Stop retrying immediately — it will never work without Google services
                if (error == 5) {
                    Log.e("WakeWord", "Speech Recognition not available (client error) — wake word disabled")
                    emitDebug("unavailable", "Speech Recognition not available on this device")
                    stopListening()
                    return
                }
                // errors 6/7 = no speech/no match — normal, reset error count
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
                        // Exponential backoff: 2s, 4s, 8s, 16s, cap 30s
                        val delay = minOf(2000L * (1L shl (errorCount - 1)), 30_000L)
                        scheduleRestart(delay)
                    }
                }
            }
        })
        recognizer?.startListening(buildIntent(partial = true, maxResults = 3))
    }

    private fun errorName(code: Int) = when (code) {
        1 -> "network timeout"
        2 -> "network"
        3 -> "audio"
        4 -> "server"
        5 -> "client"
        6 -> "no speech"
        7 -> "no match"
        8 -> "busy"
        9 -> "no permission"
        else -> "err$code"
    }

    private fun emitEvent(name: String, payload: WritableMap?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, payload)
    }

    private fun emitDebug(state: String, text: String) {
        val payload = Arguments.createMap().apply {
            putString("state", state)
            putString("text", text)
        }
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("wakeWordDebug", payload)
    }

    private fun checkResults(matches: List<String>?) {
        if (matches == null) return
        for (match in matches) {
            if (match.lowercase().contains(wakePhrase)) {
                Log.i("WakeWord", "WAKE: '$match'")
                emitEvent("wakeWordDetected", null)
                break
            }
        }
    }

    private fun scheduleRestart(delayMs: Long) {
        if (!running) return
        restartJob?.let { handler.removeCallbacks(it) }
        val job = Runnable { startListening() }
        restartJob = job
        handler.postDelayed(job, delayMs)
    }
}
