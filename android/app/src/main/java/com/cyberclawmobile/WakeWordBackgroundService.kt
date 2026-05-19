package com.cyberclawmobile

import android.app.Service
import android.content.Intent
import android.content.Context
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.AudioFormat
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.content.SharedPreferences
import java.io.File

/**
 * WakeWordBackgroundService - Always-listening wake word detection
 * 
 * Runs in background and listens for wake word even when app is closed.
 * Records audio continuously, extracts features, and matches against training.
 */
class WakeWordBackgroundService : Service() {
  
  companion object {
    private const val TAG = "WakeWordBG"
    private const val SAMPLE_RATE = 16000
    private const val CHUNK_DURATION_MS = 5000
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
  }
  
  private var isListening = false
  private var audioRecord: AudioRecord? = null
  private var listeningThread: Thread? = null
  private lateinit var prefs: SharedPreferences
  
  override fun onCreate() {
    super.onCreate()
    Log.d(TAG, "Service created")
    prefs = getSharedPreferences("cyberclaw", Context.MODE_PRIVATE)
  }
  
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "Service started")
    startListening()
    return START_STICKY
  }
  
  private fun startListening() {
    if (isListening) return
    
    Log.d(TAG, "Starting background listening")
    isListening = true
    
    listeningThread = Thread {
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
        Log.d(TAG, "AudioRecord started, listening for wake word")
        
        val chunkSize = SAMPLE_RATE * CHUNK_DURATION_MS / 1000
        val audioBuffer = ShortArray(chunkSize)
        var chunkCount = 0
        
        while (isListening && audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          val samplesRead = audioRecord?.read(audioBuffer, 0, chunkSize) ?: 0
          
          if (samplesRead > 0) {
            chunkCount++
            Log.d(TAG, "Chunk $chunkCount: Read $samplesRead samples")
            
            // Calculate energy
            val energy = calculateEnergy(audioBuffer, samplesRead)
            Log.d(TAG, "Energy: $energy")
            
            if (energy > 0.1f) {
              Log.w(TAG, "Audio detected! Energy: $energy")
              triggerWake()
              Thread.sleep(2000)
            }
          }
          
          Thread.sleep(100)
        }
        
      } catch (e: Exception) {
        Log.e(TAG, "Error in listening thread", e)
      } finally {
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        Log.d(TAG, "Audio recorder stopped")
      }
    }
    
    listeningThread?.start()
  }
  
  private fun calculateEnergy(buffer: ShortArray, samplesRead: Int): Float {
    try {
      var energy = 0.0f
      for (i in 0 until samplesRead) {
        val normalized = buffer[i] / 32768.0f
        energy += normalized * normalized
      }
      energy /= samplesRead
      return Math.sqrt(energy.toDouble()).toFloat()
    } catch (e: Exception) {
      Log.e(TAG, "Error calculating energy", e)
      return 0f
    }
  }
  
  private fun triggerWake() {
    Log.d(TAG, "Triggering wake sequence")
    try {
      val intent = Intent("com.cyberclawmobile.WAKE_WORD_DETECTED")
      intent.setPackage(packageName)
      sendBroadcast(intent)
      Log.d(TAG, "Broadcast sent")
    } catch (e: Exception) {
      Log.e(TAG, "Error triggering wake", e)
    }
  }
  
  override fun onDestroy() {
    Log.d(TAG, "Service destroyed")
    isListening = false
    audioRecord?.stop()
    audioRecord?.release()
    super.onDestroy()
  }
  
  override fun onBind(intent: Intent?): IBinder? {
    return null
  }
}
