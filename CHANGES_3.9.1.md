# v3.9.1 — Hotfix: Voice mode re-triggers right after exit

Tobe: "tested newest version. Did a wake trigger. Exited voice,
but right after i exited the voice mode, it triggered again out
of nowhere, like an exit bug after first opening of voice mode
or something"

## Root cause

`App.tsx`'s `handleWake` (the listener for `wakeWordDetected` /
`wakeWordOpenedApp` from the legacy Vosk pipeline) was missing
the `isWakeJustExited()` 5-second guard that v3.5.2 added to
`HomeScreen.handleWakeWord` (the `owwWakeDetected` listener for
the TFLite pipeline).

The race:

1. Voice mode opens. Both detectors listening in parallel:
   - **Foreground OWW** (TFLite) — runs through the JS bridge,
     emits `owwWakeDetected` → `HomeScreen.handleWakeWord` (has
     the v3.5.2 guard)
   - **Background Vosk** (CyberClawService) — runs as a
     foreground service with its own `AudioRecord`, uses
     Vosk STT + `PhoneticMatcher` against the wake phrase.
     When it matches, it calls `openApp()` which sends a
     local broadcast → `WakeReceiver` → `MainActivity.
     checkWakeIntent` → emits `wakeWordOpenedApp` →
     `App.tsx.handleWake` (NO guard)
2. User says the exit phrase → `owwExitDetected` (or the STT
   text-fallback `matchExitPhrase`) → `exitRef.current()` →
   `onExit` → `markWakeJustExited()` (sets 5s window) →
   awaits `cyberclaw-wake-pending` flag clear → `setScreen(
   'home')`.
3. HomeScreen mounts → `startBgService()` starts (or keeps
   running) `CyberClawService`. Both detectors now active.
4. CyberClawService's Vosk recognizer is STILL processing
   the tail end of the exit-phrase audio. The user's exit
   phrase ("hey thanks so much", "hey that's all", etc.)
   often contains "hey" + a vowel cluster.
5. Vosk produces a partial like `"hey tha"` →
   `PhoneticMatcher.matches("hey tha", "hey clawsuu",
   threshold=0.55)`:
   - `"hey"` vs `"hey"` → similarity 1.0
   - `"tha"` vs `"clawsuu"` → similarity 0; consonant
     skeleton `"th"` vs `"clws"` → similarity 0.2 × 0.9 = 0.18
   - `avgScore = (1.0 + 0.18) / 2 = 0.59` **≥ 0.55 → MATCH**
6. `CyberClawService.openApp()` → local broadcast →
   `WakeReceiver` (registered in the manifest with the
   temporary 10s exemption window for background activity
   launches) → `MainActivity.startActivity` → since
   MainActivity is already foreground, Android delivers
   this via `onNewIntent` → `checkWakeIntent` →
   `emitWakeOpenedWithRetry(0)` → `wakeWordOpenedApp`
   event.
7. `App.tsx`'s `wakeOpenSub` listener fires → `handleWake()` →
   `setScreen('voice-mode')` → **voice mode re-opens**.

The v3.5.2 fix (`markWakeJustExited` / `isWakeJustExited`) was
applied to `HomeScreen.handleWakeWord` only, because that was
the only listener that had been observed re-opening voice mode
under test. The `App.tsx` listener chain
(`wakeSub` for `wakeWordDetected`, `wakeOpenSub` for
`wakeWordOpenedApp`, `checkNativePending` for the cold-launch
flag fallback) was not audited at the same time.

## Fix

Three call sites in `App.tsx` now respect the just-exited
guard:

1. **`handleWake`** (the shared handler for both `wakeWordDetected`
   and `wakeWordOpenedApp` listeners) — bail early if
   `isWakeJustExited()` is true.
2. **`checkNativePending`** (the cold-launch flag fallback
   that fires `handleWake` when a fresh `wake_pending`
   flag is found in SharedPreferences) — same guard, plus
   defensive `clearWakePending()` so a subsequent
   wake-pending read returns clean state.
3. **`isWakeJustExited`** is now imported from HomeScreen
   alongside `markWakeJustExited`.

```js
const handleWake = () => {
  if (isWakeJustExited()) {
    console.log('[App] Wake detected but just exited — ignoring');
    return;
  }
  AsyncStorage.setItem('cyberclaw-wake-pending', '1').catch(() => {});
  setScreen('voice-mode');
};
```

```js
const checkNativePending = async () => {
  if (!WakeWordModule?.isWakePending) return;
  if (screenRef.current !== 'home') return;
  if (isWakeJustExited()) {
    console.log('[App] Native wake-pending flag seen but just exited — ignoring');
    clearWakePending();
    return;
  }
  // ...rest unchanged
};
```

## Files touched

- `App.tsx` — import `isWakeJustExited`; guard `handleWake`
  and `checkNativePending`
- `android/app/build.gradle` — versionCode 224 → 225,
  versionName 3.9.0 → 3.9.1
- `package.json` — version 3.9.0 → 3.9.1
- `CHANGES_3.9.1.md` (this file)

## What to test (Tobe)

1. Update to v3.9.1 (build APK from `.github/workflows/
   build.yml` v3.9.1 tag, or local install).
2. Open the app, trigger wake.
3. Voice mode opens.
4. Say the exit phrase (e.g. "thanks", or whatever you've
   trained).
5. Voice mode closes.
6. **Wait — voice mode should NOT re-open.**
7. Repeat several times. The race window is small (Vosk has
   ~1s of buffered audio around exit), so it might take a
   few tries to verify the fix doesn't fire when the bug
   used to.

If you can also test with an exit phrase that starts with
"hey" (e.g. "hey, that's all thanks"), that's the most
likely trigger for the bug — the Vosk partial "hey tha"
matches "hey clawsuu" via the PhoneticMatcher threshold of
0.55. After the fix it should still bail.

## Lesson

Whenever you add a guard at one of N parallel listeners for
the same user-facing action, audit the other N-1 listeners
and add the guard there too. Listeners are easy to forget
because they're scattered across files. A "guard the
action, not the listener" pattern (e.g. `safeHandleWake()`
wrapper that all listeners call) makes this kind of
fix-by-omission impossible.