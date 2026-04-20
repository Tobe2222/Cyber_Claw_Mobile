package com.cyberclawmobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  companion object {
    const val SPEECH_REQUEST_CODE = 42
    var speechPromise: Promise? = null
  }

  override fun getMainComponentName(): String = "CyberClawMobile"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

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
