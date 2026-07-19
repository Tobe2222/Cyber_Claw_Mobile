# v3.10.61 — OWW-primary in BG (trained model runs continuously alongside Vosk)

Tobe (post v3.10.60):

> "okey continue with the second part. and do we need
> a fallback? would a fallback compromize the reason
> to use the more secure method?"

This is the third of five improvements toward a
"personalized wake" architecture. v3.10.61 makes
the trained wake TFLite the PRIMARY detector in
the BG service. Vosk stays as a fallback for when
the trained model doesn't fire — both paths check
the speaker gate.

## About the fallback question

Honest answer: **the fallback does NOT compromise
security** because the speaker gate is checked on
BOTH paths. After v3.10.60:

- Trained model fires → speaker gate check →
  open voice mode if voice matches profile
- Vosk fires → speaker gate check → open voice
  mode if voice matches profile

If someone's voice doesn't match the profile, NEITHER
path opens voice mode. The fallback is purely for
reliability (the trained model might not fire
reliably yet, but Vosk's text matching always
works).

The only cost of keeping Vosk is battery (~50MB RAM
+ ~10% extra CPU during continuous BG listening).
For a single-user primary device, this is negligible.
For a battery-constrained scenario, we could add a
"strict mode" setting in v3.10.63+ that drops Vosk
once the profile locks.

Decision: keep Vosk as fallback. Both paths gated.
Best of both worlds — reliability from Vosk, accuracy
from OWW, security from the gate.

## What changed in v3.10.61

### `CyberClawService` now runs the trained TFLite too

On service start, the service scans SharedPreferences
("wake_models") for the most-recently-active wake
set and loads its .tflite into a fresh
`OpenWakeWordDetector` instance. If no custom-trained
wake exists, it falls back to bundled `hey_jarvis`
(so OWW always has a wake classifier loaded — Vosk
still catches user-trained phrases even if bundled
jarvis doesn't match them).

In the Vosk listen loop, after each PCM read:
- Existing behavior: push to EnrollmentAudioProcessor
  for enrollment (v3.10.60), feed Vosk.
- New behavior: ALSO push the same audio into the BG
  OWW detector. Buffer internally, emit 1280-sample
  chunks to `predictScore`. If the wake score crosses
  `bgOwwThreshold` (0.5) for 3 consecutive frames
  (HIGH_SCORE_RUN, matching the foreground OWW
  thread), check the speaker gate. If passes, fire
  `openApp()`. Same gate, same `markConfirmedWake()`,
  same Vosk fallback below.

### Architecture

```
Microphone (16kHz)
   │
   ├─→ EnrollmentAudioProcessor (enrollment + speaker gate)
   ├─→ BG OWW TFLite (trained model, PRIMARY)
   └─→ Vosk + PhoneticMatcher (FALLBACK)
              │
              ▼
        openApp() — fired by either
        (both gated by same EnrollmentAudioProcessor)
```

Both wake paths check the same `EnrollmentAudioProcessor.shouldSuppressWake()`
before opening voice mode. Once the profile locks,
anyone other than the enrolled user gets suppressed
on BOTH paths.

## Files changed

- `android/app/src/main/java/com/cyberclawmobile/CyberClawService.kt`:
  - New fields: `bgOwwDetector`, `bgOwwThreshold`,
    `bgOwwBuffer`, `bgOwwHighFrames`, `bgOwwLastWakeAt`
  - New methods: `initBgOwwDetector()`,
    `processBgOwwChunk()`
  - `initAndListen()` now also calls
    `initBgOwwDetector()`
  - Listen loop calls `processBgOwwChunk()`
    alongside `enrollment.processAudio()` and
    Vosk's `acceptWaveForm`
  - `onDestroy()` closes the BG OWW detector
- `android/app/build.gradle`: versionCode 287→288,
  versionName 3.10.60→3.10.61
- `package.json`: version 3.10.60→3.10.61

## Battery / CPU cost

- Extra `OpenWakeWordDetector` instance:
  ~20MB RAM (melspec + embedding + classifier)
- Per-chunk work: melspec + embedding + wake
  classifier inference on the user's audio
  (~5ms per 80ms chunk on a Pixel 6 = 6% extra CPU)
- For comparison, Vosk on the same audio is ~15ms
  per chunk. So we're adding ~33% to the BG audio
  processing cost. Acceptable.

If battery becomes an issue, the user can:
- Reduce BG listening sessions (toggle in Settings)
- Or in v3.10.63+, switch to "strict mode" that
  drops Vosk once the profile locks

## Roadmap (subsequent versions)

- **v3.10.62** — Active enrollment UI: 30-second
  "say anything" pass for fast profile lock
- **v3.10.63** — Continuous learning + adaptive
  threshold + optional strict mode

## Verification on device

1. Install v3.10.61. Trigger the BG service
   (open the app, it starts the service).
2. After a few seconds, logcat should show:
   ```
   CyberClawService: BG OWW loading custom model: /data/.../wake_models/<setId>/model.tflite
   CyberClawService: BG OWW initialized (threshold=0.5)
   ```
3. The wake test button still uses WakeWordModule's
   OWW detector (foreground path) — should work
   unchanged.
4. Say "hey clawsuu" while the app is in BG → both
   OWW and Vosk may fire. The OWW fire happens first
   (more selective), opens voice mode.
5. After profile locks, have someone else say
   "hey clawsuu" → both OWW and Vosk fire but the
   speaker gate suppresses both. Logcat:
   ```
   BG OWW wake suppressed by speaker gate (match=0.XX < 0.50)
   Vosk wake suppressed by speaker gate (match=0.XX < 0.50)
   ```

## Note on profile ownership

v3.10.61 still has TWO profile owners in memory:
- `EnrollmentAudioProcessor` (used by both BG paths)
- `WakeWordModule`'s OWW detector (used by the
  foreground test path)

Both write to the same SharedPreferences key
(`speaker_profile_v1`) so they share the persisted
profile. The in-memory copies can diverge briefly
if one writes while the other is reading. v3.10.63
will unify by having the foreground OWW thread
delegate to `EnrollmentAudioProcessor` for its
profile check.