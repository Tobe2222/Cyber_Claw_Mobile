# 3.1.66 — Wake trainer: stop wake listener + shorter recording

## What it fixes
Tobe: "When training more wake samples the wake word triggered. That should be disabled during that. And for some reason the wake trainer wanted the recording to be longer in duration, making my attempts invalid. The minimum Length should be very short. Less than half of what it is now. Perhaps people want very short wake words"

## Bug 1: Wake word triggers during training

### Cause
The native wake word listener is a long-lived native module. The trainer says "hey clawsuu" multiple times to record samples — and every "hey clawsuu" the user says matches the wake phrase and triggers wake mode. The trainer was being killed by its own training data.

### Fix
Stop the wake listener when training starts (in `startRecording`):
```ts
try { await WakeWordModule?.stopSampleListening?.(); } catch (_) {}
```

Restart it when the trainer unmounts:
```ts
useEffect(() => {
  return () => {
    try { WakeWordModule?.startSampleListening?.(); } catch (_) {}
  };
}, []);
```

The user can use wake mode again after training (the listener is restored on unmount).

## Bug 2: Recording always 4 seconds

### Cause
The trainer used a hard `setTimeout(stop, 4000)` to end the recording. The recorder's `silence` event was never listened to. So every training sample was at least 4 seconds — way too long for a 1-word wake phrase like "Hey". The user is trying to provide short wake words but the trainer rejects them.

### Fix
Listen for the recorder's `silence` event to stop the recording as soon as the user finishes speaking. Use a short silence timeout (1500ms) so the recording ends quickly after the user stops talking. Fall back to a hard 3s max duration in case the user keeps talking.

```ts
const SILENCE_TIMEOUT_MS = 1500;
const MAX_DURATION_MS = 3000;
await recorder.start(path, SILENCE_TIMEOUT_MS);

let stopped = false;
const stopRecording = async () => {
  if (stopped) return;
  stopped = true;
  clearTimeout(maxTimer);
  try { unsubSilence(); } catch (_) {}
  // ... stop and process
};

const unsubSilence = recorder.once('silence', () => {
  stopRecording();
});

const maxTimer = setTimeout(() => {
  stopRecording();
}, MAX_DURATION_MS);
```

The 1500ms silence timeout is less than half the previous 4000ms hard timeout. Most short wake words (single word, 0.5-1s) will end with 1-1.5s of silence, triggering the stop within 1.5s of the user finishing. The 3s max catches the case where the user keeps talking or never talks.

## Files changed
- `src/components/WakeWordTrainerV2.tsx` — stop wake listener in startRecording, restart on unmount; listen for recorder's `silence` event with 1500ms timeout; 3s max duration fallback; imports `NativeModules`
- `package.json` — 3.1.65 → 3.1.66
- `android/app/build.gradle` — versionCode 115 → 116, versionName "3.1.66"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.66
- `CHANGES_3.1.66.md` (new)

## Lesson: native listeners don't pause with React components
The wake listener is a native module — it doesn't pause when the React UI changes. Any UI that captures audio (trainer, recorder, fullscreen voice mode) needs to explicitly stop the listener, or the user's own voice will trigger the wake word during normal use.

The pattern should be: any component that owns the audio input should stop the wake listener on mount and restart it on unmount. This applies to:
- WakeWordTrainerV2 (training)
- VoiceModeScreen (when recording, via VAD + recorder)
- SettingsScreen (when in a sub-screen that captures audio)
- Anywhere else that has its own audio pipeline

## Lesson: short timeouts for short inputs
The previous 4000ms hard timeout was wrong — it assumed every wake word is 4 seconds long. The fix is to listen for the actual signal (silence after the user finishes speaking) and use a SHORT timeout (1.5s) so short inputs are captured quickly. The hard max duration (3s) is a fallback, not the primary signal.

The user's framing was right: "the minimum length should be very short, less than half of what it is now." 1500ms is 37.5% of 4000ms. Matches their request.
