# v3.9.4 — Send-phrase (and exit-phrase) detection during voice-mode recording

Tobe's v3.9.3 follow-up: "I tried the send phrase but that
did not trigger either, that needs to be listened for at all
times during user speech."

The v3.9.3 release fixed the VAD gibberish-gate so the
JS-side `speechDetectedDuringRecordingRef` flag flips true
during voice-mode turns (it now reads from
`MediaRecorder.maxAmplitude` polled every 500ms). But the
send-phrase itself still doesn't fire mid-recording — Tobe
says he has to wait for the natural pause + silence timer
to send. The current `owwSendDetected` event only fires
from the openWakeWord listening thread, which is explicitly
stopped (`isOwwListening = false`) the moment the recorder
grabs MIC to prevent dual audio reads.

## Root cause

Two threads can't both hold MIC simultaneously on Android
(one client per stream type). Three viable architectures:

1. **Keep OWW thread running** — `rec.read()` returns 0
   while MIC is held by the recorder, so the OWW thread
   loops without processing anything. Send detection stays
   broken. (The v3.9.3 status quo.)
2. **Mix OWW + recorder AudioRecord** — needs mixing /
   echo-cancellation work to be safe. Risky.
3. **Switch recorder to raw PCM** — `AudioRecord` produces
   PCM16 chunks natively; feed them to the existing
   `OpenWakeWordDetector.predictScore(pcm16: ShortArray)`
   on the recorder thread, parallel to how the OWW thread
   already does it.

v3.9.4 picks option (3).

## Fix

