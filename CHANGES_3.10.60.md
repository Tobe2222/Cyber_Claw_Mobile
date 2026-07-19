# v3.10.60 — Speaker gate on BG service (Vosk) + bootstrap enrollment

Tobe (post v3.10.59):

> "i want the app to learn the voice of the user. less
> triggered by others and randomly."

This is the second of five improvements toward a
"personalized wake" architecture. v3.10.60 wires up
the speaker gate on the BG service's Vosk path AND
bootstraps enrollment from the BG audio stream so the
profile actually accumulates.

## What changed

### 1. New file: `EnrollmentAudioProcessor.kt`

Self-contained singleton that owns an
embedding-only `OpenWakeWordDetector` instance
(melspec + embedding, no wake classifier). Loaded
once on first access; persists for the app's
lifetime. Loads any persisted speaker profile from
SharedPreferences on init.

API:
- `getInstance(context)` — singleton accessor
- `processAudio(samples, count)` — buffers audio,
  emits 1280-sample chunks to the embedding-only
  detector, accumulates voice-active samples
- `shouldSuppressWake()` — speaker gate check
  (returns true if recent audio doesn't match the
  enrolled profile and the profile is locked)
- `markConfirmedWake()` — bumps the confirmed-wake
  counter (one of the lock conditions)
- `isProfileLocked()`, `hasProfile()`,
  `getMatchScore()`, `getEnrollmentSampleCount()`
- `clearProfile()`, `close()`

The detector runs in embedding-only mode (no
classifier inference), so `processAudio` is cheap
(~2ms per chunk on a Pixel 6). Battery impact
during continuous BG listening is negligible.

### 2. `OpenWakeWordDetector.kt` — new embedding-only API

- `loadEmbeddingOnly()` — loads melspec + embedding
  interpreters, no classifiers. Sets the detector
  into embedding-only mode.
- `computeEmbedding(pcm16)` — runs melspec +
  embedding only, returns the 96-dim embedding.
  Same history-stashing behavior as `predictScore`
  so the embedding lands in `embeddingHistory`
  for `matchRecentSpeaker()` and
  `accumulateLatestEmbedding()`.

### 3. `CyberClawService.kt` — feed audio + speaker gate

In the Vosk listen loop:
- Every PCM read is also pushed to
  `EnrollmentAudioProcessor.processAudio()` —
  bootstraps the speaker profile from BG listening
  audio.
- When Vosk fires wake:
  - Check `shouldSuppressWake()`. If true, log
    the suppression and skip `openApp()`. The
    wake was someone else's voice saying "hey
    clawsuu".
  - If false (either no profile yet, or the audio
    matches the enrolled user), call
    `markConfirmedWake()` to bump the counter, then
    `openApp()`.

The speaker gate is a no-op until the profile locks
(profile needs ~1000 voice-active samples + N
confirmed wakes). Until then, every Vosk fire
behaves as before — system works, then learns.

## Why this matters

Before v3.10.60, the speaker profile only grew
from the OWW thread's chunks. The OWW thread runs
in the foreground (Voice Mode screen, wake test,
or Home screen's listener). If the user spent all
their wake time behind the BG service's Vosk
detector and never had a fresh trained TFLite
firing in the foreground, the profile never
accumulated and the speaker gate never activated.

After v3.10.60, the BG service's audio stream
also feeds the profile. So even users who never
open Voice Mode will eventually lock the profile
through normal BG listening. The gate then
suppresses wakes from anyone else's voice.

## Files changed

- **New** `android/app/src/main/java/com/cyberclawmobile/EnrollmentAudioProcessor.kt`
  (~230 lines)
- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt`
  — `loadEmbeddingOnly()` + `computeEmbedding()` (~95 lines)
- `android/app/src/main/java/com/cyberclawmobile/CyberClawService.kt`
  — audio feed to processor + speaker gate in
  `checkWakeWord()` (~25 lines)
- `android/app/build.gradle`: versionCode 286→287,
  versionName 3.10.59→3.10.60
- `package.json`: version 3.10.59→3.10.60

## Roadmap (subsequent versions)

- **v3.10.61** — Unify the OWW thread's enrollment
  with EnrollmentAudioProcessor. Currently both
  paths maintain their own profile in-memory;
  v3.10.61 makes EnrollmentAudioProcessor the sole
  profile owner and has the OWW thread delegate.
- **v3.10.61 cont.** — OWW-primary routing. Make
  the trained TFLite the primary detector when
  reliable; Vosk stays as fallback.
- **v3.10.62** — Active enrollment UI. A
  30-second "say anything" pass that builds the
  profile 30x faster than passive enrollment.
- **v3.10.63** — Continuous learning + adaptive
  threshold.

## Verification on device

After installing v3.10.60:

1. **First time after install:** the profile is
   empty. The speaker gate is inactive. Vosk
   wakes pass through as before.
2. **After ~30s of BG listening with voice
   activity:** the profile starts accumulating
   (1000 samples ≈ 30s of voice-active audio).
3. **Once profile locks:** the speaker gate
   activates. Vosk wakes from voices that don't
   match the profile are suppressed (logged as
   "Vosk wake suppressed by speaker gate").

You can verify the gate is working by:
- Logging as user A → lock profile (speak for 30s
  with the wake phrase)
- Have user B say "hey clawsuu" → should NOT open
  voice mode (logged as suppressed)
- User A says "hey clawsuu" → opens voice mode as
  usual

adb logcat during testing:
```
adb logcat | grep "CyberClawService\|Enrollment"
```

You should see "Vosk wake suppressed by speaker
gate" when user B tries.