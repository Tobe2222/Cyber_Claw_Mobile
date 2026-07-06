# v3.6.1

Three small fixes / cleanups on top of v3.6.0.

## 1. SendPhraseTrainer: arg-count crash + racing recorder

`SendPhraseTrainer.tsx:128` was calling
`WakeWordModule.startSampleRecord(wavPath, 2000)`. The native
`@ReactMethod fun startSampleRecord(outputPath: String, promise: Promise)`
declares one JS-side argument. The trailing `Promise` is the resolver,
not a JS arg. So TurboModule rejected with:
> "startSampleRecord" was called with 2 arguments; expected argument count: 1

The `, 2000` was a misread of how the native side works:
`startSampleRecord` does NOT auto-stop. It resolves the JS promise the
moment `AudioRecord.startRecording()` succeeds, then records
indefinitely until `stopSampleRecord()` is called. The WAV is written
and the `sampleRecordDone` event fires only on stop.

So even if we stripped `2000`, the trainer was racing: it `await`ed
the start promise, slept 2100 ms hoping the WAV was ready, then bumped
`isRecordingRef` back to false — but the recorder was still running.
The next "Record sample" press would hit `ALREADY_RECORDING`.

Fix (mirroring `ExitPhraseTrainer.tsx:130-184`):
- Subscribe to `DeviceEventEmitter.addListener('sampleRecordDone', …)`
  and advance the sample count there, using the bytes from the event.
- `startSampleRecord(wavPath)` — no extra arg.
- 4 s safety cap via `setTimeout(..., 4000)` that force-stops the
  recorder if the user never taps Stop.
- Manual Stop button: the existing Record button now toggles to
  "Stop recording" while `stage === 'recording'`.
- Reset `isRecordingRef` and stop the pulse animation on the
  `sampleRecordDone` event (not on the start promise).

## 2. Remove dead "Conversation timeout" config

`audioSettings.conversationTimeoutMinutes` was a write-only field:
declared in `AudioBufferSettings` (AudioBuffer.ts:24), defaulted to 2
(AudioBuffer.ts:32), surfaced in the Settings UI
(SettingsScreen.tsx:1092), saved to AsyncStorage on every change…
but no code path anywhere actually read it. The v3.6.0 codebase has
zero references to it outside of type/default/UI.

Removed:
- Field from `AudioBufferSettings` interface
- Field from `DEFAULT_SETTINGS`
- `<Label>`, `<Hint>`, and option row from SettingsScreen

Comment in SettingsScreen points readers to `lookbackMinutes` as the
only knob that actually governs the audio buffer.

## 3. Remove dead "Recording retention" config

Same problem, same fix. `audioSettings.retentionDays` was declared,
defaulted, surfaced in the UI, and saved — but the "Daily audio logs
are kept locally for this many days, then auto-deleted" hint was
documenting a feature (background daily recording + log rotation) that
is not implemented. The rolling audio buffer is bounded solely by
`lookbackMinutes × CHUNK_DURATION_MS`; no daily log file is ever
written.

Removed:
- Field from `AudioBufferSettings` interface
- Field from `DEFAULT_SETTINGS`
- `<Label>`, `<Hint>`, and option row from SettingsScreen

## Background-listening note (not changed)

The "Background listening" toggle in Settings → 🎧 Listening settings
still only governs the rolling audio buffer that feeds the
`voice_transcript` context (the few seconds the desktop STT pipeline
hears just before the wake word). It does NOT record continuously for
later analysis. A "summarize today's recording" feature is a separate
scope, not part of v3.6.1.

## Files changed

- `src/components/SendPhraseTrainer.tsx` — sampleRecordDone event
  listener, manual Stop, single-arg startSampleRecord, 4 s safety cap
- `src/screens/SettingsScreen.tsx` — remove conversation timeout +
  retention UI rows; update file-header comment
- `src/services/AudioBuffer.ts` — remove conversationTimeoutMinutes +
  retentionDays from type and defaults
