# v3.2.0 — Custom wake-word training end-to-end (mobile + desktop)

## Background

The desktop shipped the openWakeWord training pipeline in v3.1.37:
record user samples → desktop trains a TFLite model with Piper TTS
synthesis + DNN → ship back. The mobile had no way to drive that flow
— only the desktop's local renderer could invoke the IPC handlers.

The existing `WakeWordTrainerV2` was a DTW-based local trainer that
didn't use the desktop at all. It needed to be replaced with a flow
that:

1. Records 6 user samples of the wake phrase on the phone
2. Sends them to the desktop via the sync-server WebSocket
3. Streams progress events back as the desktop trains
4. On completion, fetches the .tflite as base64
5. Hot-swaps the .tflite into the running OpenWakeWordDetector
6. Persists the .tflite so it survives app restarts (per-agent)

## What ships in v3.2.0

### Desktop-side wire-up (the missing IPC bridge)

The desktop v3.1.36 added two IPC handlers (`agent:train-wake-phrase`,
`agent:read-wake-model`) but they were only callable from the
desktop's own renderer. The mobile had no way to reach them.

**Sync-server protocol additions** (`src/sync-server.js`):
- `request_wake_training { agentId, phrase, samplePaths }` — mobile
  kicks off a training job. The sync-server emits a
  `wake_training_request` event which main.js picks up and runs the
  same `train_wake_phrase.py` subprocess the renderer flow uses.
- `read_wake_model { tflitePath }` — mobile fetches the bytes of a
  trained .tflite as base64. The sync-server reads the file and
  sends back a `wake_model_data` message.

**Main process handler** (`src/main.js`):
Listens for `wake_training_request` on the sync-server, copies the
user samples into `~/.openclaw/cyberclaw/wake-training/<agentId>/`,
spawns the Python training subprocess, and forwards `PROGRESS::` and
`OUTPUT_TFLITE::` lines back to the mobile over the WS as
`wake_training_progress` / `wake_training_result` messages.

### Mobile-side SyncClient wrapper (`src/services/SyncClient.ts`)

Two new public methods:
- `requestWakeTraining(agentId, phrase, samplePaths)` — sends the
  training request
- `readWakeModel(tflitePath)` — fetches the .tflite bytes

The default message dispatcher in `_handleMessage` already
re-emits unknown message types via `this.emit(msg.type, msg)`,
so the progress/result/model-data replies come through without
any extra plumbing.

### Kotlin: hot-swap the wake model (`WakeWordModule.kt`)

Four new React methods:
- `setWakeModelFromBase64(agentId, base64, phrase)` — writes the
  .tflite to `filesDir/wake_models/<agentId>.tflite`, persists the
  binding in SharedPreferences, then hot-swaps the wake classifier
  interpreter in the running OpenWakeWordDetector via
  `setWakewordModelFromFile()`. The melspec + embedding models
  stay alive across the swap, so the listening thread isn't
  disturbed.
- `loadOwwSavedModel(agentId)` — applies a previously-saved model
  to the running detector. Called from JS on app start so a
  trained wake word auto-loads.
- `getSavedWakeModels()` — returns a map of all agents that have
  saved custom models (for the "✓ trained" badges in the UI).
- `deleteSavedWakeModel(agentId)` — removes the file + binding.

