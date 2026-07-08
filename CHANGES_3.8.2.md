# v3.8.2 — Wake word trainer: optional near-miss recording

Tobe: "we dont have near-miss in the training path, we
need to add that if we are to use it."

The trainer currently asks for 6 positive samples of
the wake phrase (the desktop then generates ~10k
synthetic positives via Piper TTS). The negatives
that teach the model what to reject are ALSO Piper-
TTS-generated — useful for general robustness but
they don't match the user's voice or environment, so
they don't catch what actually trips up the model in
the field.

This release adds an OPTIONAL near-miss recording
step. Three slots; the user records 3 phrases that
sound similar but aren't the wake word. The trainer
ships them with the training request; the desktop
copies them into the negative_train / negative_test
folders so the augmentation step picks them up
alongside the Piper negatives.

## What changed

### 1. New "Record near-misses" section

Below the positive-samples recording section, a new
card with:

- A short explainer: "Piper-TTS adversarial negatives
  catch general acoustic variation, but YOUR
  near-misses in YOUR voice catch what actually trips
  the model up at home."
- 3 rows, each with:
  - **A text input** for the phrase the user is going
    to say. Pre-filled with an auto-suggestion for
    the first slot.
  - **A 🎤 record button**. Tap to capture one
    near-miss sample.
  - **A green ✓ check** after a sample is recorded;
    the input becomes non-editable.
- Below the rows, **3 auto-suggested variations** of
  the wake phrase as chips (tap for a brief
  explanation). Generated via simple phonetic swaps:
  drop trailing vowel, swap first word ("hi" / "ok"
  / "hey"), reverse the last word, phonetic confusion
  pairs (s/t, k/g, m/n, p/b).

Optional — recording 0 near-misses still works (the
training proceeds with just the Piper-TTS adversarial
negatives, v3.8.1 behavior).

### 2. Suggested near-miss generator

`suggestNearMisses(phrase, n=3)` is a pure function
that returns up to 3 phonetic variations of the
wake phrase. The function lives at the top of the
trainer file (alongside `REQUIRED_SAMPLES`) so it's
easy to extend with more heuristics later.

The suggestions are just labels — the model gets the
audio bytes, not the text. So if the user records
"hey car" but types "hey cars", the model still
learns from the audio. The text is purely for the
user's reference ("which near-miss was this?").

### 3. SyncClient + wire protocol

`requestWakeTraining(agentId, phrase, samples,
nearMissSamples?)` now takes an optional
`nearMissSamples` parameter. If present and non-empty,
it's sent on the `request_wake_training` message.

Backward-compat: phones that don't send the field
keep working unchanged. The desktop ignores the field
when absent.

### 4. Near-miss UI flows

- `onTapToRecordNearMiss(phrase)` — captures a
  near-miss sample (same `recordOne()` path as
  positive samples) and stores it as `{ path,
  phrase }`.
- `startTraining` now also encodes each
  `nearMissSamples` entry as base64 and sends them
  alongside the positive samples.
- The phrase label is sanitized to `[a-z0-9_]` for
  the desktop-side filename so weird characters
  don't break the file system.

## Files touched

- `src/components/OpenWakeWordTrainer.tsx`
  (`REQUIRED_NEAR_MISS_SAMPLES` constant,
  `suggestNearMisses()` helper, `nearMissSamples`
  state, `onTapToRecordNearMiss()` handler, near-miss
  UI card, ~13 new styles)
- `src/services/SyncClient.ts`
  (`requestWakeTraining` signature + payload)
- `package.json` (3.8.1 → 3.8.2)
- `android/app/build.gradle` (versionCode 216 → 217)

## Not touched

- Desktop code — already shipped in v3.1.53.
- Other wake-word screens (`WakeModeScreen`,
  `WakePhrasePicker`) — no changes needed.
- SyncClient request handler in the desktop's
  `wake_training_request` — already accepts the new
  field.