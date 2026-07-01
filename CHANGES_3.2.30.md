# v3.2.30

## Fix: wake word firing repeatedly during ambient conversation (loop bug)

**Symptom:** Tobe reported that while talking with a coworker
on the Home Screen, the wake word detector fired repeatedly
and rapidly, opening Voice Mode in a tight loop. Retraining
the wake word didn't help.

**Root cause:** three bugs in the OWW wake detector stack,
all interacting:

1. **Native threshold ignored.** The OWW listening loop in
   `WakeWordModule.kt` checked `if (score >= 0.5f)` with a
   hardcoded `0.5f`, even though the detector's `threshold`
   field was set to whatever the JS layer passed to
   `initOww`. So `setThreshold(0.55)` was a no-op as far
   as the listening loop was concerned — the detector
   would fire on 50% confidence regardless of the
   caller's threshold.

2. **JS threshold not threaded through.** The HomeScreen
   `startSampleMatchListener` accepted a `threshold`
   parameter and used it to update logs, but the actual
   `WakeWordModule?.initOww?.('hey_jarvis', 0.5)` call
   hardcoded `0.5` instead of using the parameter. So
   the foreground/background thresholds configured in
   Settings → 🎤 Wake Word had zero effect on what the
   native detector would do.

3. **No cooldown after detection.** When the OWW
   listening loop hit `HIGH_SCORE_RUN` (3 consecutive
   frames above threshold), it emitted
   `owwWakeDetected` and then reset `highScoreFrames = 0`
   — but the audio above-threshold continued, so the
   next frame immediately started counting back up to
   `HIGH_SCORE_RUN` again. A single 2-3 second burst
   of "hey" (or any speech the OWW model thinks sounds
   like the wake word) would fire 2-3 wake events. With
   the busy-flag reset happening between Voice Mode
   open/close cycles, the result was the "loop" Tobe
   saw: OWW fires → Voice Mode opens → silence timeout
   → Voice Mode closes → busy reset → OWW fires again.

## Fix

All three bugs fixed in one release.

### Native (`WakeWordModule.kt`)

- **Use the detector's threshold.** The OWW loop now
  reads `detector.getThreshold()` (a new getter — see
  below) and compares against that instead of the
  hardcoded `0.5f`. So when the JS layer calls
  `setThreshold(0.55)`, the listening loop honors it.

- **Detection cooldown.** New `DETECTION_COOLDOWN_MS =
  2000L` (2 seconds). After a successful detection
  emission, subsequent detections are silently dropped
  until the cooldown window expires. The high-score
  counter is reset cleanly on every cooldown-suppressed
  detection so the detector re-arms properly when the
  cooldown expires.

- **Debug logging on suppression.** When a detection is
  suppressed by the cooldown, log a `Log.w` line so the
  user can see in logcat why the wake word "didn't
  fire" (commonly: a real wake followed too quickly by
  ambient speech that also matched).

### Native (`OpenWakeWordDetector.kt`)

- **New `getThreshold()` getter.** The OWW listening
  loop needs to read the current threshold so it can
  compare against the same value `predict()` uses
  internally. Without this, the loop and the
  `predict()` method would have different views of
  "what is the threshold", and a
  `setThreshold(0.55)` followed by a call to
  `predictScore(pcm) > 0.5f` would still fire on
  anything above 0.5.

### JS (`HomeScreen.tsx`)

- **Thread the threshold through.** `WakeWordModule?.initOww?.('hey_jarvis', threshold ?? 0.5)`
  instead of the hardcoded `0.5`. Same pattern as
  `WakeModeScreen.tsx` already used (which was correct
  all along — only HomeScreen had the bug).

## What this changes for the user

- **Foreground/background thresholds now actually
  work.** Settings → 🎤 Wake Word → Foreground match
  threshold and Background match threshold control
  real detector behavior. Default 55% / 65% are still
  lenient; bump to 70% / 80% if you're getting false
  positives on ambient conversation.

- **The "loop" is gone.** A 2-second cooldown after
  each detection means even if the audio continues to
  match the wake word, you only get one wake event per
  2 seconds. The detector re-arms after the cooldown
  so legitimate follow-up wake events still work.

- **The bundled `hey_jarvis` model still fires on
  anything that sounds like "hey" or "jarvis"** at the
  configured threshold. If you want a more selective
  wake word, train a custom one (🎤 Wake Word → "Train
  wake phrase" — the trained model hot-swaps into the
  same OWW detector and uses the same threshold).

## Files

**Modified:**

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:
  - OWW loop reads `detector.getThreshold()` instead of
    hardcoded `0.5f`.
  - 2-second detection cooldown.
  - `Log.w` on cooldown-suppressed detections.

- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt`:
  - New `getThreshold()` getter.

- `src/screens/HomeScreen.tsx`:
  - `initOww` now uses `threshold ?? 0.5` (mirrors
    `WakeModeScreen.tsx` which was already correct).

- `package.json`:
  - Version bump 3.2.29 → 3.2.30.

- `android/app/build.gradle`:
  - versionCode 175 → 176, versionName "3.2.29" →
    "3.2.30".

**Unchanged:**

- `src/screens/WakeModeScreen.tsx` — already used
  `threshold ?? 0.5` correctly. No change needed.
- `src/screens/SettingsScreen.tsx` — threshold
  controls unchanged. The values it saves to
  AsyncStorage now actually affect the detector.
- All wake training code — custom-trained models
  hot-swap into the same detector and use the same
  threshold, so they get the cooldown + threshold
  fix for free.

## Out of scope

- The pre-existing TypeScript parse warning at
  `HomeScreen.tsx` line 2524 (pre-edit number) —
  unrelated, not caused by these changes.
- Per-companion wake words with custom-trained
  models — the next step but requires the desktop
  training pipeline to be ported to support
  per-companion routing.
- Voice-activity gating (don't run the OWW loop
  while the user is in a known-silent state like a
  phone call). Future work.
