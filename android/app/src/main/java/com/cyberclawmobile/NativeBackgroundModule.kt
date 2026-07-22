package com.cyberclawmobile

import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactApplicationContext
import android.util.Log
import android.widget.Toast
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.AudioFormat
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.os.Build
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import kotlin.concurrent.thread

/**
 * Simple native module for background listening
 * Minimal implementation to test integration
 */
class NativeBackgroundModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "NativeBackground"
    private const val SAMPLE_RATE = 16000
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    // v3.10.70: notification channel for companion
    // replies. Separate from the BG-listening and wake
    // channels so the user can mute chat notifications
    // independently.
    private const val CHAT_CHANNEL_ID = "cyberclaw_chat"
  }

  private var isListening = false
  private var audioRecord: AudioRecord? = null
  private var listeningThread: Thread? = null
  
  override fun getName(): String = "NativeBackground"

  /**
   * Test method - shows Toast to confirm module works
   */
  @com.facebook.react.bridge.ReactMethod
  fun test() {
    Log.d(TAG, "test() called!")
    Handler(Looper.getMainLooper()).post {
      Toast.makeText(reactContext, "✅ Native Bridge Works!", Toast.LENGTH_SHORT).show()
    }
  }

  /**
   * Show a Toast notification from JS
   */
  @com.facebook.react.bridge.ReactMethod
  fun showToast(message: String) {
    Log.d(TAG, "showToast: $message")
    Handler(Looper.getMainLooper()).post {
      Toast.makeText(reactContext, message, Toast.LENGTH_SHORT).show()
    }
  }

  /**
   * v3.10.70: post a system notification for a
   * companion reply. JS decides when to call this
   * (only when the user isn't actively looking at
   * the chat for that companion). Title is the
   * companion's name + emoji; body is a truncated
   * preview of the reply text. Tapping the
   * notification launches the app to the home
   * screen (the existing chat-tap logic in
   * CyberClawService handles foreground state).
   *
   * Uses a separate channel `cyberclaw_chat` so
   * the user can mute chat notifications without
   * affecting the BG-listening / wake channels.
   */
  @com.facebook.react.bridge.ReactMethod
  fun notifyCompanionReply(agentName: String, text: String, promise: com.facebook.react.bridge.Promise) {
    try {
      val nm = reactContext.getSystemService(NotificationManager::class.java)
        ?: throw IllegalStateException("NotificationManager not available")

      // Channel created lazily on first call so
      // pre-v3.10.70 installs that never call this
      // method don't see the channel at all.
      val channel = NotificationChannel(
        CHAT_CHANNEL_ID,
        "Companion replies",
        NotificationManager.IMPORTANCE_DEFAULT,
      ).apply {
        description = "Notifications when a companion replies while you're not in chat"
        enableVibration(true)
      }
      nm.createNotificationChannel(channel)

      // Tap intent — bring the app to foreground.
      val launchIntent = reactContext.packageManager
        .getLaunchIntentForPackage(reactContext.packageName)
        ?: Intent(reactContext, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      val pendingIntent = PendingIntent.getActivity(
        reactContext, 2001, launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

      // Truncate preview so the notification fits in
      // the standard 1-2 lines of body text on
      // Android 12+ (max ~150 chars before Android
      // ellipsizes).
      val preview = if (text.length > 140) text.substring(0, 137) + "…" else text

      val notif = NotificationCompat.Builder(reactContext, CHAT_CHANNEL_ID)
        .setContentTitle("$agentName replied")
        .setContentText(preview)
        .setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentIntent(pendingIntent)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .build()
      // Unique ID per companion so multiple replies
      // stack instead of replacing. Use a stable hash
      // of the agent name so rapid replies from the
      // same companion overwrite each other (most
      // recent wins) but different companions keep
      // their own notifications.
      val notifId = 2000 + agentName.hashCode().and(0x7FFFFFFF) % 1000
      nm.notify(notifId, notif)
      promise.resolve(true)
    } catch (e: Exception) {
      Log.w(TAG, "notifyCompanionReply failed: ${e.message}")
      promise.reject("NOTIFY_FAILED", e.message)
    }
  }

  /**
   * Start listening for audio in background
   */
  @com.facebook.react.bridge.ReactMethod
  fun startListening() {
    if (isListening) {
      Log.d(TAG, "Already listening")
      return
    }
    
    Log.d(TAG, "Starting background listening")
    isListening = true
    
    listeningThread = thread {
      try {
        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        audioRecord = AudioRecord(
          MediaRecorder.AudioSource.MIC,
          SAMPLE_RATE,
          CHANNEL_CONFIG,
          AUDIO_FORMAT,
          bufferSize
        )
        
        audioRecord?.startRecording()
        Log.d(TAG, "Recording started")
        
        val audioBuffer = ShortArray(bufferSize)
        var chunkCount = 0
        
        while (isListening) {
          val samplesRead = audioRecord?.read(audioBuffer, 0, bufferSize) ?: 0
          
          if (samplesRead > 0) {
            chunkCount++
            val energy = calculateEnergy(audioBuffer, samplesRead)
            Log.d(TAG, "Chunk $chunkCount: Energy = $energy")
            
            // Simple detection: if energy > threshold, log it
            if (energy > 0.1f) {
              Log.d(TAG, "⚡ Audio detected! Energy: $energy")
            }
          } else {
            Thread.sleep(100)
          }
        }
        
      } catch (e: Exception) {
        Log.e(TAG, "Error in listening thread", e)
      } finally {
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        Log.d(TAG, "Recording stopped")
      }
    }
  }

  /**
   * Stop listening for audio
   */
  @com.facebook.react.bridge.ReactMethod
  fun stopListening() {
    Log.d(TAG, "Stopping listening")
    isListening = false
    listeningThread?.join(1000)
    Log.d(TAG, "Listening stopped")
  }

  /**
   * Bring the app to the front, even over the lock screen.
   * Called when wake word is detected in background.
   */
  @com.facebook.react.bridge.ReactMethod
  fun bringToFront() {
    Log.d(TAG, "bringToFront called")
    val context = reactContext.applicationContext
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
               Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
               Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra("wake_word_triggered", true)
    } ?: return
    context.startActivity(intent)

    // On API 27+ use window flags to show over lock screen
    Handler(Looper.getMainLooper()).postDelayed({
      reactContext.currentActivity?.let { activity ->
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
        // Dismiss keyguard if allowed
        val km = activity.getSystemService(android.content.Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          km?.requestDismissKeyguard(activity, null)
        }
        Log.d(TAG, "Lock screen flags applied")
      }
    }, 200)
  }


  /**
   * Check whether SYSTEM_ALERT_WINDOW and USE_FULL_SCREEN_INTENT are granted.
   * Returns a map: { canDrawOverlays: Boolean, canUseFullScreenIntent: Boolean }
   */
  @com.facebook.react.bridge.ReactMethod
  fun checkWakePermissions(promise: com.facebook.react.bridge.Promise) {
    try {
      val canDraw = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M)
        android.provider.Settings.canDrawOverlays(reactContext) else true
      val canFsi = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
        (reactContext.getSystemService(android.app.NotificationManager::class.java))?.canUseFullScreenIntent() ?: true
      else true
      val map = com.facebook.react.bridge.Arguments.createMap().apply {
        putBoolean("canDrawOverlays", canDraw)
        putBoolean("canUseFullScreenIntent", canFsi)
      }
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("ERROR", e.message)
    }
  }

  /**
   * Open system settings for SYSTEM_ALERT_WINDOW (draw over other apps)
   */
  @com.facebook.react.bridge.ReactMethod
  fun openOverlaySettings(promise: com.facebook.react.bridge.Promise) {
    try {
      val intent = android.content.Intent(
        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        android.net.Uri.parse("package:${reactContext.packageName}")
      ).apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ERROR", e.message)
    }
  }

  /**
   * Open system settings for USE_FULL_SCREEN_INTENT (Android 14+)
   */
  @com.facebook.react.bridge.ReactMethod
  fun openFullScreenIntentSettings(promise: com.facebook.react.bridge.Promise) {
    try {
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val intent = android.content.Intent(
          android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
          android.net.Uri.parse("package:${reactContext.packageName}")
        ).apply { addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK) }
        reactContext.startActivity(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ERROR", e.message)
    }
  }

  /**
   * Calculate RMS energy of audio chunk
   */
  private fun calculateEnergy(buffer: ShortArray, samplesRead: Int): Float {
    return try {
      var energy = 0.0f
      for (i in 0 until samplesRead) {
        val normalized = buffer[i] / 32768.0f
        energy += normalized * normalized
      }
      energy /= samplesRead
      Math.sqrt(energy.toDouble()).toFloat()
    } catch (e: Exception) {
      Log.e(TAG, "Error calculating energy", e)
      0f
    }
  }
}
