package com.cyberclawmobile

import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactApplicationContext
import android.util.Log
import android.widget.Toast

/**
 * Simple native module for background listening
 * Minimal implementation to test integration
 */
class NativeBackgroundModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "NativeBackground"
    const val NAME = "NativeBackground"
  }

  override fun getName(): String = NAME

  /**
   * Test method - just logs to confirm module works
   */
  @com.facebook.react.bridge.ReactMethod
  fun test() {
    Log.d(TAG, "NativeBackground.test() called!")
    Toast.makeText(reactApplicationContext, "✅ Native Bridge Works!", Toast.LENGTH_SHORT).show()
  }
}
