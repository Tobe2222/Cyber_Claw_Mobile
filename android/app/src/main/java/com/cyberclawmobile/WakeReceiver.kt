package com.cyberclawmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Receives wake word broadcast from CyberClawService and launches MainActivity.
 *
 * Android 10+ blocks background activity launches from Services, but BroadcastReceivers
 * registered in the manifest have a temporary exemption window (~10s) to startActivity.
 * We also use SYSTEM_ALERT_WINDOW (canDrawOverlays) as the primary path — it bypasses
 * the background launch restriction entirely.
 */
class WakeReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_WAKE = "com.cyberclawmobile.ACTION_WAKE"
        private const val TAG = "WakeReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        Log.d(TAG, "Wake broadcast received — attempting to bring app to front")

        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            )
            putExtra("from_wake_word", true)
        } ?: run {
            Log.e(TAG, "No launch intent found")
            return
        }

        // Primary path: SYSTEM_ALERT_WINDOW grants background activity launch exemption
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(context)) {
            Log.d(TAG, "canDrawOverlays=true — launching directly")
            context.startActivity(launch)
            return
        }

        // Fallback: manifest-registered BroadcastReceiver has a short exemption window
        Log.d(TAG, "canDrawOverlays=false — trying fallback startActivity")
        try {
            context.startActivity(launch)
        } catch (e: Exception) {
            Log.e(TAG, "startActivity failed: ${e.message}")
        }
    }
}
