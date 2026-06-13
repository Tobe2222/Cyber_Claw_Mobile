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

  private fun checkWakeIntent(intent: Intent?) {
    if (intent?.getBooleanExtra("from_wake_word", false) == true) {
      // Clear the extra so subsequent onNewIntent calls (e.g. from
      // bringToForeground re-ordering) don't re-fire the wake event.
      intent.removeExtra("from_wake_word")
      // Post-delayed so React context is ready
      window.decorView.postDelayed({
        try {
          val reactContext: ReactContext? = reactInstanceManager?.currentReactContext
          reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit("wakeWordOpenedApp", null)
        } catch (_: Exception) {}
      }, 600)
    }
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
