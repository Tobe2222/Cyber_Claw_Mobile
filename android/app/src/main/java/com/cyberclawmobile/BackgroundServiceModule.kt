package com.cyberclawmobile

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.*

class BackgroundServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "BackgroundService"

    @ReactMethod
    fun start(phrase: String, promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, CyberClawService::class.java).apply {
                putExtra(CyberClawService.EXTRA_PHRASE, phrase.ifBlank { CyberClawService.DEFAULT_PHRASE })
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactApplicationContext.startForegroundService(intent)
            } else {
                reactApplicationContext.startService(intent)
            }
            promise.resolve(true)
        } catch (e: SecurityException) {
            try {
                reactApplicationContext.startService(Intent(reactApplicationContext, CyberClawService::class.java))
                promise.resolve(false)
            } catch (e2: Exception) {
                promise.reject("SERVICE_ERROR", e2.message)
            }
        } catch (e: Exception) {
            promise.reject("SERVICE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, CyberClawService::class.java)
            reactApplicationContext.stopService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("SERVICE_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isRunning(promise: Promise) {
        promise.resolve(CyberClawService.isRunning)
    }
}
