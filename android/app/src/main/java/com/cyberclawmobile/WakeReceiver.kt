package com.cyberclawmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives wake word broadcast from CyberClawService and launches MainActivity.
 * BroadcastReceivers can start activities on Android 10+ when the app has a visible window
 * or the receiver is registered in the manifest (not background-restricted like Services).
 */
class WakeReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_WAKE = "com.cyberclawmobile.ACTION_WAKE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            putExtra("from_wake_word", true)
        } ?: return
        context.startActivity(launch)
    }
}
