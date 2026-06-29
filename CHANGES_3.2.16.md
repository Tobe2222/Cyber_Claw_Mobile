# v3.2.16 — Wake listener: init OWW with the active companion's trained wake phrase

v3.2.15 made `setScreen('voice-mode')` fire when the wake
word matches, but the user reported the screen stayed in
wake mode. The wake word actually WASN'T matching — the
OWW detector was listening for `'hey_jarvis'` (the
bundled pre-trained model) because WakeModeScreen's
mount-time `startSampleMatchListener` hardcoded
`initOww('hey_jarvis', 0.5)`.

The user's trained model was hot-swapped in via
`setWakeModelFromBase64` (v3.1.20+) which swaps the
wake-word interpreter, but the detector's name
(`owwWakeword`) and `initOww` call were still
`'hey_jarvis'`. The bundled model and the trained
model have DIFFERENT embedding spaces — the detector
looked for `'hey_jarvis'` activations and the user's
`'hey clawsuu'` utterances didn't trigger.

**Fix:** `startSampleMatchListener` now looks up the
active companion's saved wake phrase via
`WakeWordModule.getSavedWakeModels()` and inits OWW
with that phrase. If no trained model exists, falls
back to `'hey_jarvis'`.

**Additionally:** `OpenWakeWordDetector.loadModels()` now
falls back to `filesDir/wake_models/<wakeword>.tflite`
if the bundled asset doesn't exist. Previously it only
looked in `assets/openwakeword/<wakeword>_v0.1.tflite`
which is the bundled-only path; custom-trained models
live in `filesDir/wake_models/` (written by
`setWakeModelFromBase64`). So even if `initOww` was
called with the right phrase, the model file lookup
would fail because there was no bundled asset for it.

The combined fix means: when the user trains a custom
wake word and opens Wake Mode, the OWW detector is
initialized with the trained phrase, and the model
file lookup falls back to the wake_models dir if no
bundled asset exists for that wake word. The wake word
actually triggers.

**Files:**

- `src/screens/WakeModeScreen.tsx` — `startSampleMatchListener`
  reads the active companion's saved wake phrase via
  `getSavedWakeModels()` and inits OWW with it.
- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt` —
  `loadModels()` falls back to `filesDir/wake_models/<wakeword>.tflite`
  if the bundled asset is missing.
- `package.json` — 3.2.15 → 3.2.16
- `android/app/build.gradle` — versionCode 161 → 162
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.16

v3.2.15's setScreen('voice-mode') fix is still in this
build. With v3.2.16, the wake word will actually MATCH
(the detector is initialized with the right phrase and
has the trained model file loaded), and when it does,
the screen will switch to voice mode.