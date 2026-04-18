package com.cyberclawmobile

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import android.app.NotificationChannel
import android.app.NotificationManager

/**
 * WakeWordService — runs in background, listens for wake phrase using on-device SpeechRecognizer.
 * When detected, sends a broadcast that MainActivity/AppControlModule handles to bring app forward.
 *
 * Starts/stops via WakeWordModule (JS bridge).
 */
class WakeWordService : Service() {

    companion object {
        const val TAG = "WakeWordService"
        const val ACTION_WAKE = "com.cyberclawmobile.WAKE_WORD_DETECTED"
        const val EXTRA_PHRASE = "phrase"
        const val NOTIF_ID = 2
        const val CHANNEL_ID = "cyberclaw_wake"
        var wakePhrase: String = "hey clawsuu"
    }

    private var recognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var restartDelay = 500L

    override fun onCreate() {
        super.onCreate()
        createNotifChannel()
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CyberClaw listening")
            .setContentText("Say \"$wakePhrase\" to wake")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        wakePhrase = intent?.getStringExtra(EXTRA_PHRASE) ?: wakePhrase
        if (!running) { running = true; startListening() }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotifChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Wake Word", NotificationManager.IMPORTANCE_MIN)
            ch.description = "Listens for wake phrase in background"
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
        }
    }

    private fun startListening() {
        if (!running || !SpeechRecognizer.isRecognitionAvailable(this)) {
            Log.w(TAG, "Speech recognition not available")
            return
        }
        handler.post {
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(this)
            recognizer?.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onPartialResults(partialResults: Bundle?) {
                    val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    checkMatches(matches)
                }
                override fun onResults(results: Bundle?) {
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    checkMatches(matches)
                    // Restart listening after results
                    scheduleRestart(restartDelay)
                }
                override fun onError(error: Int) {
                    Log.d(TAG, "Recognizer error: $error")
                    // Restart on most errors (7=no match, 6=no speech — normal)
                    scheduleRestart(if (error == 7 || error == 6) 200L else 1000L)
                }
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 0L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            }
            recognizer?.startListening(intent)
        }
    }

    private fun checkMatches(matches: List<String>?) {
        if (matches == null) return
        val phrase = wakePhrase.lowercase().trim()
        for (match in matches) {
            if (match.lowercase().contains(phrase)) {
                Log.i(TAG, "Wake word detected: $match")
                val broadcast = Intent(ACTION_WAKE).apply {
                    `package` = packageName
                }
                sendBroadcast(broadcast)
                break
            }
        }
    }

    private fun scheduleRestart(delayMs: Long) {
        if (!running) return
        handler.postDelayed({ startListening() }, delayMs)
    }
}
