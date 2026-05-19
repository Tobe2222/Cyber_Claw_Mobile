# Always-Listening Background Service Plan

## Goal
When user enables "Always Listening":
- ✅ App runs even when closed
- ✅ Listens for wake word continuously
- ✅ Phone can be locked
- ✅ When wake word detected:
  - Opens app
  - Goes directly to Wake Word Mode
  - Wake Word Mode becomes lock screen background
  - User can interact immediately

## Current State
- ✅ Wake word training works (audio samples + DTW matching)
- ✅ Wake word testing works (6s auto-stop)
- ❌ No background listening when app closed
- ❌ No automatic wake on detection
- ❌ No lock screen override

## Architecture Needed

```
┌─────────────────────────────────────────┐
│        Phone Startup                    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Check: "Always Listening" enabled?     │
│  (via SharedPreferences)                │
└──────────────┬──────────────────────────┘
               │
        Yes    │    No
               │
         ┌─────┴─────┐
         ▼           ▼
      [START]      [IDLE]
    BACKGROUND   (normal)
     SERVICE
         │
         ▼
┌─────────────────────────────────────────┐
│  BackgroundListeningService             │
│  - Request audio focus                  │
│  - Load wake word training data         │
│  - Start recording continuously         │
│  - Extract audio features               │
│  - Run DTW matching on chunks           │
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │  Listen     │
        │  Loop       │
        │  (5min      │
        │   chunks)   │
        │             │
        ▼             │
┌──────────────────┐  │
│ Match > 65%?     │  │
└──┬────────────┬──┘  │
   │ YES   NO  │      │
   │          │       │
   │ ┌────────┘       │
   │ │               │
   ▼ ▼               │
┌──────────────────┐  │
│ WAKE DETECTED!   │  │
└──────┬───────────┘  │
       │              │
       ▼              │
┌──────────────────────────────┐
│ 1. Wake AppControl service   │
│ 2. Unlock screen if locked   │
│ 3. Bring to foreground       │
│ 4. Show Wake Word Mode       │
│ 5. Ready for voice command   │
└──────────────────────────────┘
       │
       └─────────────┐
                     │
                     ▼
              [Listen to user]
```

## Implementation Steps

### Phase 1: Background Service (Android)

**New File:** `android/app/src/main/java/com/cyberclawmobile/WakeWordBackgroundService.kt`

```kotlin
class WakeWordBackgroundService : Service() {
  
  // Constants
  private val CHUNK_SIZE = 16000 * 5  // 5 seconds
  private val THRESHOLD = 0.65f
  
  // Components
  private lateinit var audioRecorder: AudioRecord
  private lateinit var matcher: AudioSampleMatcher
  private var isListening = false
  
  override fun onCreate() {
    super.onCreate()
    // Initialize audio recorder
    // Load wake word training data
    // Start listening loop
  }
  
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startListening()
    return START_STICKY  // Restart if killed
  }
  
  fun startListening() {
    // Start background thread
    // Loop: record 5s chunk → extract features → match
    // If match > threshold: trigger wake
  }
  
  private fun triggerWake() {
    // Send broadcast to wake main app
    // Or use AppControl.bringToForeground()
  }
}
```

### Phase 2: App Startup Hook

**File:** `android/app/src/main/java/com/cyberclawmobile/MainActivity.kt`

```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
  super.onCreate(savedInstanceState)
  
  // Check if "Always Listening" is enabled
  val prefs = getSharedPreferences("cyberclaw", Context.MODE_PRIVATE)
  val alwaysListening = prefs.getBoolean("always-listening", false)
  
  if (alwaysListening && !isServiceRunning(WakeWordBackgroundService::class.java)) {
    startService(Intent(this, WakeWordBackgroundService::class.java))
  }
}
```

### Phase 3: Lock Screen Wake

**Challenge:** Wake main app and show on lock screen

**Approaches:**

1. **KeyguardManager + WindowManager (Requires permissions)**
   ```kotlin
   val keyguardManager = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
   val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
   
   // Disable lock screen
   keyguardManager.requestDismissKeyguard(this)
   
   // Show activity on top of lock screen
   addFlags(FLAG_SHOW_WHEN_LOCKED or FLAG_TURN_SCREEN_ON)
   ```

