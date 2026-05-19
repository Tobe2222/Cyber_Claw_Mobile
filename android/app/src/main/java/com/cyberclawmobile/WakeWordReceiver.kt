package com.cyberclawmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * WakeWordReceiver - Triggered when background service detects wake word
 */
class WakeWordReceiver : BroadcastReceiver() {
  
  companion object {
    private const val TAG = "WakeWordReceiver"
  }
  
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent?.action == "com.cyberclawmobile.WAKE_WORD_DETECTED") {
      Log.d(TAG, "Received wake word broadcast")
      
      try {
        if (context != null) {
          val launchIntent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
            putExtra("show_wake_mode", true)
          }
          
          context.startActivity(launchIntent)
          Log.d(TAG, "Started MainActivity with wake mode")
        }
      } catch (e: Exception) {
        Log.e(TAG, "Error starting activity: ${e.message}", e)
      }
    }
  }
}
