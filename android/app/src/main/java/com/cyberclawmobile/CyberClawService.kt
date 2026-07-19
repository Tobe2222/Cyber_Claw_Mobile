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
        const val EXTRA_PHRASE = "wake_phrase"
        const val DEFAULT_PHRASE = "hey clawsuu"
    }

    private var voskModel: Model? = null
    private var audioRecord: AudioRecord? = null
    private var listenThread: Thread? = null
    @Volatile private var wakeListening = false
    private val handler = Handler(Looper.getMainLooper())
    private var wakePhrase = DEFAULT_PHRASE

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        wakePhrase = intent?.getStringExtra(EXTRA_PHRASE) ?: DEFAULT_PHRASE
        try {
            val notif = buildNotification("CyberClaw", "Listening for wake word...")
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

        return START_NOT_STICKY  // do NOT restart if killed; user must explicitly start
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // User swiped app away from recents — stop the service too
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
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
            // v3.10.60: bootstrap speaker enrollment from
            // the BG audio stream. We push every PCM chunk
            // into EnrollmentAudioProcessor.processAudio,
            // which buffers and emits 1280-sample chunks
            // to the embedding-only detector. Voice-active
            // chunks accumulate into the profile. Without
            // this, the profile only ever grows from the
            // OWW thread's chunks — which never run if
            // the user never opened voice mode.
            val enrollment = EnrollmentAudioProcessor.getInstance(applicationContext)
            while (wakeListening) {
                val read = rec.read(buf, 0, buf.size)
                if (read <= 0) continue
                // Push to enrollment pipeline. Cheap (melspec
                // + embedding only, no classifier inference).
                enrollment.processAudio(buf, read)
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
        // v3.10.4: stricter threshold for the BG service.
        // The PhoneticMatcher default (0.55) was tuned for
        // shorter wake phrases like "hey jarvis" and
        // mistakenly fires on partial Vosk transcripts like
        // "hey" alone for a 2-word target like "hey
        // clawsuu" — avgScore for heard="hey" / target=
        // "hey clawsuu" is (1.0 + 0.14) / 2 = 0.57, just
        // above 0.55, which is what Tobe hit on v3.10.3: he
        // got repeated false wake triggers after training
        // a unique phrase, because Vosk would emit "hey"
        // whenever anyone nearby spoke, and the matcher
        // would say MATCH. 0.7 keeps room for genuine fuzzy
        // matches (typos, mid-word sounds) but rejects
        // single-word partials.
        //
        // We also require the heard text to contain AT
        // LEAST the same number of word tokens as the
        // target (modulo one — "hey claws" with target
        // "hey clawsuu" still passes via 5/7 Levenshtein),
        // so a single "hey" can't match "hey clawsuu".
        if (PhoneticMatcher.matches(text, wakePhrase, threshold = 0.7)) {
            val heardWords = text.split(Regex("\\s+")).filter { it.isNotBlank() }
            val targetWords = wakePhrase.split(Regex("\\s+")).filter { it.isNotBlank() }
            // Allow up to N-1 missing tokens (the OWW /
            // PhoneticMatcher is forgiving for prefix
            // matches). Disallow 0 tokens (rare in this
            // truthy-short-text case but worth a guard).
            if (heardWords.size >= targetWords.size - 1 && heardWords.isNotEmpty()) {
                Log.d("CyberClawService", "Wake phrase detected in service: $text")
                // v3.10.60: speaker gate. If a profile is
                // locked AND the recent audio doesn't match
                // the enrolled speaker, suppress the wake.
                // Returns false if no profile is set yet (the
                // system has to work before it can learn),
                // which is the right default for new users.
                val enrollment = EnrollmentAudioProcessor.getInstance(applicationContext)
                if (enrollment.shouldSuppressWake()) {
                    val score = enrollment.getMatchScore() ?: 0f
                    Log.i("CyberClawService", "Vosk wake suppressed by speaker gate (match=${"%.2f".format(score)} < 0.50)")
                    return
                }
                // Wake is genuine — bump the confirmed-wake
                // counter so the profile can lock faster.
                enrollment.markConfirmedWake()
                handler.post { openApp() }
            }
        }
    }

    private fun openApp() {
        // 1. Send local broadcast — WakeReceiver can start activity when phone is unlocked
        //    (Broadcast receivers are exempt from background activity launch restrictions
        //    when the app has a recent task in memory)
        val broadcastIntent = Intent(WakeReceiver.ACTION_WAKE).apply {
            setPackage(packageName)
        }
        sendBroadcast(broadcastIntent)

        // 2. Also fire a high-priority notification for lock screen / GrapheneOS
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            putExtra("from_wake_word", true)
        } ?: return

        val pendingIntent = PendingIntent.getActivity(
            this, 99, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, "cyberclaw_wake")
            .setContentTitle("Wake word detected! 🎤")
            .setContentText("Opening CyberClaw...")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(1002, notif)

        updateNotification("CyberClaw", "Listening for wake word...")
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
