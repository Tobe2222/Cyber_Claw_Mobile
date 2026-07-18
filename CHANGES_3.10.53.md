# v3.10.53 — wake-trainer volume diversity hint

## What

The wake-trainer UI now suggests that the user record their 6
samples at varied volumes (whisper, normal, shout). One short
hint below the existing "Say the phrase 6 times" subtitle.

## Why

Tobe (verbatim, 2026-07-18 17:26 GMT+2): "i also want it to be
more dependent on the sounds, not volume, so i can whisper and
shout to it. Or if the phone is further away i would like it to
pick up so i can call to it"

Trained wake models were amplitude-biased because openWakeWord's
`augment_clips` constructs its `Gain` augmentation with
`max_gain_in_db=0` (combined with the Gain class's default
`min_gain_in_db=-18`, that's attenuation-only). Newly trained
models never see amplified positives and end up firing only in
the narrow volume band the user happened to record at.

Desktop v3.2.13 fixes the augmentation config (Gain range
restored to symmetric `[-18, +18]` dB via
`_oww_onnx_tflite_patch.py:_apply_gain_patch()`). With the
augmentation fixed, the trainer now produces volume-invariant
models — but it still needs positives at varied volumes to
learn from.

## What ships here

This v3.10.53 is the **mobile half** of the volume-invariance
fix:

- The trainer UI now shows a hint: "Tip: vary your volume across
  the 6 samples — try a whisper, a normal voice, and a shout.
  The trained model will then recognize you whether you whisper
  or call from across the room."
- Hint is shown only while samples are still being recorded
  (`!isTrainingInProgress && !isFinished && samples.length <
  REQUIRED_SAMPLES`) so it disappears once the user has all 6
  samples and is in the training stage.
- Existing "Say the phrase 6 times" subtitle is unchanged.

The hint is human-curated diversity on top of the augmentation's
statistical diversity. The augmentation now covers the full
volume range; the user's varied recordings give the augmentation
real data to anchor to.

## What doesn't ship here (yet)

A more elaborate volume-bucket recording flow — separate "record
whisper / record normal / record shout" buttons with progress
tracking per bucket — was considered for v3.10.53 but
deferred. The hint is enough to nudge the user toward varied
recording; the augmentation handles the rest. If testing shows
the hint isn't effective (users keep recording at one volume
despite the hint), v3.10.54 will add the explicit bucket UI.

## Wake sets trained BEFORE this version

Tobe's current "Hey Clawsuu" model (and any other wake sets
trained on desktop v3.2.12-or-earlier) remain amplitude-biased.
**They must be retrained** after pulling desktop v3.2.13 to get
volume invariance. The trained classifier's parameters are baked
in at training time; no post-hoc fix is possible.

After retraining with the new augmentation:
- Whisper should fire.
- Shout should fire.
- Calling from across the room (which is mostly a gain-reduction
  effect) should fire — within reason. The augmentation covers
  ±18dB which is ~8x quieter to 8x louder. Distance attenuation
  is in this range up to a few meters in a quiet room.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — new hint below
  subtitle, conditional on `samples.length < REQUIRED_SAMPLES`.
- `package.json` — version 3.10.52 → 3.10.53.
- `android/app/build.gradle` — versionCode 279 → 280,
  versionName "3.10.52" → "3.10.53".

## Related

- Desktop v3.2.13: `_apply_gain_patch()` in
  `scripts/_oww_onnx_tflite_patch.py` — restores the symmetric
  Gain range. Required companion to this mobile change.
- Mobile v3.10.50: `loadedWakeword` field in `scoreWavFile` —
  the diagnostic that surfaced the binding/init bug. With
  binding fixed (v3.10.52) and volume invariance fixed (v3.10.53
  + desktop v3.2.13), wake detection should finally work across
  the full user-volume range.

## General lesson

**A UI hint is the cheapest possible feature ship.** The whole
training pipeline gains volume invariance from the desktop
augmentation fix. The mobile half of the user-facing experience
is a single sentence of copy. Often the right scope for a
"version" is the smallest change that makes the underlying fix
visible to the user — anything more is scope creep.