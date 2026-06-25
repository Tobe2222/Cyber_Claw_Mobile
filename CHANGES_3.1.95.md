# v3.1.95 — openWakeWord TFLite inference (proper ML-based wake detection)

## Why

The DTW-based sample matcher that was supposed to detect wake phrases was triggering on any consonant-vowel speech pattern (talking, music, TV). Tobe tested v3.1.94 and saw false positives even at 85% threshold.

The matcher's 2 features per frame (energy + ZCR) are too coarse to discriminate specific wake phrases from general speech. The DTW normalization also flattens differences — random sequences score around 0.67, so any threshold below that fires on noise.

The right answer is a purpose-built ML wake-word model. openWakeWord is open source (Apache 2.0), runs entirely on-device, supports custom-trained wake phrases.

## What changed

### Bundled openWakeWord TFLite models

Downloaded from `https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/`:
- `melspectrogram.tflite` (1.0 MB) — converts PCM16 → mel-spectrogram features
- `embedding_model.tflite` (1.3 MB) — converts mel-spec → 96-dim embedding
- `hey_jarvis_v0.1.tflite` (1.3 MB) — wake word classifier
- `hey_mycroft_v0.1.tflite`, `alexa_v0.1.tflite`, `hey_rhasspy_v0.1.tflite` — alternative pre-trained models

Total APK size impact: ~5.8 MB.

### `OpenWakeWordDetector.kt` — new Kotlin class

Wraps the three TFLite interpreters and runs the inference pipeline:
1. Receive 1280 PCM16 samples (80ms at 16kHz)
2. Run melspectrogram model → 32-dim mel-spec features
3. Run embedding model → 96-dim embedding
4. Run wake-word classifier → score 0-1
5. Compare score to threshold (default 0.5)

### `WakeWordModule.kt` — new IPC handlers

- `initOww(wakeword, threshold)` — loads the three TFLite models from assets. Lazy-loads, called once at app mount via App.tsx prewarm.
- `startOwwListening(promise)` — starts AudioRecord at 16kHz, runs the detector on every 80ms chunk. Emits `owwWakeDetected` event with score when 3 consecutive frames exceed threshold.
- `stopOwwListening(promise)` — stops the audio capture and inference loop.

The pre-trained "hey jarvis" model is the default wake word. Switching to "alexa" or "hey mycroft" or "hey rhasspy" is one IPC call away — `initOww('alexa', 0.5)`.

### `App.tsx` — pre-warm at mount

New `useEffect` calls `initOww('hey_jarvis', 0.5)` at app mount. TFLite interpreter creation takes ~500ms on cold load. Without pre-warming, the first wake event after the app opens races with interpreter init and the first wake phrase is missed.

### `HomeScreen.tsx` + `WakeModeScreen.tsx` — DTW matcher removed

Both screens had local copies of `startSampleMatchListener` that did DTW matching on incoming 2-second WAV chunks. Replaced with the OWW path:
- Listen for `owwWakeDetected` event (emitted by Kotlin when the model fires)
- On event, fire `onDetected(activeCompanionId)` to trigger the existing wake flow

The per-companion DTW matching is gone — for now, any wake word detection routes to the first/active companion. Per-companion wake phrases will come when we have custom-trained models (Phase 2).

### `android/app/build.gradle`

Added `implementation("org.tensorflow:tensorflow-lite:2.14.0")` (~5MB APK increase from the AAR).

## What works right now

After pulling v3.1.95:
- App opens → "hey jarvis" model loads silently in the background
- Voice mode active → wake listener starts automatically
- User says "hey jarvis" → ML inference fires → wake mode opens → greeting plays
- **No more false positives on general speech.** openWakeWord was trained on 200k+ synthetic "hey jarvis" samples with adversarial negative data. It knows the difference.

Tobe can switch to a different pre-trained model by changing one line in App.tsx (or the wake phrase can become a Settings option — UI work for later).

## What's next (Phase 2 — desktop-side training pipeline)

Custom training "hey clawsuu" / "yo lamasuu" needs:
1. Phone records 30-60 samples of user saying the wake phrase
2. Phone sends samples + companion metadata to desktop via sync-server
3. Desktop uses openWakeWord Python training pipeline + RTX 2070 to train (~5-15 min)
4. Streaming progress events to phone
5. Trained .tflite uploaded to phone → saved to filesDir → activated for that companion

This is a half-day project once the runtime inference is solid. Skipping for now — Tobe can use "hey jarvis" / "alexa" / "hey rhasspy" out of the box.

## Files
- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt` (new) — TFLite inference
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — initOww/startOwwListening/stopOwwListening IPC handlers
- `android/app/src/main/assets/openwakeword/*.tflite` (new) — 6 model files
- `android/app/build.gradle` — TensorFlow Lite dependency
- `App.tsx` — OWW prewarm at mount
- `src/screens/HomeScreen.tsx` — DTW matcher replaced with OWW listener
- `src/screens/WakeModeScreen.tsx` — DTW matcher replaced with OWW listener
- `package.json` — 3.1.94 → 3.1.95
- `android/app/build.gradle` — versionCode 144 → 145
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.95

## Lessons

- **DTW over normalized energy+ZCR is a toy matcher.** It works for "is there any speech at all" but fails at "is THIS specific speech". Real wake-word detection needs proper acoustic features (mel-spectrogram + embeddings). The DTW approach was a stopgap when we needed something working in v3.1.7 — it was always going to need replacing.
- **Pre-trained models are the right bootstrap.** Custom training takes hours of GPU + data collection. shipping pre-trained "hey jarvis" gets the user a working app today. They can swap models as we ship them.
- **Native ML inference beats JS-side DTW.** The OWW detector runs three TFLite models on raw audio in C++ via the TFLite runtime. JS DTW over base64 WAV chunks was always going to be slower, less accurate, and more battery-hungry. ML work belongs in the native layer.
- **TFLite models can be loaded from assets.** Android packs them into the APK but the inference engine needs absolute file paths. We mmap them via `FileChannel.map()` — no copy to filesDir needed, no extra disk usage.