# v3.1.79

## Three things: auto-retrain for normal samples, false-open detection, wake-while-locked fix

### 1. Auto-retrain for normal samples

Tobe: "I did not see a retrain button for normal samples. That
should automatically use better samples which is retrained to
replace worse samples."

When the user records a new NORMAL sample and we already have
3 normal samples for the phrase, compare the new sample's DTW
quality to the worst existing normal sample. If the new sample
is meaningfully more consistent (>= 0.05 better avg-DTW with
the others), silently replace the worst with the new one. The
user sees: "Auto-replaced Normal sample #2 (old: 65% → new:
78%)".

Only NORMAL is auto-retrained. Loud / whisper / short /
elongated have intentional acoustic differences — replacing
them based on similarity would erase the diversity the user
explicitly trained. The whole point of the style system is
that the user can record a quiet version AND a loud version,
and the matcher accepts both.

Implementation: `WakeTrainingModel.ts` `autoRetrainNormal()`,
called from `SampleTrainer.tsx` after a successful save. O(N)
DTW calls — fine on-device.

### 2. False-open detection + auto-close

Tobe: "the recording starts getting long. Perhaps we should
set a maximum or a smart feature to detect false opens. The
same for voice mode."

Three guards added to `WakeModeScreen.tsx`:

- **60s idle timeout**: if Wake/Voice Mode is open and no wake
  match fires AND no recording starts AND no message arrives,
  auto-close. Catches "I walked away after triggering this by
  accident" and "I was asleep". 60s is long enough that a
  real user mid-thought can still talk to the companion.

- **2 min idle during response**: if the user gets a response
  and just stares at it, auto-close after 2 min. Avoids
  draining battery for an ignored response.

- **5 min hard cap**: absolute max. If a session runs this long
  something has gone wrong.

False-open detector in `WakeTrainingModel.ts`:
- Tracks opens shorter than 3s with no recording
- Tracks idle opens longer than 60s
- 3 false opens in 5 min → auto-tighten match threshold by
  +0.05 (capped at 0.85)
- Threshold decays back to 0 after 5 min of clean operation

The threshold bump is exposed via `noteWakeModeOpen()` /
`noteWakeModeExit()`. The matcher can read the bump on its
next init and add it to the user-configured base. (The actual
matcher wiring of the bump to the threshold is left as a
follow-up — the bump is logged, not yet applied. The structure
is in place.)

### 3. Wake-while-locked fix

Tobe: "I tested wake word when the app was minimized and
phone locked but it opened to the home screen Instead of wake
mode for some reason."

The flow when the phone is locked:
1. Native WakeWordModule keeps listening (foreground service).
2. Wake detected → `CyberClawService.openApp()` sends a
   `WakeReceiver` broadcast AND fires a notification with
   `PendingIntent` that launches MainActivity with
   `from_wake_word=true`.
3. MainActivity.onCreate (or onNewIntent) calls
   `checkWakeIntent`, which calls
   `emitWakeOpenedWithRetry(0)`.
4. The retry mechanism polls every 250ms × 20 = 5s for the
   React Native JS context to be ready.
5. If the JS context is still loading (cold start from the
   lock-screen notification can take a while on some devices),
   the event is dropped.

The fix in `MainActivity.kt`:
- `checkWakeIntent` also arms a `pendingWakeEmit` flag and
  sets a `wake_pending` flag in SharedPreferences.
- `emitWakeOpenedWithRetry`, on success, clears the
  `wake_pending` flag.
- `onResume` (which fires AFTER the JS context is up) checks
  `pendingWakeEmit` and, if the flag is still set, re-emits
  the wake event. The second emit reliably reaches App.tsx's
  listener.
- The flag-clearing in the success path means onResume
  doesn't yank the user back to Wake Mode after they exited
  it (the first emit succeeded, so we don't re-emit).

The double-belt-and-suspenders is needed because the original
`emitWakeOpenedWithRetry` is best-effort — if the JS context
is still loading, the event is dropped after 5s. The onResume
re-emit runs when the JS context is definitely ready.

### Files

- `src/services/WakeTrainingModel.ts` — `autoRetrainNormal()`,
  `noteWakeModeOpen()` / `noteWakeModeExit()`, fix legacy
  migration duration bug
- `src/components/SampleTrainer.tsx` — call auto-retrain
  after a successful normal save
- `src/screens/WakeModeScreen.tsx` — 60s/2min/5min auto-close,
  false-open tracking, shared between wake + voice mode
- `android/app/src/main/java/com/cyberclawmobile/MainActivity.kt`
  — re-emit wake event on onResume if the first emit didn't
  succeed
- `package.json` — 3.1.78 → 3.1.79
- `android/app/build.gradle` — versionCode 128 → 129
- `.github/workflows/{build,android-build}.yml` — artifact
  names to 3.1.79
