package com.cyberclawmobile

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.content.Intent
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    // Required for NativeEventEmitter on the JS side
    override fun getConstants(): Map<String, Any> = mapOf(
        "WAKE_DETECTED" to "wakeWordDetected",
        "WAKE_DEBUG"    to "wakeWordDebug"
    )

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
    fun recognize(promise: Promise) {
        // One-shot recognition — pauses wake word listener, records once, resolves with text
        Log.d("WakeWord", "recognize() one-shot")
        handler.post {
            val wasRunning = running
            running = false
            recognizer?.cancel()
            recognizer?.destroy()

            val ctx = reactContext.currentActivity ?: reactContext
            if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
                promise.reject("unavailable", "Speech recognition not available")
                return@post
            }

            val oneShot = SpeechRecognizer.createSpeechRecognizer(ctx)
            oneShot.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(p: Bundle?) { emitDebug("mic-ready", "") }
                override fun onBeginningOfSpeech() { emitDebug("mic-heard", "") }
                override fun onRmsChanged(r: Float) {}
                override fun onBufferReceived(b: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(t: Int, p: Bundle?) {}
                override fun onPartialResults(r: Bundle?) {}
                override fun onResults(results: Bundle?) {
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = matches?.firstOrNull() ?: ""
                    Log.d("WakeWord", "recognize result: $text")
                    oneShot.destroy()
                    promise.resolve(text)
                    // Restart continuous listener if it was running
                    if (wasRunning) { running = true; startListening() }
                }
                override fun onError(error: Int) {
                    oneShot.destroy()
                    promise.reject("error", "Recognition error $error")
                    if (wasRunning) { running = true; startListening() }
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
            oneShot.startListening(intent)
        }
    }

    @ReactMethod
    fun test(promise: Promise) {
        Log.d("WakeWord", "test() called - emitting wakeWordDetected")
        emitEvent("wakeWordDetected", null)
        promise.resolve(true)
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun startListening() {
        if (!running) return
        val ctx = reactContext.currentActivity ?: reactContext
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            Log.w("WakeWord", "Speech recognition not available")
            emitDebug("error", "not available")
            return
        }

        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(ctx)

        emitDebug("listening", "")
        recognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                Log.d("WakeWord", "Ready")
                emitDebug("ready", "")
            }
            override fun onBeginningOfSpeech() { emitDebug("heard", "...") }
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { emitDebug("end", "") }
            override fun onEvent(eventType: Int, params: Bundle?) {}

            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val top = matches?.firstOrNull() ?: ""
                emitDebug("partial", top)
                checkResults(matches)
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val top = matches?.firstOrNull() ?: ""
                emitDebug("result", top)
                checkResults(matches)
                scheduleRestart(300)
            }

            override fun onError(error: Int) {
                val msg = when(error) {
                    1 -> "network timeout" 2 -> "network" 3 -> "audio" 4 -> "server"
                    5 -> "client" 6 -> "no speech" 7 -> "no match" 8 -> "busy"
                    9 -> "insufficient perms" else -> "err$error"
                }
                Log.d("WakeWord", "Error: $msg")
                emitDebug("error", msg)
                scheduleRestart(if (error == 6 || error == 7) 100L else 800L)
            }
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, reactContext.packageName)
        recognizer?.startListening(intent)
    }

    private fun emitEvent(name: String, payload: WritableMap?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, payload)
    }

    private fun emitDebug(state: String, text: String) {
        val payload = com.facebook.react.bridge.Arguments.createMap().apply {
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
                Log.i("WakeWord", "Wake detected: $match")
                emitEvent("wakeWordDetected", null)
                break
            }
        }
    }

    private fun scheduleRestart(delayMs: Long) {
        if (!running) return
        handler.postDelayed({ startListening() }, delayMs)
    }
}