`android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:

`startRecorderWithSilence()` now uses `AudioRecord` (16kHz,
mono, PCM16) instead of `MediaRecorder` (compressed m4a).
The new recorder thread:

- Reads in 80ms chunks (1280 samples @ 16kHz — the
  openWakeWord natural frame size, same as the OWW thread).
- For each chunk: calls `detector.predictScore(chunk)` →
  checks `sendScore >= sendThreshold` with the same
  `HIGH_SCORE_RUN = 3` (240ms confirmation) + 2000ms
  cooldown pattern as the OWW thread. On hit, emits
  `owwSendDetected` with the same `{score, sendword}`
  payload. The existing `WakeModeScreen.tsx:1414` handler
  picks it up unchanged and calls `stopAndSendRecording('send')`.
- **Same for exit-phrase** — the v3.5.0 `owwExitDetected`
  path has the exact same architectural issue, fix for free.
  Emit `owwExitDetected` from the recorder thread on
  `exitScore >= exitThreshold` with the same cooldown.
- **Skip wake-score** — wake-word is for wake-mode only.
  In voice mode we're past the wake step.
- Computes RMS + ZCR from the real PCM chunk and emits
  `owwVad` at ~1Hz cadence (same cadence as the OWW
  thread; the v3.9.3 VAD gibberish-gate behavior is
  preserved, but the RMS is now real PCM energy instead of
  `maxAmplitude/32767` — a strict upgrade since
  `maxAmplitude` was a peak over the last ~200ms while
  RMS averages the chunk).
- Keeps the v3.2.23 wait-for-speech-then-silence model:
  `hasUserSpoken` flips true when RMS ≥ 0.01 (typical
  spoken-speech level), `silentFor` accumulates silence
  until `silenceMs` post-speech → emits `recorderSilence`.
  30s MAX_RECORDING_MS hard cap fires silence regardless.

The OWW listening thread is explicitly stopped at
`startRecorderWithSilence()` entry (it held MIC) and
restarted at `stopRecorder()` exit if it was running
before the recording turn started. The flag
`owwWasListeningBeforeRecord` captures the pre-state so
voice-mode loops don't keep restarting OWW.

## File format change

The old recorder produced compressed m4a (MediaRecorder).
The new recorder writes **raw PCM16 as a standard WAV
file** (16kHz, mono, 16-bit, little-endian). Same WAV
header layout used elsewhere in the file (the
`writeWav()` helper already exists for `startSampleRecord`).

**JS callers updated** to use `.wav` extension on the temp
path and `audio/wav` MIME type when sending to the desktop:

- `src/screens/HomeScreen.tsx` (3 `recPath` constructions
  + 5 `sendAudioInput` calls)
- `src/screens/WakeModeScreen.tsx` (1 `recPath` + 1 mime)
- `src/features/WakeWordMode.ts` (2 path constructions +
  1 mime in docstring)
- `src/services/SyncClient.ts` (default `mimeType`
  parameter)
- `src/components/OpenWakeWordTrainer.tsx` (3 filename
  strings — wake sample files)
- `src/services/SimpleAudioRecorder.ts` (doc comments)
- `WAKE_WORD_FLOW.md` (one inline reference)

**Desktop impact**: the wire payload's `mimeType` is now
`audio/wav`. whisper.cpp accepts WAV natively, but the
desktop's `whisper:transcribe` handler (out of scope here,
lives in the desktop repo) needs to honor the new MIME.
Tobe should sync the desktop before testing end-to-end.

## API compatibility

The JS-facing `startRecorderWithSilence(filepath,
silenceMs)` signature is unchanged. `SimpleAudioRecorder.start()`,
`stop()`, `isSilenceDetected()`, `dispose()` all work the
same. The only JS-visible difference is that the returned
filepath from `stop()` now contains WAV bytes instead of
m4a — handled by the per-caller path-extension updates
above.

## Out of scope

- **Wake-score during recording** — by design. In voice
  mode we're already past the wake step; re-arming wake
  detection mid-turn would be confusing (wake-word during
  a sentence would close voice mode mid-thought).
- **Wake-score with concurrent detector calls** — the
  detector's `melspecHistory` is not thread-safe. The
  current design (stop OWW → start recorder → stop
  recorder → restart OWW) keeps detector calls serialized.
- **Real-time pcm-to-base64 streaming** — the recorder
  thread accumulates PCM in memory (~960KB for a 30s
  recording) and writes the full WAV on stop. For longer
  recordings a streamed file-append approach would be
  needed; 30s cap keeps the in-memory buffer bounded.

## Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (rewrote `startRecorderWithSilence` + `stopRecorder`;
  added recorder-thread state, `processRecorderChunk`,
  `tryRestartOwwAfterRecord`, `stopOwwListeningInternal`,
  `noOpPromise` helpers; ~+260/-110)
- `src/services/SimpleAudioRecorder.ts` (doc comments;
  m4a → WAV)
- `src/screens/HomeScreen.tsx` (`.m4a` → `.wav` on 3
  paths + 5 mime types)
- `src/screens/WakeModeScreen.tsx` (`.m4a` → `.wav` on
  1 path + 1 mime type)
- `src/features/WakeWordMode.ts` (`.m4a` → `.wav` on
  2 paths + 1 mime in docstring)
- `src/services/SyncClient.ts` (default mime type)
- `src/components/OpenWakeWordTrainer.tsx` (3 sample
  filename extensions)
- `WAKE_WORD_FLOW.md` (one inline path reference)
- `package.json` (3.9.3 → 3.9.4)
- `android/app/build.gradle` (versionCode 225 → 226,
  versionName "3.9.1" → "3.9.4")

## Verification

Build:
- `./gradlew :app:compileDebugKotlin --offline` passes
  cleanly.
- `./gradlew :app:assembleDebug --offline` fails on a
  **pre-existing** Ninja/CMake toolchain issue
  (`Could not find Ninja on PATH or in SDK CMake bin
  folders`) — verified by stashing my changes and
  re-running on the v3.9.3 baseline, which fails the
  same way. Not related to this release. The Kotlin
  compile + Java compile both pass.
- `npx tsc --noEmit` reports 1 error in
  `src/screens/HomeScreen.tsx:2666` (TS1381 — pre-existing
  on v3.9.3 baseline, unrelated to my changes).

Test plan after install (assuming the desktop pipeline
has been updated to accept WAV):

1. Open voice mode, say "what's the weather" then say
   "send it" → log shows `📤 Send ML detected` within
   ~240ms of "send" ending; recording stops; STT sees
   the full utterance including "send" (which the JS
   side already filters out before sending).
2. Open voice mode, stay silent for the configured
   silenceMs → log shows `⏳ Silence detected...`;
   `recorderSilence` fires from the same wait-for-speech
   path as before. No regression.
3. Train a custom exit phrase (e.g. "goodbye"), open
   voice mode, say the exit phrase mid-sentence → voice
   mode closes (same handler as the OWW thread's exit
   path).
4. Verify the recorded `.wav` plays in a standard audio
   player (e.g. `ffprobe file.wav` should report
   `pcm_s16le, 16000 Hz, mono`).
5. Verify the desktop STT pipeline accepts the WAV
   (requires desktop-side update if not already done).

## Companion release

**Desktop-side change required**: the `whisper:transcribe`
handler (or equivalent) must honor the new `mimeType:
'audio/wav'` field on the `audio_input` wire message.
This lives in the desktop repo and is explicitly out of
scope for this mobile-only release. Tobe needs to sync
the desktop before end-to-end testing.