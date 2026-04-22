package com.cyberclawmobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.view.WindowManager
import com.facebook.react.bridge.*

class AppControlModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "AppControl"

    /**
     * Bring app to foreground / wake screen — used when wake word is detected
     */
    @ReactMethod
    fun bringToForeground(promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity ?: return promise.reject("NO_ACTIVITY", "No activity")
            activity.runOnUiThread {
                // Wake screen and bring app over lock screen
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    activity.setShowWhenLocked(true)
                    activity.setTurnScreenOn(true)
                } else {
                    @Suppress("DEPRECATION")
                    activity.window.addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    )
                }
                // Bring to front
                val intent = Intent(activity, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                activity.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /**
     * Keep screen on while app is active (for lock screen companion mode)
     */
    @ReactMethod
    fun keepScreenOn(enabled: Boolean, promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity ?: return promise.reject("NO_ACTIVITY", "No activity")
            activity.runOnUiThread {
                if (enabled) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /**
     * Show app over lock screen (Dream/always-on display mode)
     */
    @ReactMethod
    fun showOnLockScreen(enabled: Boolean, promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity ?: return promise.reject("NO_ACTIVITY", "No activity")
            activity.runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    activity.setShowWhenLocked(enabled)
                } else {
                    if (enabled) {
                        @Suppress("DEPRECATION")
                        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
                    } else {
                        @Suppress("DEPRECATION")
                        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
                    }
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    /**
     * Show app on lock screen with keyguard dismiss (companion visible, PIN overlay on top)
     */
    @ReactMethod
    fun showOnLockScreenWithDismiss(promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity ?: return promise.reject("NO_ACTIVITY", "No activity")
            activity.runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    activity.setShowWhenLocked(true)
                    activity.setTurnScreenOn(true)
                    val km = activity.getSystemService(android.app.KeyguardManager::class.java)
                    km?.requestDismissKeyguard(activity, object : android.app.KeyguardManager.KeyguardDismissCallback() {
                        override fun onDismissSucceeded() {} // user unlocked — companion stays visible
                        override fun onDismissCancelled() {} // user cancelled — still visible behind keyguard
                        override fun onDismissError() {}
                    })
                } else {
                    @Suppress("DEPRECATION")
                    activity.window.addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                    )
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
}
