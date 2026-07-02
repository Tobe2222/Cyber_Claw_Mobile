# v3.5.0 — Exit phrase via openWakeWord ML

## Summary

Exit-phrase detection now runs through a second openWakeWord
classifier slot, parallel to the wake word. Same TFLite
inference, same hot-swap pipeline, same desktop training script.
Speaking the trained phrase exits voice mode immediately without
waiting for STT transcription to come back.

This replaces the long-promised-but-never-shipped runtime
audio-DTW detector (flagged honestly in v3.4.9's ExitPhraseTrainer
status message). The text-fallback matcher is kept as a safety
net during the training window and for soft-ML-fails.

## Native (Kotlin)

- `OpenWakeWordDetector.kt`: dual-classifier support. The
  detector now runs BOTH wake and exit classifiers on the same
  melspec + embedding pass.
  - New `exitInterpreter: Interpreter?` slot.
  - New `setExitModelFromFile(phrase, tflitePath)` mirrors
    `setWakewordModelFromFile`. Hot-swap clears melspec history.
  - `predictScore()` returns `PairScores(wake, exit)` — both
    optional (null when the corresponding classifier isn't
    loaded).
  - `setExitThreshold(Float)` + `getExitThreshold()` for
    runtime threshold tuning.
- `WakeWordModule.kt`:
  - Listening loop checks BOTH classifiers per chunk, each with
    its own `highScoreFrames` counter and 2-second cooldown.
  - New `owwExitDetected` event (parallel to `owwWakeDetected`,
    no wakeword string in the payload).
  - New `setExitModelFromBase64(phrase, base64, promise)`:
    writes to `filesDir/exit_models/<safe_phrase>.tflite`,
    persists `SharedPreferences("exit_models", active_phrase,
    active_path, active_savedAt)`, hot-swaps into the running
    detector.
  - New `setExitThreshold(threshold, promise)`.
  - New `loadOwwSavedExitModel(promise)` — promoted from a
    stale `fun` to a `@ReactMethod` so App.tsx can restore the
    model on app launch. Returns the active phrase or null.

## Mobile (JS / TS)

- `src/services/SyncClient.ts`: three new wrapper methods —
  `requestExitTraining`, `requestLatestExitTrainingResult`,
  `readExitModel`. Wire via the existing default-case emit
  pipeline; `exit_training_progress`, `exit_training_result`,
  and `exit_model_data` events flow through `sync.on(...)` like
  their wake counterparts.
- `src/components/ExitPhraseTrainer.tsx` — major rework:
  - New training flow mirrors `OpenWakeWordTrainer` end-to-end.
    Records 6 samples (unchanged UI), then ships them to the
    desktop via `sync.requestExitTraining(phrase, samples)`.
  - On `exit_training_result.ok`, fetches the .tflite via
    `sync.readExitModel(tflitePath)` and hot-swaps via
    `WakeWordModule.setExitModelFromBase64(phrase, base64)`.
  - Drops the pre-v3.5.0 DTW feature-extraction save path; the
    raw WAVs go to the desktop for ML training instead.
  - Writes an AsyncStorage marker at the legacy
    `cyberclaw-exit-samples-<companionId>-<phrase>` key so the
    "Currently trained" picker list still renders the new
    entries (the marker is `{trainedAt, modelPath}` only —
    no features).
  - Subtitle + status messages updated to reflect "this works
    now, not a future promise."
- `src/screens/WakeModeScreen.tsx`:
  - New `owwExitDetected` listener parallel to `owwWakeDetected`.
    On exit:
    - In voice mode → mirror the existing text-fallback exit
      behavior (play the exit reply, 400ms, close).
    - In plain wake mode → dismiss the wake mode overlay
      (single close-button equivalent).
  - Ref-guarded with `exitFiredRef` to prevent double-firing
    when both ML and STT-text exits trigger close together.
  - Reset on `voiceMode` toggle + unmount.
- `src/screens/HomeScreen.tsx`: skipped. Background-listening
  exits only matter once voice mode opens, and that happens via
  WakeModeScreen's listener. Background-detected exit (e.g.
  from `BackgroundService`) is out of scope and would need
  parallel foreground-service work.
- `App.tsx`: after `initOww`, calls
  `WakeWordModule.loadOwwSavedExitModel()`. Trained model
  auto-restores on every app launch. Falls back to text-fallback
  matcher on null/failure.

## Desktop

- `src/sync-server.js`: three new WS cases route mobile →
  desktop messages to the training subsystem via the same
  event-emit pattern as wake:
  - `request_exit_training` → emits `exit_training_request`.
  - `get_latest_exit_training_result` → cache replay.
  - `read_exit_model` → base64 back as `exit_model_data`.
- `src/main.js`: new `exit_training_request` handler (~110
  lines, parallel to `wake_training_request`). Same Python
  training script (`scripts/train_wake_phrase.py` — openWakeWord
  doesn't care about semantic phrase), routed to
  `~/.openclaw/cyberclaw/exit-training/<safe_phrase>/output/`.
  Same `--name exit_<safe_phrase>` naming convention.
- 15-minute result cache + last-progress cache, single-keyed
  by safe-phrase (since exit phrases are user-level, not
  per-companion). Exposed via `syncServer._getCachedExitResult`
  and `syncServer._getLastExitProgress`.

## Migration

- No data migration. Old `cyberclaw-exit-samples-<companion>-
  <phrase>` keys from the pre-v3.5.0 DTW feature cache are
  unused by the v3.5.0 path (the trainer writes new shapes
  under the same key prefix) and can be left for a future
  cleanup commit.

## Constraints

- The exit model is user-level (one active phrase). Per-
  companion exit phrase from v3.4.0 still works at the text-
  fallback level (`cyberclaw-exit-phrase-<companionId>`), but
  the ML detector uses the single most-recently-trained
  phrase. Re-training replaces the previous exit model. This
  matches how the wake-word wake flows in the existing app —
  multi-companion wake is also single-active in practice.
- Text-fallback exit (`ExitPhraseMatcher` on STT transcription)
  remains wired up as a safety net. v3.5.0 just made ML the
  faster path.
