# 3.2.25 — Exit phrase trainer + gibberish-response filter

## Reported by Tobe

After v3.2.24 (YOUR TURN badge etc.), Tobe asked for two
things:

1. **Trainable exit phrase** that detects on the live
   audio stream and minimizes voice mode when triggered.
   Just like wake-word training but for the exit phrase,
   single sample set (applies to all conversations).

2. **Concern about the loop continuing on gibberish**
   responses: if the user says something unclear, the LLM
   produces a short nonsense reply, and the multi-turn
   loop continues with no actual user input — the user
   feels trapped.

## v3.2.25 scope (this release)

- ✅ **Exit phrase trainer UI**: NEW `ExitPhraseTrainer`
  component. Records 6 audio samples via
  `WakeWordModule.startSampleRecord` (raw PCM WAV), reads
  each WAV on the JS side, strips the header, extracts
  audio features via `extractAudioFeatures`, saves to
  AsyncStorage under `cyberclaw-exit-samples-<phrase>`.
- ✅ **Settings integration**: "Voice mode loop" section
  now has a "🎤 Train exit phrase (record 6 samples)"
  button that opens the trainer.
- ✅ **Trainer persistence**: existing-trained phrases are
  listed in the trainer with a Remove button.
- ✅ **Gibberish-response filter**: in `onAudioResponse`,
  if the LLM response is <4 words AND has no terminal
  punctuation (?, ., !), close voice mode instead of
  looping. This addresses Tobe's concern that nonsense
  replies trapped users in an endless conversation.
  Heuristic is permissive — only fires on blatant
  gibberish, not legitimate short replies.

## v3.2.25 deferred to v3.2.26

- 🔜 **Runtime DTW detector against trained samples**: the
  audio-stream detector that compares live recording
  amplitude envelopes against trained feature sets. This
  is a substantial follow-up because:
  1. The chat-recorder currently writes m4a (for desktop
     STT), but feature extraction requires PCM. Either
     the chat-recorder needs a dual-output (m4a + WAV)
     OR the runtime detector uses m4a-decoded features
     that require a native decoder on the JS side.
  2. The current native `SimpleAudioRecorder` only emits
     amplitude, not raw audio frames for real-time DTW.
  3. The match window needs careful tuning to fire on
     "thanks" but not on "thanksgiving" or "thank you
     for your help" (false positives).

  The trainer infrastructure is in place so v3.2.26 can
  focus on wiring detection, not building UI.

  Until v3.2.26 lands, the **text-fallback matcher**
  (configured exit phrase, fuzzy substring on the STT
  transcription — v3.2.20) remains the active detection
  mechanism. Slow because it waits for STT, but reliable.

## Files

- `src/components/ExitPhraseTrainer.tsx` (new) — modal
  trainer UI, 6-sample recording, WAV→features pipeline,
  AsyncStorage persistence, trained-phrases list
- `src/screens/SettingsScreen.tsx` — imports trainer,
  adds showExitPhraseTrainer state, mounts the modal,
  adds "Train exit phrase" button in Voice mode loop
  section, back-button handler routes trainer close
- `src/screens/WakeModeScreen.tsx` — gibberish filter in
  onAudioResponse: <4 words AND no punctuation → close
  voice mode instead of looping
- `package.json` 3.2.24 → 3.2.25
- `android/app/build.gradle` versionCode 170 → 171,
  versionName 3.2.24 → 3.2.25
- `.github/workflows/build.yml` APK filename 3.2.24 →
  3.2.25
- `.github/workflows/android-build.yml` artifact name
  bumped

## Lessons

- **"Optional, just like wake" can be a 2-version
  project.** The trainer and the detector are separable
  halves of "trained exit phrase." Shipping them in one
  version means cutting corners on one or both. v3.2.25
  ships the trainer cleanly with persistence + UI; v3.2.26
  ships the runtime detector cleanly against the same
  persistence. Result: each is testable in isolation,
  and a regression in one doesn't block the other.
- **Heuristic filters work for obvious gibberish but not
  for nuance.** "<4 words AND no punctuation" catches
  "yes" and "ok" gibberish, but a single-word legitimate
  reply like "Yes!" or "Sure." passes the punctuation
  check. Future work could layer in more signals (LLM
  confidence, response coherence against conversation
  context). For v3.2.25 the conservative heuristic is
  the right trade — better to ship and iterate than ship
  perfect and miss the release window.
- **"Trained like wake" wasn't quite right.** Wake-word
  training uses desktop GPU + DNN + TFLite export
  (200MB model, 5-15 min training). Exit-phrase training
  needs to be instant + offline (no desktop round-trip,
  no model export). The trainer UI borrows the *layout*
  but the implementation differs: local async storage of
  features vs desktop-trained TFLite. Same UX metaphor,
  different mechanism under the hood.