`OpenWakeWordDetector.kt` gained:
- `setWakewordModelFromFile(tflitePath)` — closes the old
  wake-word interpreter, memory-maps the new .tflite, clears
  the melspec history (the history is biased toward the old
  model's input distribution).
- `loadInterpreterFromFile(path)` — file-path variant of
  `loadInterpreter(assetPath)`. Same memory-mapped approach,
  just reads from `File` instead of `AssetFileDescriptor`.

### Mobile UI: the trainer itself (`src/components/OpenWakeWordTrainer.tsx`)

A new full-screen modal component, ~440 lines. Flow:

1. **Pick phrase.** Pre-filled with `"hey {companionName}"` —
   user can edit.
2. **Record 6 samples.** Tapping the big mic button calls the
   existing `SimpleAudioRecorder` with a 1500ms silence timeout.
   Same UX as the old `WakeWordTrainerV2` but with the
   desktop-driven flow. Listener disabled during recording so the
   user's voice doesn't trigger wake mode mid-training (v3.1.66
   bug, still relevant).
3. **Send to desktop.** Tapping "Train" calls
   `syncClient.requestWakeTraining()`.
4. **Stream progress.** Subscribes to `wake_training_progress`
   events, maps them to stages
   (uploading/generating/augmenting/training/converting), shows
   a progress bar + status text.
5. **Fetch + activate.** On `wake_training_result`, sends
   `readWakeModel()`. On `wake_model_data`, calls
   `WakeWordModule.setWakeModelFromBase64()`. Hot-swap is
   atomic — no thread restart, no missed wake events.
6. **Show success.** The model is now active for this companion.

### Settings entry point (`src/screens/SettingsScreen.tsx`)

Added a new "🧠 Train with AI" button next to the existing
"Wake training" / "Test wake detection" buttons. Routes through
the existing companion picker (single-companion → straight to the
trainer, multi-companion → picker → trainer) via a small
`owwTrainerPending` flag.

The new state vars + back-button handler + render block all
match the existing pattern used by `showTrainingDetail` /
`showWakePhraseMenu` / `showTester`.

## Files

### New
- `src/components/OpenWakeWordTrainer.tsx` — the trainer UI
- `CHANGES_3.2.0.md` (this file)

### Modified
- `src/services/SyncClient.ts` — added `requestWakeTraining()` +
  `readWakeModel()` public methods
- `src/screens/SettingsScreen.tsx` — "Train with AI" button,
  `showOwwTrainer` state, picker routing, modal render
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — `setWakeModelFromBase64`, `loadOwwSavedModel`,
  `getSavedWakeModels`, `deleteSavedWakeModel`; `Base64` import
- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt`
  — `setWakewordModelFromFile`, `loadInterpreterFromFile`
- `package.json` — 3.1.95 → 3.2.0
- `android/app/build.gradle` — versionCode 145→146, versionName
  "3.1.95" → "3.2.0"
- `.github/workflows/build.yml` — artifact name 3.1.95 → 3.2.0
- `.github/workflows/android-build.yml` — debug artifact 3.1.95 → 3.2.0

## Architecture

```
Mobile (Android)                          Desktop (Linux/WSL)
──────────────                            ─────────────────
OpenWakeWordTrainer.tsx                   sync-server.js
  ↓ records 6 samples                       ↓ emits wake_training_request
  ↓                                        main.js
syncClient.requestWakeTraining              ↓ spawns Python
  ↓                                          train_wake_phrase.py
WebSocket message ──────────────────────→  ↓ streams PROGRESS:: + OUTPUT_TFLITE::
                                              ↓
                                            ~200KB .tflite on disk
                                              ↓
  ← wake_training_progress events ───────  main.js forwards via sendToMobile
  ← wake_training_result { tflitePath } ─  
  ↓
syncClient.readWakeModel(tflitePath)
  ↓
  ← wake_model_data { base64 } ───────────  sync-server reads file
  ↓
WakeWordModule.setWakeModelFromBase64
  ↓ writes .tflite to filesDir/wake_models/<id>.tflite
  ↓ persists binding in SharedPreferences
  ↓ calls owwDetector.setWakewordModelFromFile(path)
       ↓ closes old interpreter
       ↓ memory-maps new .tflite
       ↓ clears melspec history
       ↓ listening thread is UNINTERRUPTED — no missed wake events
```

## End-to-end test plan

When the user has a phone paired to a desktop with a working
openWakeWord env (`scripts/setup_training_env.sh`):

1. Open Settings → Wake Word → "🧠 Train with AI"
2. Type a phrase (e.g. "hey clawsuu")
3. Tap the big mic 6 times, saying the phrase each time
4. Tap "Train"
5. Watch the progress bar cycle through:
   - "📤 Sending samples to desktop..."
   - "🗣️ Generating wake samples with AI voice..." (1-3 min)
   - "🔊 Augmenting..." (~10s)
   - "🧠 Training neural network..." (1-10 min)
   - "📦 Converting model to phone format..." (~3s)
   - "⬇️ Downloading trained model..." (~1s)
   - "✅ Activating on this device..."
6. Tap "✓ Done"
7. Say the trained phrase — the wake word fires

If the user closes the app during training: the desktop keeps
going. When the user reopens the app and visits the same companion,
`loadOwwSavedModel` applies the persisted model automatically.

## Lessons / decisions

- **Hot-swap, don't re-init.** A full `initOww` would close the
  AudioRecord and listening thread, causing a window where wake
  events are missed. `setWakewordModelFromFile()` swaps only the
  wake-word classifier — the melspec + embedding interpreters and
  the recording loop stay alive. The melspec history is cleared
  (it's biased toward the old model's expected input distribution)
  but that costs <100ms of warmup.

- **Sync-server is the IPC layer, not the renderer.** Calling
  `ipcMain.handle('agent:train-wake-phrase', ...)` from main.js
  itself doesn't work (the IPC handler expects to be invoked from
  a renderer webContents). Going through the sync-server's
  `EventEmitter` pattern lets main.js run the same Python
  subprocess that the renderer's IPC handler runs, with shared
  progress + done events.

- **Base64 over WebSocket for the .tflite.** 200KB base64-encoded
  is ~270KB on the wire, takes <1s on a local network. Avoids the
  complexity of chunked binary transfers. If we ever need to ship
  larger models (or want streaming), this is the spot to swap
  for a binary protocol.

- **Per-agent model persistence, not per-app.** Each companion
  has its own wake word and its own .tflite. SharedPreferences
  keys are namespaced by agentId so they don't collide. The
  SharedPreferences entry is `wake_model_<agentId>_*`. The .tflite
  files live in `filesDir/wake_models/<agentId>.tflite` and are
  cleaned up if the binding goes stale (file deleted out from
  under the app).

- **Don't re-run through openWakeWord's deprecated `onnx_tf`
  conversion path on the mobile.** The .tflite the desktop ships
  is already the correct shape (1, 16, 96) thanks to the manual
  Keras rebuild in v3.1.37. The mobile just writes the bytes
  verbatim and memory-maps them.

- **Backwards compat with the pre-trained models.** The
  `setWakewordModelFromFile` only swaps the wake interpreter. The
  melspec + embedding models are still loaded from
  `assets/openwakeword/`. If the user deletes a saved custom
  model and the binding is stale, `loadOwwSavedModel` returns
  null and the existing `initOww('hey_jarvis')` flow takes over
  (or whatever the agent's pre-trained fallback is).

## Out of scope (deferred)

- **Visual feedback for "trained" badges in the wake menu.** The
  data is there (`getSavedWakeModels()`) but the menu UI doesn't
  yet query + display it. Easy follow-up: add a "✓ trained" line
  next to each companion in `WakePhraseMenu.tsx`.
- **Re-train UI flow** (delete a model and re-train without
  leaving the trainer screen). The data plumbing is done
  (`deleteSavedWakeModel`), just no UI button for it yet.
- **Multi-language wake phrase support.** The pipeline works for
  any phrase, but the Piper voice model is en-US LibriTTS only.
  Adding more voices is a one-line `OPENWAKEWORD_PIPER_MODEL` env
  change.