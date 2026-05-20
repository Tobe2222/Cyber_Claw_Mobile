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
