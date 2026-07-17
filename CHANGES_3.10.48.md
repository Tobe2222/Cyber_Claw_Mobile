# v3.10.48 — wake test active-phrase + TTS install prompt + voice-bar label cap

Three issues from v3.10.47 testing on Tobe's device.

## Issue 1: Wake test peak=0% even though mic works

Tobe retested the wake on v3.10.47. Got:
- Wake peak: 0%
- Average: 0%
- Mic RMS (avg): 0.094 (green, mic works)
- Wake listener: running (green)
- Diagnostic: "Mic heard you, but the model never
  matched. The wake phrase in the trained model may
  differ from what you said — try again with the exact
  phrase, or retrain with cleaner samples."

### Root cause

v3.10.45 added `scoreWavFile(path)` which uses the
existing `owwDetector` to score recorded audio. But
`owwDetector` was initialized at app start by
HomeScreen's `startSampleMatchListener` with the bundled
`'hey_jarvis'` model (hardcoded since v3.2.0). Tobe has
trained a custom "Hey Clawsuu" wake. So the detector
listens for "hey jarvis" while the test audio says "hey
clawsuu" → peak stays 0 even though everything else
works.

Tobe's diagnostic tip says "model may differ from what
you said" — but Tobe IS saying the right phrase. The
problem is the model is wrong, not the user. The
diagnostic was correct in spirit but pointed at the user
instead of the app's hardcoded model init.

### Fix

`useClassifierTest(kind, options?: { wakeword?: string })`
now accepts the active wake phrase. The start function
calls `WakeWordModule.initOww(wakeword, 0.5)` before
`scoreWavFile`, which re-loads the detector with the
right model from the wake-set registry
(`findWakeModelByPhrase`, see the v3.10.1 memory entry
and `OpenWakeWordDetector.kt:289-318`).

CompanionSettingsScreen's wake test call site passes
`activeWakeDirect.phrase` — the canonical active wake
from the same SharedPreferences key the Wake Manager
reads (`active_<agentId>`). No new IPC, no new
AsyncStorage keys.

For exit/send tests, the wakeword is harmless: the
detector reloads its classifiers (initOww is idempotent)
and the test still reads the right score per kind.

### What if initOww fails

If `initOww(wakeword, 0.5)` rejects (e.g. the wakeword
isn't in the registry and no bundled model matches),
the test falls back to whatever the detector already has
loaded. scoreWavFile still runs and reports peak + RMS,
so the diagnostic tip can still distinguish "mic dead"
(peak=0, RMS=0) from "model mismatch" (peak=0, RMS>0).

## Issue 2: Voice mode "no TTS engine"

Voice mode log on Tobe's device after his first turn:
```
📝 Sent, waiting...
🧠 Thinking...
🔊 Speaking: "Working"
🔊 ❌ no TTS engine — install one
🔊 done (no-tts-engine, 1013ms)
```

### Root cause

Tobe's device has no TTS engine installed (or the
binding is broken). `WakeWordModule.speakText` rejects
with `TTS_INIT_FAILED` / status=-1. The v3.10.39 retry
loop (1 attempt + 1 retry with 1s delay) isn't enough —
this is a genuine missing-engine case, not a cold-start
race.

The JS path correctly detects status=-1 and logs "no
TTS engine — install one". But it then just resolves
and the user has no idea how to install. They have to
leave the app, find the system TTS settings, install
Google TTS or eSpeak NG, come back. Bad UX.

### Fix

When the JS path detects `TTS_INIT_FAILED` / status=-1,
it now also offers to launch the system TTS install
activity via `WakeWordModule.installTtsData()`. The
native method already existed (v3.1.90) and launches
`Intent.ACTION_INSTALL_TTS_DATA` — the same dialog the
user would find manually in Settings.

An Alert shows once per voice-mode session
(`ttsInstallPromptedRef` guards repeat prompts), with
"Later" / "Install" buttons. Picking Install opens the
system TTS picker; the user picks Google TTS or eSpeak
NG, installs, comes back to CyberClaw, voice mode now
speaks responses.

The session-scoped prompt is deliberate — a user who
dismisses the dialog shouldn't be nagged on every turn
(they may have already decided not to install). A user
who picks Install gets the system dialog and the next
turn speaks normally.

## Issue 3: Voice-mode bar shows "Learning 101/20"

The compact VoiceEnrollmentBar in voice mode (after
v3.10.46) showed "Learning 101/20" with the bar fully
filled. Numerator > denominator looked like a counter
overflow bug.

### Root cause

v3.10.46 capped the bar FILL with `Math.min(1, ...)` but
left the LABEL showing the raw count. So when
`activeContributions = 101`:
- Bar fill: `Math.min(1, 101/20) = 1.0` (100% filled) ✓
- Bar label: `"Learning 101/20"` (101 > 20, looks wrong) ✗

The denominator was `ACTIVE_LOCK_THRESHOLD = 20` (20
voice-mode turns to fill the bar) but the numerator was
uncapped.

### Fix

Cap the displayed count with `Math.min`:
```ts
const activeCapped = Math.min(status.activeContributions, ACTIVE_LOCK_THRESHOLD);
const combinedCapped = Math.min(combinedCount, LOCK_THRESHOLD_SAMPLES);
const samplesCapped = Math.min(status.samplesTotal, LOCK_THRESHOLD_SAMPLES);
```

Used in both full and compact label variants. The
actual `enrollmentSamplesTotal` (native) and
`activeContributions` (JS) continue to accumulate
uncapped — only the UI display is capped. So the user
sees "Learning 20/20" when they've done 20+ turns, and
the underlying data is preserved for diagnostics.

## Files

- `src/components/ClassifierTest.tsx` — added
  `options?: { wakeword?: string }` to
  `useClassifierTest`, initOww before scoreWavFile when
  wakeword provided
- `src/screens/CompanionSettingsScreen.tsx` — pass
  `activeWakeDirect?.phrase` to `useClassifierTest`
- `src/components/VoiceEnrollmentBar.tsx` — capped
  label values (activeCapped, combinedCapped,
  samplesCapped)
- `src/screens/WakeModeScreen.tsx` — added
  `ttsInstallPromptedRef`, Alert with Install button
  when no TTS engine detected, imports Alert from
  react-native
- `package.json` — 3.10.47 → 3.10.48
- `android/app/build.gradle` — versionCode 274 → 275,
  versionName 3.10.48

## General lesson

**The diagnostic message is right but pointing at the
user instead of the code.** "The wake phrase in the
trained model may differ from what you said" sounded
like Tobe mispronounced "Hey Clawsuu" — but he didn't.
The trained model just wasn't loaded into the detector
that scoreWavFile uses. The fix is to load the right
model, not to tell the user to try again.

Same pattern as v3.10.45's "Mic heard you, but the
model never matched" tip: it correctly identifies that
audio was captured and scoring failed, but the next step
was implicit ("re-check your model"). When a diagnostic
points at user error and the user is doing it right,
the fix is usually in the code that loads the resource
the diagnostic implicitly references.

For the TTS install prompt: the right UX for "this app
needs X but X isn't installed" is to offer to install
X in-place, not to tell the user to go install X
themselves. Same pattern as "permission denied" alerts
in iOS/Android — the system offers to open Settings,
the app shouldn't just log a message.

For the bar overflow: when capping a value for one
display purpose (bar fill) and showing the raw value
for another (label), the two can diverge visually. Cap
both at the same threshold, or use the capped value
consistently.