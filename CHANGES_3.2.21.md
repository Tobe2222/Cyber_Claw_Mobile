# 3.2.21 — Voice mode plays response audio

## Reported by Tobe

After v3.2.21 desktop fix (audio → LLM pipeline restored),
Tobe reported the LLM was replying (response text appearing
in the voice log: "Hey! Why did the cookie cry, because
its...") but no audio played. Screen showed "Responding..."
but the mobile was silent.

## Root cause

`onAudioResponse` in `WakeModeScreen.tsx` (the handler
for `audio_response` events from the desktop) was setting
up `afterPlayback` callbacks (timer-based + listener-based)
but **never actually invoking the native audio player**.
The `startPlayer` call was missing.

The HomeScreen `onAudioResponse` handler has had the
correct decode-base64-to-temp-file + `startPlayer` pattern
since v3.1.91 — it just wasn't copied to WakeModeScreen
when the wake-mode/voice-mode paths diverged.

Net result: the desktop sent `audio_response` with the
TTS audio, the mobile logged "audio response from desktop",
then nothing. The user saw the LLM text in the log but
heard silence.

## v3.2.21 fix

Copied the HomeScreen pattern into WakeModeScreen's
`onAudioResponse`:

```ts
if (msg.audioBase64) {
  const fs = require('react-native-fs');
  const ext = (msg.mimeType?.includes('wav')) ? 'wav' : 'mp3';
  const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-wakemode-response-${Date.now()}.${ext}`;
  await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
  await WakeWordModule?.startPlayer?.(tmpPath);
}
```

The `audioPlayerFinished` listener that was already wired
up now fires correctly (because the player actually runs).
The voice-mode loop continues to the next recording turn
when `afterPlayback` fires.

## Files

- `src/screens/WakeModeScreen.tsx` — `onAudioResponse`
  now decodes base64 to temp file and calls `startPlayer`
- `package.json` 3.2.20 → 3.2.21
- `android/app/build.gradle` versionCode 166 → 167,
  versionName 3.2.20 → 3.2.21
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.21

## Lessons

- **"Response received" ≠ "response handled".** The
  v3.2.21 desktop fix made the LLM reply. The mobile
  received the `audio_response` event. The log line
  "audio response from desktop" appeared. But the actual
  audio playback step was missing — the chain ended at
  "received" without ever doing "played". Logs that say
  "received" or "got X" need to be paired with a follow-up
  log that confirms "used X" or "played X", otherwise the
  silent skip goes unnoticed.
- **"Copy the working code, not the comment that says
  it works."** The HomeScreen handler had the correct
  pattern; WakeModeScreen had comments claiming it worked
  but no playback code. When refactoring split paths,
  grep the OTHER file for the actual implementation —
  comments don't ship, code does.
- **Two paths that look the same will silently miss
  the same features.** WakeModeScreen and HomeScreen
  both listen for `audio_response`. They were written
  at different times. Each one had a different
  completeness. v3.1.91 added playback to HomeScreen;
  WakeModeScreen was never updated. Any time two
  components handle the same event, audit BOTH for
  completeness on every event-related change.