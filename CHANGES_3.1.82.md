# v3.1.82

## Persistent wake-pending flag — fix wake-from-lock-screen → home race

Tobe: "wake word opens to home screen still" — v3.1.79's
onResume retry wasn't enough on its own.

### The race

When the user says the wake word while the phone is locked:

1. CyberClawService (foreground) detects the wake word
2. Service calls `openApp()` → sends `WakeReceiver` broadcast
   + fires a fullscreen notification with `PendingIntent`
3. MainActivity comes to front with `from_wake_word=true`
4. `checkWakeIntent` calls `emitWakeOpenedWithRetry(0)`,
   which polls every 250ms × 20 = 5s for the React Native
   JS context to be ready
5. On success, emits `wakeWordOpenedApp` to JS
6. App.tsx listener calls `setScreen('wake-mode')`

The v3.1.79 fix added a second emit on `onResume` as
belt-and-suspenders. But there's still a failure mode: if
the JS context is **never** ready within the 5s emit-retry
budget AND the user dismisses the activity before onResume
fires (or the React tree crashed during init), the event
is dropped. The AsyncStorage-based `cyberclaw-wake-pending`
fallback in App.tsx doesn't help either — that flag is
**set by JS** in `handleWake`, so if the listener never
fires, the flag is never set, and the fallback has nothing
to recover.

### The fix

**Set the pending flag in native code (Kotlin → SharedPreferences),
not in JS.** Read it from JS via a new bridge method. The flag
survives process death, JS context crashes, and the listener-not-
ready-yet race.

New methods on `WakeWordModule`:
- `isWakePending(): Promise<boolean>` — reads the native flag
- `clearWakePending(): Promise<boolean>` — clears it

`MainActivity.checkWakeIntent` sets the flag (in addition to
scheduling the emit). `emitWakeOpenedWithRetry` clears it on
success. v3.1.79's onResume retry still works (it checks the
same flag).

`App.tsx` now calls `isWakePending()` on mount and on every
`AppState=active`. If the flag is set, it clears it and calls
`handleWake()` — bringing the user to Wake Mode regardless of
whether the original event was successfully delivered.

### Why this is correct in all the cases that were broken

**Case 1: cold start, JS context up within 5s**
- Kotlin: flag set, emit fires successfully, flag cleared
- JS: listener catches, setScreen runs
- checkNativePending on mount: flag is false, no-op
- ✅ Works

**Case 2: cold start, JS context NOT up within 5s, user
re-foregrounds**
- Kotlin: flag set, first emit exhausts retries, flag stays
  set, onResume retry fires, JS context up by now, emit
  succeeds, flag cleared
- JS: listener catches, setScreen runs
- ✅ Works (this was v3.1.79's fix)

**Case 3: cold start, JS context NEVER up, user kills the app**
- Kotlin: flag set, emits all fail
- User kills and reopens
- App.tsx mounts, checkNativePending reads flag = true
- handleWake runs, setScreen('wake-mode')
- ✅ Works (v3.1.82 fix)

**Case 4: in foreground, user says wake word**
- WakeWordModule.Vosk fires `wakeWordDetected` to JS
- App.tsx listener catches, setScreen runs
- Native flag is NOT set in this path (we only set it in
  MainActivity.checkWakeIntent, which is the from-background
  path)
- checkNativePending: flag is false, no-op
- ✅ Works (was already working, unchanged)

### Files

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — new `isWakePending()` / `clearWakePending()` methods
- `App.tsx` — `checkNativePending()` reads the native flag on
  mount + AppState=active; `clearWakePending()` clears it via
  the bridge
- `package.json` — 3.1.81 → 3.1.82
- `android/app/build.gradle` — versionCode 131 → 132
- `.github/workflows/{build,android-build}.yml` — artifact
  names
