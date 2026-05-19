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
import org.json.JSONObject
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
    private const val CHUNK_DURATION_MS = 5000  // 5 seconds per chunk
    private const val THRESHOLD = 0.65f
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
  }
  
  private var isListening = false
  private var audioRecord: AudioRecord? = null
  private var listeningThread: Thread? = null
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var prefs: SharedPreferences
  
  // Training data
  private var trainingData: JSONObject? = null
  private var trainingPhrase = ""
  
  override fun onCreate() {
    super.onCreate()
    Log.d(TAG, "Service created")
    prefs = getSharedPreferences("cyberclaw", Context.MODE_PRIVATE)
  }
  
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "Service started")
    
    // Load training data from file
    if (!loadTrainingData()) {
      Log.e(TAG, "Failed to load training data, stopping")
      stopSelf()
      return START_NOT_STICKY
    }
    
    // Start listening in background thread
    startListening()
    
    return START_STICKY  // Restart if killed by system
  }
  
  private fun loadTrainingData(): Boolean {
    try {
      // Try to load from file first
      val trainingFile = File(filesDir, "wake-training.json")
      
      if (trainingFile.exists()) {
        val content = trainingFile.readText()
        trainingData = JSONObject(content)
        trainingPhrase = trainingData?.getString("phrase") ?: "hey clawsuu"
        Log.d(TAG, "Loaded training from file: $trainingPhrase")
        return true
      }
      
      // Fallback: check if stored in preferences (won't work directly, but try)
      val trainingJson = prefs.getString("cyberclaw-wake-training", null)
      if (trainingJson != null) {
        trainingData = JSONObject(trainingJson)
        trainingPhrase = trainingData?.getString("phrase") ?: "hey clawsuu"
        Log.d(TAG, "Loaded training from prefs: $trainingPhrase")
        return true
      }
      
      Log.w(TAG, "No training data found")
      return false
    } catch (e: Exception) {
      Log.e(TAG, "Error loading training data", e)
      return false
    }
  }
  
  private fun startListening() {
    if (isListening) return
    
    Log.d(TAG, "Starting background listening")
    isListening = true
    
    listeningThread = Thread {
      try {
        // Initialize audio recorder
        val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        audioRecord = AudioRecord(
          MediaRecorder.AudioSource.MIC,
          SAMPLE_RATE,
          CHANNEL_CONFIG,
          AUDIO_FORMAT,
          bufferSize
        )
        
        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
          Log.e(TAG, "Failed to initialize AudioRecord")
          stopSelf()
          return@Thread
        }
        
        audioRecord?.startRecording()
        Log.d(TAG, "AudioRecord started, listening for wake word")
        
        // Listening loop
        listeningLoop(bufferSize)
        
      } catch (e: Exception) {
        Log.e(TAG, "Error in listening thread", e)
        stopSelf()
      } finally {
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        Log.d(TAG, "Audio recorder stopped")
      }
    }
    
    listeningThread?.start()
  }
  
  private fun listeningLoop(bufferSize: Int) {
    val chunkSize = SAMPLE_RATE * CHUNK_DURATION_MS / 1000  // samples for 5s
    val audioBuffer = ShortArray(chunkSize)
    var totalSamples = 0
    var chunkCount = 0
    
    Log.d(TAG, "Listening loop started (chunk size: $chunkSize samples)")
    
    while (isListening && audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
      // Record chunk
      val samplesRead = audioRecord?.read(audioBuffer, totalSamples % chunkSize, chunkSize - (totalSamples % chunkSize)) ?: 0
      
      if (samplesRead <= 0) {
        Thread.sleep(100)
        continue
      }
      
      totalSamples += samplesRead
      
      // Process every 5 seconds
      if (totalSamples >= chunkSize) {
        chunkCount++
        Log.d(TAG, "Chunk $chunkCount: Processing ${totalSamples} samples")
        
        // Extract features from chunk
        val features = extractAudioFeatures(audioBuffer)
        
        // Check if matches training
        if (features != null && shouldTriggerWake(features)) {
          Log.w(TAG, "WAKE WORD DETECTED!")
          triggerWake()
          // Continue listening, but add cooldown
          Thread.sleep(2000)  // 2 second cooldown to avoid multiple triggers
        }
        
        totalSamples = 0
      }
      
      // Prevent busy-waiting
      if (samplesRead < chunkSize - (totalSamples % chunkSize)) {
        Thread.sleep(50)
      }
    }
  }
  
  private fun extractAudioFeatures(audioBuffer: ShortArray): FloatArray? {
    try {
      // Simple energy calculation (placeholder for full feature extraction)
      var energy = 0.0f
      for (sample in audioBuffer) {
        val normalized = sample / 32768.0f
        energy += normalized * normalized
      }
      energy /= audioBuffer.size
      energy = Math.sqrt(energy.toDouble()).toFloat()
      
      // Return array with energy (TODO: add ZCR and other features)
      return floatArrayOf(energy)
    } catch (e: Exception) {
      Log.e(TAG, "Error extracting features", e)
      return null
    }
  }
  
  private fun shouldTriggerWake(features: FloatArray?): Boolean {
    if (features == null || features.isEmpty()) return false
    
    // Placeholder: check if energy above threshold
    // TODO: Implement full DTW matching with training features
    
    val energy = features[0]
    val threshold = 0.1f  // Noise threshold
    
    if (energy > threshold) {
      Log.d(TAG, "Audio detected (energy: $energy)")
      return true  // For now, trigger on any detected audio
    }
    
    return false
  }
  
  private fun triggerWake() {
    Log.d(TAG, "Triggering wake sequence")
    
    try {
      // Send broadcast to app
      val intent = Intent("com.cyberclawmobile.WAKE_WORD_DETECTED")
      intent.setPackage(packageName)
      sendBroadcast(intent)
      Log.d(TAG, "Broadcast sent")
      
      // Try to bring app to foreground
      val appControl = context?.let {
        try {
          val serviceClass = Class.forName("com.cyberclawmobile.AppControl")
          val method = serviceClass.getMethod("bringToForeground")
          method.invoke(null)
          true
        } catch (e: Exception) {
          Log.e(TAG, "Could not invoke AppControl", e)
          false
        }
      }
      
      Log.d(TAG, "Wake triggered successfully")
    } catch (e: Exception) {
      Log.e(TAG, "Error triggering wake", e)
    }
  }
  
  override fun onDestroy() {
    Log.d(TAG, "Service destroyed")
    isListening = false
    audioRecord?.stop()
    audioRecord?.release()
    listeningThread?.join(1000)
    super.onDestroy()
  }
  
  override fun onBind(intent: Intent?): IBinder? {
    return null  // Not bindable
  }
}
