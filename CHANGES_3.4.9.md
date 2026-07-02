# v3.4.9 — Honest message in Exit Phrase Trainer

## What changed

Tobe trained an exit phrase ("okey fuck off") and noticed the
"v3.2.26 will wire this to the runtime detector" message in the
trainer. He asked whether exit should also be trained on the GPU
like wake is.

Investigation: the v3.2.26 promise was never delivered. The
runtime DTW detector that was supposed to read the trained
samples and match against the live audio stream was never
implemented. The trained samples ARE saved to AsyncStorage
(`cyberclaw-exit-samples-<companionId>-<phrase>`), but they're
never read by voice mode at runtime.

Current exit detection: `ExitPhraseMatcher` matches the active
exit phrase against the STT transcription (text-based, no DTW).
This has worked since v3.2.17.

Why no GPU training for exit? The wake word detector uses an ML
model (openWakeWord TFLite) that needs training per phrase. The
exit phrase was designed to use DTW template matching against
the recorded audio features — no training needed, just feature
comparison. Different problem → different approach.

## Architecture

- Updated `ExitPhraseTrainer` in-component strings to reflect
  the current behavior honestly:
  - Status message: was "v3.2.26 will wire this to the runtime
    detector". Now: "Saved for the future runtime audio-DTW
    detector; today's exit detection still uses the text-fallback
    (matches your STT transcription)."
  - Description: was "Once v3.2.26 ships, voice mode will detect
    this phrase on the audio stream and exit immediately". Now:
    "Today's exit detection still uses the text-fallback. The
    samples you record here are saved for the future runtime
    audio-DTW detector."
- Updated the top-of-file docstring to explain the current state
  and the future DTW work.

## What's NOT in this release

- Runtime DTW detector against the trained samples. That requires
  the chat-recorder to write WAV alongside the existing m4a, so
  JS can decode it at silence-fire time. Substantial new feature
  — separate release when prioritized.

## Files

- Edited: `src/components/ExitPhraseTrainer.tsx` (status msg,
  description, docstring)
- Edited: `package.json` (3.4.8 → 3.4.9)
- Edited: `android/app/build.gradle` (versionCode 186 → 187, versionName 3.4.8 → 3.4.9)