# v3.6.0 — Send word + gibberish gate (turn-end control)

## Motivation

Tobe was showing the app to friends at a table. Voice mode
opened, he started talking, then ambient conversation at the
table kept the recorder alive for far longer than intended —
the silence timer couldn't reliably tell his voice from the
rest of the table's, so the recording just kept growing.

Three knobs solve the underlying problem:

1. **Explicit "send" word** — Tobe says the word (default
   "send") to commit the current turn immediately. Works
   in any noise level because it's a trained classifier, not
   a silence threshold.
2. **Gibberish gate** — if no speech-classifier event fired
   AND the periodic RMS+ZC VAD never crossed the speech
   threshold during the recording turn, drop the recording
   instead of shipping silence to STT.
3. **Existing silence timer** — kept as-is. Still the default
   turn-end mechanism for quiet rooms.

The three compose: in a quiet room, silence ends the turn
automatically. In a noisy room, the user says "send". In the
worst case (noise drowns out "send" too), the gibberish gate
catches the empty / non-speech recording at the end and
discards it instead of polluting the LLM.

## Architecture

v3.6.0 extends the existing dual-classifier pipeline (wake +
exit, both running on the same melspec+embedding) with a
third classifier slot for the send word. All three share
the same audio front-end; only the final binary classifier
differs. Each has its own threshold, high-score counter, and
detection cooldown so they can fire independently.

```
microphone → AudioRecord (16kHz mono)
  → 80ms chunks (1280 PCM16 samples)
  → melspectrogram (TFLite, history=5)
  → embedding (TFLite)
  → 3 classifiers in parallel:
     • wake  (custom or pretrained .tflite)
     • exit  (user-trained .tflite, optional)
     • send  (user-trained .tflite, optional)
  → emit 'owwWakeDetected' | 'owwExitDetected' | 'owwSendDetected'
```

Plus a periodic `owwVad` event (~5 Hz) carrying the chunk's
RMS energy + zero-crossing rate, used by the JS side to mark
whether the active recording turn has seen any speech at all
(gibberish gate).

## Native changes

### `OpenWakeWordDetector.kt`

- Renamed `PairScores` → `TripleScores` (added `send: Float?`).
  `PairScores` kept as a `typealias` so any old callers still
  compile (currently none).
- New slot: `sendInterpreter`, `sendName`, `sendThreshold`.
- New method: `setSendModelFromFile(phrase, tflitePath)` —
  hot-swap parallel to `setExitModelFromFile`. Clears
  `melspecHistory` because the new model has a different
  expected input distribution.
- New method: `sendNameOrEmpty()` — echo the configured send
  word text into the `owwSendDetected` event payload so JS
  can log/display what fired.
- `predictScore()` now runs all three classifiers on the same
  embedding, returns `TripleScores`.
- `close()` releases `sendInterpreter` too.

### `WakeWordModule.kt`

- Listening loop variables: added `sendHighScoreFrames`,
  `lastSendAt`, `SEND_HIGH_SCORE_RUN = 3`. Same cooldown as
  wake/exit (2 s).
- After wake+exit+send score checks, computes chunk RMS+ZCR
  and emits `owwVad` every ~3 chunks (~5 Hz), capped by
  `VAD_ENERGY_MIN_GAP_MS = 200` so a chatty bridge event
  can't flood JS.
- New helper `computeEnergyAndZcr(pcm16): Pair<Float, Float>`
  — RMS normalized to [0,1] and ZCR as a fraction. Tiny per-
  chunk work, no melspec needed.
- Three new `@ReactMethod`s:
  - `setSendModelFromBase64(phrase, base64)` — writes the
    `.tflite` to `filesDir/send_models/<phrase>.tflite`,
    persists the binding to SharedPreferences, hot-swaps into
    the live detector.
  - `setSendThreshold(threshold)` — sets the send-word
    classifier threshold (default 0.5).
  - `loadOwwSavedSendModel()` — loads the persisted send
    model on app boot (mirror of `loadOwwSavedExitModel`).
- New event: `owwSendDetected` with `{ score, sendword }`,
  and `owwVad` with `{ rms, zcr }`.

## JS changes

### `src/services/VoiceSettings.ts`

- New `sendPhrase: string` field on `VoiceSettings`.
- New keys: `cyberclaw-send-phrase` (global, single word),
  `cyberclaw-send-samples-<phrase>` (training marker).
- New helpers: `saveSendPhrase()`, `loadSendSamples()`,
  `saveSendSamples()`, `clearSendSamples()`.
- Default send word is `'send'`.

### `src/services/SyncClient.ts`

- Three new methods parallel to the exit-training pipeline:
  `requestSendTraining(phrase, samples)`,
  `requestLatestSendTrainingResult()`, `readSendModel(path)`.
  Reply chain: `send_training_progress` / `send_training_result`
  / `send_model_data` — all auto-emitted by the existing
  `this.emit(msg.type, msg)` fallback.

### `src/components/SendPhraseTrainer.tsx` (new)

Mirror of `ExitPhraseTrainer.tsx`:
- Captures 6 raw PCM16 mono 16kHz WAV samples via
  `WakeWordModule.startSampleRecord`.
- Ships them to the desktop for openWakeWord training.
- Receives the trained `.tflite` back via `readSendModel`.
- Hot-swaps into `sendInterpreter` via
  `WakeWordModule.setSendModelFromBase64`.

Differences from `ExitPhraseTrainer`:
- No `companionId` prop — the send word is global.
- SyncClient methods: `requestSendTraining` /
  `readSendModel` (not `requestExitTraining` / `readExitModel`).
- WakeWordModule method: `setSendModelFromBase64` (not
  `setExitModelFromBase64`).
- Storage key: `cyberclaw-send-samples-<phrase>` (not
  per-companion).

