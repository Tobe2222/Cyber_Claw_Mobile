package com.cyberclawmobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

  companion object {
    const val SPEECH_REQUEST_CODE = 42
    var speechPromise: Promise? = null
  }

  override fun getMainComponentName(): String = "CyberClawMobile"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    checkWakeIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    checkWakeIntent(intent)
  }

  // v3.1.79: also re-emit the wake event on onResume. The
  // original onCreate / onNewIntent path runs
  // emitWakeOpenedWithRetry, but if the React Native JS
  // context is still loading (cold start from the lock
  // screen notification) the event can be dropped after
  // 5s. By the time onResume fires, the JS context is
  // definitely up, so a second emit reliably reaches the
  // App.tsx listener. Belt-and-suspenders against the
  // "wake word fires while phone is locked, app opens to
  // home instead of wake mode" bug. The intent extra is
  // cleared on the first checkWakeIntent, so this only
  // fires for the wake that originally opened the
  // activity — subsequent onResume calls (e.g. user
  // pulling down the notification drawer without saying
  // the wake word) won't re-fire.
  override fun onResume() {
    super.onResume()
    // Only re-emit if the first emit hasn't already
    // succeeded. App.tsx clears the wake-pending flag in
    // AsyncStorage when the event reaches the listener, so
    // we re-check the flag here. If it's still set, the
    // first emit was dropped (or is still in its retry
    // loop). We don't want to fire AFTER the user has
    // exited Wake Mode, so we only act on onResume if the
    // flag is still set.
    if (pendingWakeEmit) {
      // Check the flag in a thread-safe way. If the JS
      // side already cleared it, our first emit succeeded
      // and we should NOT re-emit (which would yank the
      // user back to Wake Mode after they exited).
      val prefs = getSharedPreferences("wake_state", MODE_PRIVATE)
      val flagStillSet = prefs.getBoolean("wake_pending", false)
      pendingWakeEmit = false
      if (flagStillSet) {
        emitWakeOpenedWithRetry(0)
      }
    }
  }

  private fun checkWakeIntent(intent: Intent?) {
    if (intent?.getBooleanExtra("from_wake_word", false) == true) {
      // Clear the extra so subsequent onNewIntent calls (e.g. from
      // bringToForeground re-ordering) don't re-fire the wake event.
      intent.removeExtra("from_wake_word")
      // v3.1.79: also arm the onResume retry. The
      // emitWakeOpenedWithRetry in this method is best-
      // effort; if the JS context is still loading the
      // event is dropped. onResume fires AFTER the JS
      // context is up, so we re-emit there as a
      // belt-and-suspenders against the
      // "wake-while-locked → opens to home" bug.
      pendingWakeEmit = true
      // Set a flag in SharedPreferences so onResume can
      // tell whether the first emit succeeded. App.tsx
      // clears the flag when the event reaches the
      // listener. We re-check in onResume; if the flag is
      // still set, the first emit was dropped and we
      // re-emit. If it was cleared, the user has
      // already seen (and possibly exited) Wake Mode and
      // we must not yank them back.
      //
      // v3.1.86: also stamp the flag with the current
      // time. The JS side (App.tsx checkNativePending)
      // uses the timestamp to distinguish fresh flags
      // (from a real wake event in this session) from
      // stale flags (persisted across an app kill). A
      // stale flag used to cause spurious wake-mode
      // entry on cold launch.
      getSharedPreferences("wake_state", MODE_PRIVATE)
        .edit()
        .putBoolean("wake_pending", true)
        .putLong("wake_pending_at", System.currentTimeMillis())
        .apply()
      // Post-delayed so React context is ready, and retry if context is not
      // ready yet (cold start can take longer than 600ms on some devices).
      emitWakeOpenedWithRetry(0)
    }
  }

  // v3.1.79: set by checkWakeIntent, cleared on onResume
  // after re-emitting. volatile because onResume runs on
  // the UI thread and checkWakeIntent can be called from
  // either onCreate (UI thread) or onNewIntent (UI thread),
  // but we want the read in onResume to see the write from
  // checkWakeIntent without any synchronization surprises
  // if either path is ever moved to a background thread.
  @Volatile private var pendingWakeEmit: Boolean = false

  private fun emitWakeOpenedWithRetry(attempt: Int) {
    val maxAttempts = 20
    val delayMs = 250L
    window.decorView.postDelayed({
      try {
        val reactContext: ReactContext? = reactInstanceManager?.currentReactContext
        if (reactContext != null) {
          reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("wakeWordOpenedApp", null)
          // v3.1.79: success — clear the wake-pending flag
          // we set in checkWakeIntent, so onResume knows
          // NOT to re-emit. Without this, onResume would
          // re-emit and yank the user back to Wake Mode
          // after they exited.
          //
          // v3.1.86: also clear the timestamp so a stale
          // timestamp from a prior session can't combine
          // with a freshly-set flag to confuse the JS
          // side.
          getSharedPreferences("wake_state", MODE_PRIVATE)
            .edit()
            .putBoolean("wake_pending", false)
            .putLong("wake_pending_at", 0L)
            .apply()
        } else if (attempt < maxAttempts) {
          // Context not ready (cold start) — try again
          emitWakeOpenedWithRetry(attempt + 1)
        }
      } catch (_: Exception) {
        if (attempt < maxAttempts) emitWakeOpenedWithRetry(attempt + 1)
      }
    }, delayMs)
  }

  // Called by WakeWordModule to launch the speech intent
  fun startSpeechRecognition(promise: Promise) {
    speechPromise = promise
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak now...")
    }
    try {
      startActivityForResult(intent, SPEECH_REQUEST_CODE)
    } catch (e: Exception) {
      speechPromise?.reject("error", e.message)
      speechPromise = null
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == SPEECH_REQUEST_CODE) {
      if (resultCode == Activity.RESULT_OK) {
        val results = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        val text = results?.firstOrNull() ?: ""
        speechPromise?.resolve(text)
      } else {
        speechPromise?.reject("cancelled", "Speech cancelled")
      }
      speechPromise = null
    }
  }
}
