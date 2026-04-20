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
        Log.d("WakeWord", "start() phrase='$wakePhrase'")
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
        Log.d("WakeWord", "recognize() one-shot")
        handler.post {
            val wasRunning = running
            running = false
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null

            val oneShot = SpeechRecognizer.createSpeechRecognizer(getCtx())
            oneShot.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(p: Bundle?) { emitDebug("mic-ready", "") }
                override fun onBeginningOfSpeech() { emitDebug("mic-heard", "") }
                override fun onRmsChanged(r: Float) {}
                override fun onBufferReceived(b: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(t: Int, p: Bundle?) {}
                override fun onPartialResults(r: Bundle?) {}
                override fun onResults(results: Bundle?) {
                    val text = results
                        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull() ?: ""
                    Log.d("WakeWord", "recognize result: '$text'")
                    oneShot.destroy()
                    promise.resolve(text)
                    if (wasRunning) { running = true; startListening() }
                }
                override fun onError(error: Int) {
                    val msg = errorName(error)
                    Log.w("WakeWord", "recognize error: $msg")
                    emitDebug("mic-error", msg)
                    oneShot.destroy()
                    promise.reject("error", msg)
                    if (wasRunning) { running = true; startListening() }
                }
            })
            oneShot.startListening(buildIntent(partial = false, maxResults = 1))
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

        recognizer?.cancel()
        recognizer?.destroy()
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
                checkResults(matches)
                scheduleRestart(300)
            }

            override fun onError(error: Int) {
                val msg = errorName(error)
                Log.d("WakeWord", "onError: $msg")
                emitDebug("error", msg)
                // errors 6/7 = no speech / no match — normal cycling, restart quickly
                scheduleRestart(if (error == 6 || error == 7) 200L else 1000L)
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
        handler.postDelayed({ startListening() }, delayMs)
    }
}
