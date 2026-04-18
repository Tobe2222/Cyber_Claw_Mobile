package com.cyberclawmobile

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.*

class BackgroundServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "BackgroundService"

    @ReactMethod
    fun start(promise: Promise) {
        try {
            // Check RECORD_AUDIO before starting with mic type
            val intent = Intent(reactApplicationContext, CyberClawService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactApplicationContext.startForegroundService(intent)
            } else {
                reactApplicationContext.startService(intent)
            }
            promise.resolve(true)
        } catch (e: SecurityException) {
            // Permission not granted yet — start without foreground
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
