# v3.10.59 — Trainer: 12 samples + per-sample volume feedback + consistency check

Tobe (post v3.10.58):

> "i want the best wake. One which can learn the users
> voice best. ... Okey lets test it. Go ahead with all"

This is the first of five improvements toward a
"personalized wake" architecture (OWW TFLite classifier
+ speaker embedding gate). v3.10.59 is the
foundation: better training data.

## What changed

### 1. `REQUIRED_SAMPLES` bumped from 6 → 12

The trainer now requires 12 user recordings (was 6).
The desktop's synthetic-amplified pipeline can work
with 6, but 12 gives a stronger acoustic foundation
for the TFLite to learn from — especially across
varied volumes, paces, and mic positions.

Why: Tobe's 6-sample training (2026-07-19) produced
a model that scored 0% against his voice in the wake
test, while the wake still fired reliably via Vosk
text matching (production bypasses the trained
TFLite). More samples = more reliable TFLite output
= better OWW-primary detection.

The desktop training pipeline still finishes in
under 5 minutes with 12 samples — the GPU does the
heavy lifting; the user recordings are just a
foundation.

### 2. Per-sample RMS feedback

After each recording, the trainer now computes the
RMS of the WAV file (in JS, via `base64ToInt16Array`
from `AudioUtils.ts`) and displays a small colored
chip next to the sample counter:

- 🟢 `#N (0.045)` — sample RMS in the good range
  (0.02 - 0.20)
- 🟠 `#N (quiet)` — sample RMS < 0.02 (too quiet)
- 🟠 `#N (loud)` — sample RMS > 0.20 (clipping risk)
- ⚫ `#N (?)` — RMS read failed (sample still usable)

This gives Tobe instant feedback on whether each
recording is in the recommended volume range.

### 3. Cross-sample consistency check (CV hint)

Once 4+ samples have been recorded, the trainer
computes the coefficient of variation
(standard deviation / mean) across the per-sample
RMS values and shows a summary:

- `✓ Volume consistency: good (CV 0.18)` — CV < 0.3,
  recordings are consistent. Train as-is.
- `⚠️ Volume varies a bit (CV 0.45) — that's fine,
  just don't whisper some and shout others` —
  CV 0.3-0.7, moderate variation. Desktop pipeline
  handles it.
- `⚠️ Volume is highly variable (CV 0.85) — try to
  match how you'll say it in real use` — CV > 0.7,
  recordings differ a lot from each other. The
  trained model may not generalize well to production
  conditions.

The CV check tells the user BEFORE they train
whether their recording conditions are likely to
produce a useful model.

## Files changed

- `src/components/OpenWakeWordTrainer.tsx`:
  - `REQUIRED_SAMPLES` 6 → 12
  - New `sampleRms` state + `setSampleRms` updates
  - RMS computation in `onTapToRecord` using
    `base64ToInt16Array`
  - New UI: per-sample RMS chips row + consistency
    hint
  - `clearSamples` now also clears `sampleRms`
  - New styles: `sampleRmsRow`, `sampleRmsChip`,
    `consistencyHint`
- `src/services/AudioUtils.ts`: no change (reused
  existing `base64ToInt16Array`)
- `android/app/build.gradle`: versionCode 285→286,
  versionName 3.10.58→3.10.59
- `package.json`: version 3.10.58→3.10.59

## Roadmap (subsequent versions toward "best wake")

v3.10.59 is the foundation. The full "personalized
wake" plan:

- **v3.10.60** — Bootstrap enrollment from Vosk
  fires. `CyberClawService` will feed audio chunks
  into the OWW detector's embedding pipeline so the
  speaker profile accumulates even when the trained
  TFLite doesn't fire. Speaker gate will then be
  checked on Vosk fires too, rejecting other
  speakers.
- **v3.10.61** — OWW-primary routing. Once the
  trained TFLite is reliable (12-sample training
  should help), make OWW + speaker gate the primary
  detector. Vosk becomes the fallback for cases
  where the TFLite genuinely doesn't fire.
- **v3.10.62** — Active enrollment UI. A 30-second
  "say anything" pass that builds the speaker
  profile 30x faster than passive enrollment. Useful
  for users who don't want to wait for natural
  accumulation.
- **v3.10.63** — Continuous learning + adaptive
  threshold. Every confirmed wake updates the
  speaker profile with the recent embedding, and
  the wake classifier threshold adapts to gradual
  voice changes.

## Lesson

The trained wake TFLite has been broken on Tobe's
device because production uses Vosk text matching
instead of the trained model. Vosk works reliably
for "hey clawsuu" because it's text matching, not
acoustic matching. The "wake triggers easily"
observation was actually a sign that Vosk was
working, NOT that the trained model was working.

The right fix is to:
1. Make the trained model good enough to fire
   reliably (v3.10.59 foundation)
2. Make production USE the trained model (v3.10.60/61)
3. Add speaker personalization on top (v3.10.60+)

Without step 1, the trained model is decorative.
With step 1+2+3, Tobe gets a personalized wake
detector that learns his voice and rejects others.

## Verification on device

Train a new wake phrase with 12 samples. Expected:
- Sample counter shows `0/12`, `1/12`, ..., `12/12`
- After each recording, a colored chip appears next
  to the counter showing the sample's volume
  category
- After 4+ recordings, a CV-based consistency hint
  appears below
- Training proceeds with all 12 samples; desktop
  takes ~3-5 minutes to train (was ~1-3 min with
  6 samples)
- Resulting TFLite should be more reliable than the
  6-sample version. Test with the wake test button
  — expect peak scores in the 30-70% range (vs 0%
  for the previous training).