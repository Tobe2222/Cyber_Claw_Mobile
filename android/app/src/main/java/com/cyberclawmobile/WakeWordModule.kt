package com.cyberclawmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class WakeWordModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "WakeWordModule"

    private var receiver: BroadcastReceiver? = null

    @ReactMethod
    fun start(phrase: String, promise: Promise) {
        try {
            WakeWordService.wakePhrase = phrase.ifBlank { "hey clawsuu" }
            val intent = Intent(reactContext, WakeWordService::class.java).apply {
                putExtra(WakeWordService.EXTRA_PHRASE, WakeWordService.wakePhrase)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
            registerReceiver()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WAKE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, WakeWordService::class.java))
            unregisterReceiver()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("WAKE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {}
    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun registerReceiver() {
        if (receiver != null) return
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == WakeWordService.ACTION_WAKE) {
                    // Fire JS event
                    reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("wakeWordDetected", null)
                }
            }
        }
        val filter = IntentFilter(WakeWordService.ACTION_WAKE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactContext.registerReceiver(receiver, filter)
        }
    }

    private fun unregisterReceiver() {
        receiver?.let { reactContext.unregisterReceiver(it) }
        receiver = null
    }
}
