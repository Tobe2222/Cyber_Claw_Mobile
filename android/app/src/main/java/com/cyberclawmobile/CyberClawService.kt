package com.cyberclawmobile

import android.app.*
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File

class CyberClawService : Service() {

    companion object {
        const val CHANNEL_ID = "cyberclaw_bg"
        const val NOTIF_ID = 1001
        var isRunning = false
        const val WAKE_PHRASE = "hey claw"
    }

    private var voskModel: Model? = null
    private var audioRecord: AudioRecord? = null
    private var listenThread: Thread? = null
    @Volatile private var wakeListening = false
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val notif = buildNotification("CyberClaw", "Listening for \"Hey Claw\"...")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (e: Exception) {
            try { startForeground(NOTIF_ID, buildNotification("CyberClaw", "Running")) } catch (_: Exception) {}
        }

        // Start Vosk wake word in background thread
        Thread { initAndListen() }.also { it.isDaemon = true; it.start() }

        return START_STICKY
    }

    private fun initAndListen() {
        val modelDir = File(filesDir, "vosk-model-small-en")
        if (!File(modelDir, "am/final.mdl").exists()) {
            Log.d("CyberClawService", "Vosk model not ready yet, skipping wake word in service")
            return
        }
        try {
            voskModel = Model(modelDir.absolutePath)
            startWakeListening()
        } catch (e: Exception) {
            Log.e("CyberClawService", "Vosk init failed", e)
        }
    }

    private fun startWakeListening() {
        wakeListening = true
        val sampleRate = 16000
        val bufferSize = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(4096)

        val model = voskModel ?: return
        val recognizer = Recognizer(model, sampleRate.toFloat())

        val rec = AudioRecord(
            android.media.MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize
        )
        audioRecord = rec
        rec.startRecording()

        listenThread = Thread {
            val buf = ShortArray(bufferSize / 2)
            val byteBuf = ByteArray(bufferSize)
            while (wakeListening) {
                val read = rec.read(buf, 0, buf.size)
                if (read <= 0) continue
                for (i in 0 until read) {
                    byteBuf[i * 2] = (buf[i].toInt() and 0xFF).toByte()
                    byteBuf[i * 2 + 1] = (buf[i].toInt() shr 8 and 0xFF).toByte()
                }
                val json = if (recognizer.acceptWaveForm(byteBuf, read * 2)) {
                    recognizer.result
                } else {
                    recognizer.partialResult
                }
                checkWakeWord(json)
            }
            recognizer.close()
        }.also { it.isDaemon = true; it.start() }
    }

    private fun checkWakeWord(json: String) {
        val text = Regex("\"(text|partial)\"\\s*:\\s*\"([^\"]+)\"")
            .find(json)?.groupValues?.get(2)?.lowercase() ?: return
        if (text.isBlank()) return
        if (PhoneticMatcher.matches(text, WAKE_PHRASE)) {
            Log.d("CyberClawService", "Wake phrase detected in service: $text")
            handler.post { openApp() }
        }
    }

    private fun openApp() {
        // Use ACTION_MAIN + CATEGORY_LAUNCHER — best chance of bypassing background launch restrictions
        val intent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            putExtra("from_wake_word", true)
        } ?: Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("from_wake_word", true)
        }

        val pendingIntent = PendingIntent.getActivity(
            this, 99, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Try direct start — works if screen on and app was recently used
        try { startActivity(intent) } catch (_: Exception) {}

        // High-priority wake notification on dedicated IMPORTANCE_HIGH channel
        // This makes full-screen intent actually fire (GrapheneOS needs IMPORTANCE_HIGH + CATEGORY_ALARM)
        val notif = NotificationCompat.Builder(this, "cyberclaw_wake")
            .setContentTitle("Hey Claw heard! 🐾")
            .setContentText("Tap to open CyberClaw")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(1002, notif)

        updateNotification("CyberClaw", "Listening for \"Hey Claw\"...")
    }

    private fun stopWakeListening() {
        wakeListening = false
        listenThread?.interrupt()
        listenThread = null
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        stopWakeListening()
        voskModel?.close()
        voskModel = null
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(title, text))
    }

    fun buildNotification(title: String, text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Persistent foreground service notification — silent, no badge
            val bgChannel = NotificationChannel(
                CHANNEL_ID,
                "CyberClaw Background",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Listening for wake phrase in background"
                setShowBadge(false)
            }
            // Wake alert channel — high priority, makes full-screen intent fire
            val wakeChannel = NotificationChannel(
                "cyberclaw_wake",
                "CyberClaw Wake Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Wake word detected alerts"
                enableLights(true)
                enableVibration(true)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(bgChannel)
            nm.createNotificationChannel(wakeChannel)
        }
    }
}
