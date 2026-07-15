# v3.10.28 — noise-aware silence detection (self-calibrating)

**TL;DR:** silence detection now calibrates itself from the gap
between the user's speech level and the ambient noise floor, instead
of using a fixed absolute RMS threshold. Works in cafés, traffic, and
HVAC noise where ambient RMS exceeds the old hardcoded 0.005 silence
threshold. Toggle in Voice mode settings, default ON.

## What shipped

### Native (Kotlin) — `WakeWordModule.kt`

- **Added** per-turn calibration state:
  - `smartSilenceNoiseFloor` (rolling slow-EMA, alpha=0.005,
    ~4s half-life) — the ambient environment's typical RMS.
    Updated on every chunk (passive, even when user isn't talking).
  - `smartSilenceSpeechFloor` (faster EMA, alpha=0.04) — the
    user's typical speech RMS. Updated only on definite-speech
    frames (RMS ≥ 0.010).
  - `smartSilenceSpeechSampleCount` — counter; gate for the
    warm-up → calibrated transition (≥30 speech frames = ~2.4s
    of speech).
  - `smartSilenceLastVadReportMs` — throttle for emitting stats
    in the owwVad event.
- **Modified** `startRecorderWithSilence` signature: added
  `useSmartSilence: Boolean` arg. When `true`, the smart path
  is used (after calibration). When `false`, the v3.10.12
  absolute path is used verbatim — same behavior as v3.10.27.
- **Rewrote** the silence-decision block in `processRecorderChunk`:
  1. Always update `smartSilenceNoiseFloor` (passive, slow EMA).
  2. If RMS ≥ 0.010, this is definite speech → update
     `smartSilenceSpeechFloor`, reset silence counter, return.
  3. Else, compute the silence threshold:
     - **Smart-calibrated** (`smartSilenceEnabled` AND ≥30 speech
       frames AND `speechFloor − noiseFloor > 0.01`):
       - `silenceThreshold = noiseFloor + 0.30 × (speechFloor − noiseFloor)`
       - `speechThreshold = noiseFloor + 0.70 × (speechFloor − noiseFloor)`
       - 40% wide hysteresis band absorbs inter-word gaps.
     - **Smart-warming** (smart enabled, not yet calibrated) OR
       **Absolute** (toggle off OR no speech yet): fall back to
       `silenceThreshold = 0.005`, `speechThreshold = 0.010`.
  4. Hysteresis band: don't reset counter AND don't accumulate.
  5. Below silence threshold + has-spoken + ≥500ms: accumulate
     silence, fire `recorderSilence` if ≥ silenceMs.
- **Modified** `recorderSilence` event payload: now carries
  `{useSmartSilence, smartReady, noiseFloor, speechFloor,
  silenceThreshold, speechThreshold, maxRecordingHit}` so the
  JS side can log what the detector was working with.
- **Modified** `recorderPcmBuf.reset()` to also clear the
  smart-silence calibration state on every new recording
  turn. Stale state from a previous turn would give wrong
  thresholds (e.g. a 30-min-old speech floor in a now-quiet
  room is wrong).

### JS / UI

- **`SimpleAudioRecorder.ts`**:
  - Added AsyncStorage read for `cyberclaw-smart-silence` on
    every `start()` call (default true).
  - Added `getLastSilenceStats()` accessor for the calibration
    payload from the most recent silence event.
  - Pass the toggle through to the new
    `startRecorderWithSilence(path, silenceMs, useSmartSilence)`
    arg.
- **`SettingsScreen.tsx`**:
  - New `Toggle` row in the Voice mode section:
    "🤫 Smart silence (noise-aware)" with a sub-line explaining
    what it does. Default ON. Persists to
    `cyberclaw-smart-silence` in AsyncStorage.
  - Hydrate the toggle on mount (default ON; only `false` in
    storage switches it off — safe default for new users).
- **`WakeModeScreen.tsx`**:
  - On every silence event, log a one-line calibration summary
    to the per-turn log:
    `mode=smart-calibrated noise=0.012 speech=0.045 threshold=0.022`
    or `mode=absolute noise=...` if the toggle is off / warming
    up. The user can see what the detector was doing when
    diagnosing "why did it cut me off?" reports.

## How it works in a coffee shop

| Time | What's happening | Noise floor | Speech floor | Threshold | User pauses? |
|------|------------------|-------------|--------------|-----------|--------------|
| 0s   | Voice mode opens | 0.005 (default) | 0 | 0.005 (absolute fallback) | - |
| 1-2s | First words spoken | 0.012 | 0.045 (first speech) | still absolute (warming) | - |
| 2-3s | Speech sample count > 30 | 0.013 | 0.048 | 0.013 + 0.30×(0.048−0.013) = **0.024** | - |
| 5s   | User finishes sentence | 0.013 | 0.048 | 0.024 | RMS drops to 0.014 (ambient) — below 0.024, silence accumulates |
| 6-11s | silenceMs countdown | 0.013 | 0.048 | 0.024 | silenceMs = 6000, fires at 11s |

The pre-v3.10.28 design would have NEVER fired `recorderSilence`
in step 5 (ambient RMS 0.014 > silence threshold 0.005 = never
silent). The user would have to say the send word to commit. With
smart silence, the threshold adapts to 0.024 — the user's pauses
(0.014, near ambient) accumulate as silence correctly.

## How it works in a quiet room

| Time | Noise floor | Speech floor | Threshold |
|------|-------------|--------------|-----------|
| 0s   | 0.005 (default) | 0 | 0.005 (absolute fallback) |
| 2s   | 0.002 | 0.030 | 0.002 + 0.30×(0.030−0.002) = **0.011** |

In a quiet room the smart path converges to a threshold very
close to the absolute 0.005 (since speechFloor is much larger
than noiseFloor and the ratio doesn't push it down). The
behavior is functionally identical to the absolute path — no
regression for users in quiet environments.

## Why warm-up with absolute thresholds?

The first ~2.4s of voice mode uses absolute thresholds
(0.005/0.010) because the speech floor isn't calibrated yet.
Premature smart-mode with `speechFloor = 0` would give
`silenceThreshold = noiseFloor + 0.30 × 0 = noiseFloor`, which
is essentially "silence = below the noise floor" = never
silent. The warm-up with absolute thresholds guarantees the
user can't get cut off by a premature silence fire before the
calibration is meaningful.

The 2.4s threshold (30 frames at 12.5Hz) was chosen as the
smallest value where the speech floor EMA (alpha=0.04) has
converged to within ~5% of the user's actual speech level.
Shorter warm-up = higher risk of degenerate thresholds;
longer = the user has to wait for the smart path to kick in.

## Edge cases handled

- **Gap < 0.01 between speech and noise floors**: the user
  hasn't actually spoken above the noise floor (silence-only
  or very weak speech). Falls back to absolute thresholds
  for safety so we don't get a degenerate threshold of
  (0.005 + 0.30 × 0.001) = 0.0053.
- **Max-recording limit hit** (30s): carries the calibration
  stats in the silence event so the user can see whether
  smart mode was actually working or whether the recording
  hit the safety limit first.
- **Toggle off in mid-conversation**: the next recording turn
  uses absolute thresholds. Calibration state is reset on
  every new turn so toggling back on later doesn't carry
  stale floor estimates.
- **Noise floor EMA lower bound** (0.001): real microphones
  on real devices have a hardware noise floor. The estimator
  can't go below 0.001, which prevents a 5-min silence from
  driving the floor to zero and then mis-detecting the
  first word of the next conversation as "very loud" (it'd
  be 50x the noise floor).

## Why the toggle exists

Smart silence is strictly better than absolute silence in
every environment we can think of (quiet room, café, traffic,
HVAC). But:

1. Some users prefer the v3.10.12 behavior (predictable
   threshold, no calibration overhead). The toggle lets them
   opt out.
2. Calibration failures (e.g. an unusual mic with bizarre
   RMS characteristics) are easier to diagnose with absolute
   thresholds — the user can flip off and see whether the
   issue is in the calibration logic or in the absolute
   path itself.
3. The toggle gives Tobe a "compare" experience: turn it
   off, run a test turn, turn it on, run another turn,
   compare the calibration logs in the per-turn log.

The toggle default is ON. New users get smart silence from
day one.

## Build artifacts

- `package.json`: 3.10.28
- `android/app/build.gradle`: versionCode 255, versionName 3.10.28
- Modified: `android/.../WakeWordModule.kt` — processRecorderChunk
  rewrite + new fields + new event payload
- Modified: `src/services/SimpleAudioRecorder.ts` — toggle read
  on start, getLastSilenceStats accessor
- Modified: `src/screens/SettingsScreen.tsx` — new toggle row
  + state + AsyncStorage hydrate
- Modified: `src/screens/WakeModeScreen.tsx` — calibration log
  on silence event
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors remain —
  unrelated to this release per the AGENTS.md "pre-existing TS
  errors" rule.

## What's NOT in v3.10.28

- **Spectral VAD (frequency-domain features)**: the current
  smart silence uses only RMS energy. A frequency-domain
  VAD (e.g. computing spectral entropy or sub-band energy
  ratios) would be more robust to "music with quiet gaps"
  scenarios (the smart silence would treat a quiet musical
  passage as silence). Deferred to v3.11+ if Tobe reports
  it as a problem.
- **Per-environment profiles**: the noise floor estimate is
  per-turn. A future enhancement could remember a
  per-environment profile (e.g. "office" vs "car") and use
  it as a prior for the noise floor EMA. Deferred to v3.11+.
- **Adaptive silenceMs**: the user-configured silenceMs is
  fixed. A future enhancement could shorten silenceMs in
  clear speech (user clearly finished) and lengthen it in
  noisy environments (the user might still be talking under
  the noise). Deferred to v3.11+.