2. **Broadcast + Receiver (Cleaner)**
   ```
   WakeWordBackgroundService
      ├─> Detects wake word
      ├─> Sends broadcast "WAKE_DETECTED"
      │
   WakeWordReceiver
      ├─> Receives broadcast
      ├─> Calls AppControl.bringToForeground()
      ├─> MainActivity sets flags to show on lock screen
      │
   MainActivity
      ├─> onReceive: WAKE_DETECTED
      ├─> Launch WakeWordMode directly
      ├─> Show fullscreen on lock screen
   ```

### Phase 4: UI Integration

**File:** `src/screens/SettingsScreen.tsx`

```typescript
<Switch
  value={alwaysListening}
  onValueChange={async (val) => {
    setAlwaysListening(val);
    
    if (val) {
      // Save training data to file (not just AsyncStorage)
      // Start background service
      await AsyncStorage.setItem('cyberclaw-always-listening', 'true');
      if (NativeModules.BackgroundService) {
        await NativeModules.BackgroundService.enable();
      }
    } else {
      // Stop background service
      await NativeModules.BackgroundService.disable();
    }
  }}
/>
```

### Phase 5: Data Persistence

**Challenge:** AsyncStorage not available to background service

**Solution:** Save training data to file

```typescript
// When user trains, also save to file:
const trainingJson = {
  phrase: "hey clawsuu",
  samples: 3,
  quality: 0.91,
  features: [...],  // Array of audio features
  trainedAt: "2026-05-18T..."
};

// Save to app-specific files directory
const path = `${RNFS.DocumentDirectoryPath}/wake-training.json`;
await RNFS.writeFile(path, JSON.stringify(trainingJson));

// Background service reads from this file
```

## Permissions Needed

**Android Manifest:**
```xml
<!-- Audio Recording -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />

<!-- Continue running in background -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />

<!-- Wake up from lock screen -->
<uses-permission android:name="android.permission.DISABLE_KEYGUARD" />
<uses-permission android:name="android.permission.WAKE_LOCK" />

<!-- Show notifications for service -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

## Challenges & Solutions

### 1. Battery Drain
**Problem:** Continuous recording drains battery

**Solutions:**
- Use VAD (Voice Activity Detection) to only record when sound detected
- Record in chunks (5min) with silence detection
- Stop after 10min of no activity
- User can set time windows (e.g., 6am-midnight)

### 2. Microphone Conflicts
**Problem:** Another app using microphone

**Solutions:**
- Request audio focus
- Fallback to listening only when available
- Show notification if interrupted

### 3. Data Sync
**Problem:** Training data in AsyncStorage, service needs files

**Solutions:**
- Save training to both AsyncStorage AND file
- Sync when app opens
- Check modification time to use latest

### 4. Service Killed by System
**Problem:** Android might kill service

**Solutions:**
- Use FOREGROUND_SERVICE (shows persistent notification)
- START_STICKY flag for restart
- WorkManager for scheduled wake-up

## Timeline

- **Week 1:** Phase 1 (Background Service skeleton)
- **Week 2:** Phase 2-3 (App startup + lock screen wake)
- **Week 4:** Phase 4-5 (UI + data persistence)
- **Week 5:** Testing on real devices

## Success Criteria

✅ App closed, phone locked
✅ Say "hey clawsuu"
✅ Phone wakes (screen on)
✅ App opens
✅ Shows Wake Word Mode
✅ Ready for voice command
✅ No manual tap needed

---

## Notes

- This is complex system-level work
- Requires Android native development
- Needs thorough testing on different devices
- Battery testing critical
- May need permissions prompt on first enable

## Next Steps

1. Create `WakeWordBackgroundService.kt` skeleton
2. Test it can record audio in background
3. Implement matching logic
4. Add app wake-up logic
5. Test with real wake word
6. Optimize battery usage
7. Test on locked screen

---

*This plan outlines the path to always-listening wake word mode. Start with Phase 1 to validate the approach.*