### `src/screens/WakeModeScreen.tsx` (big)

- New `stopAndSendRecording(triggerReason)` callback —
  shared stop-and-send path used by both the silence timer
  and the new send-word listener. Trigger reason is one of
  `'silence' | 'send'` (used only for logging).
- Two new refs:
  - `speechDetectedDuringRecordingRef` — set true if any
    speech-classifier event fired during the turn OR the
    periodic VAD crossed the speech threshold
    (`rms > 0.03 && zcr > 0.02`). Reset at the start of each
    recording turn. Drives the gibberish gate.
  - `stopInFlightRef` — guards against double-fire when
    silence timer and send word race for the same recording.
    First caller wins; subsequent calls bail. Reset at the
    start of each recording turn.
- `stopAndSendRecording` runs the gibberish gate BEFORE
  shipping audio to STT. If no speech was detected during
  the turn, the recording is dropped and (in voice mode) the
  loop restarts a fresh recording turn.
- The old inline silence-handler logic (stop → count 3 →
  send) is gone; the silence timer now just calls
  `stopAndSendRecording('silence')` after the countdown.
- New effect: listens for `owwSendDetected` and calls
  `stopAndSendRecording('send')`. Guarded by `sendFiredRef`
  to prevent back-to-back send fires within the same turn.
- New effect: listens for `owwVad` and updates
  `speechDetectedDuringRecordingRef`.
- New `stopAndSendRecordingRef` mirroring the existing
  `startRecordingTurnRef` pattern (so the owwSendDetected
  listener can call into the latest closure without
  re-binding the effect on every render).

### `src/screens/SettingsScreen.tsx`

- New state: `voiceSendPhrase` (default `'send'`),
  `voiceSendPhraseSavedAt`, `showSendPhraseTrainer`.
- Hydration: reads `cyberclaw-send-phrase` on mount.
- New UI block: text input + Save button + "Train send word"
  button. Lives right after the silence-timer slider in the
  Listening section (the send word is a global, not per-
  companion, setting, so it doesn't fit in the Companions
  section).
- Trainer modal render: `showSendPhraseTrainer` opens
  `SendPhraseTrainer` (no companionId, since send is global).

## Files

- Edited: `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt`
  (TripleScores, sendInterpreter slot, hot-swap + threshold
  methods).
- Edited: `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (listening loop runs send + emits owwVad, three new
  @ReactMethod bridges, computeEnergyAndZcr helper).
- Edited: `src/services/VoiceSettings.ts` (sendPhrase field,
  storage keys, save/load helpers).
- Edited: `src/services/SyncClient.ts` (requestSendTraining +
  readSendModel + latest-result query).
- New: `src/components/SendPhraseTrainer.tsx` (mirror of
  ExitPhraseTrainer for the global send word).
- Edited: `src/screens/WakeModeScreen.tsx` (shared
  stopAndSendRecording, gibberish gate, owwSendDetected +
  owwVad listeners, ref mirrors).
- Edited: `src/screens/SettingsScreen.tsx` (send-phrase
  hydration, UI block, trainer modal).
- Edited: `package.json` (3.5.2 → 3.6.0).
- Edited: `android/app/build.gradle` (versionCode 192 → 200,
  versionName 3.5.2 → 3.6.0).

## Verification

`tsc --noEmit` is clean apart from the pre-existing stray `/>`
on `HomeScreen.tsx:2584` (carried from much earlier, not from
this release).

Brace/paren balance check on both edited `.kt` files passes
(51/51, 259/259 braces; 140/140, 725/725 parens).

To smoke-test on device:

1. Install v3.6.0 over v3.5.2 (or fresh).
2. Open Settings → Listening → "Train send word (6 samples)".
   Train "send" (or whatever you prefer). Default "send"
   works out of the box if you don't train a custom model.
3. Wake → voice mode opens → say something → say "send" →
   turn commits immediately (no 3-second countdown).
4. **Gibberish gate:** Open voice mode in a noisy
   environment. Have friends talk for 30 seconds without
   saying the wake word. The silence timer will fire at
   whatever silenceMs is set to, but the recording will be
   dropped at send time (VAD never crossed threshold).
   Voice mode loops back to listening without sending
   garbage to the LLM.
5. **Combined:** Say "thanks" — voice mode closes. Say
   "send" during a turn — turn commits, conversation
   continues. Both work alongside the silence timer.
6. **Threshold tuning:** If the send classifier fires too
   often or not often enough, retrain with more samples or
   pick a more distinctive word (e.g. "over" instead of
   "send").

## What v3.6.0 deliberately does NOT do

- **Smarter EOU (vocal fry / falling pitch / disfluency
  detection).** The gibberish gate covers the gross case
  (no speech at all). A VAD-based turn-end that knows
  "this was a completed thought" is more work and the
  silent-mode send word gives the same UX. Defer to v3.7.
- **Cross-classifier arbitration.** A wake + exit fire on
  the same utterance currently fires both events; the JS
  side handles the conflict (wake wins because it lands
  first in handleWakeWord). Send + exit on the same
  utterance is rare (the user would have to say "thanks"
  and "send" at the same time) and both fire independently;
  the JS-side guards (sendFiredRef, exitFiredRef,
  stopInFlightRef) prevent double-action. If this becomes
  a real issue we can add native-side arbitration.
- **Persistent VAD history across recordings.** Each
  recording turn resets `speechDetectedDuringRecordingRef`.
  A "this room is always quiet" / "this room is always
  noisy" detector across turns would be useful but is out
  of scope.
- **Dynamic threshold per-environment.** Send/exit
  thresholds are user-configurable but static per session.
  Adaptive thresholds based on ambient noise would require
  a calibration step. Punt.
