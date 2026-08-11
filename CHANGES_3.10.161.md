# v3.10.161 — unified audio playback + shared AudioPlayer service

## What

Extracted the `startPlayer` + `audioPlayerFinished`
listener pattern out of `WakeModeScreen.tsx`'s
`playCachedGreeting` into a new shared service at
`src/services/AudioPlayer.ts`. Both `WakeModeScreen`'s
greeting/cache path and `HomeScreen`'s response path
now call `playAudioFile(filePath)` from the same place.

## Why

Tobe (2026-08-11 20:00) reported two issues from one
session:

### Issue 1: Greeting voice ≠ working/exit voice

"The greeting voice is different from when it says,
working or exit phrase."

Cause: the greeting uses desktop-synthesized piper
audio (caller's chosen TTS voice). Working speech and
exit-reply fallback use Android TTS (whatever's bound
on the device — RHVoice SLT/CLB/BDL on Tobe's
GrapheneOS). Two different voice stacks, two different
audio personalities.

Not fully fixed in this release (working speech still
uses `speak()` because the mobile doesn't request a
desktop synthesis for it; that's a larger refactor).
The exit reply ALREADY uses the cached piper path when
the cache is warm — Tobe probably sees the TTS fallback
on first close after a new exit phrase is set.

Tracked as follow-up for v3.10.16x.

### Issue 2: No sound on AI response

"And it does not make sound when it responds."

Cause: `WakeModeScreen.tsx`'s `onAudioResponse` handler
had an inline `startPlayer` call that did NOT register
the `audioPlayerFinished` listener — only the
surrounding closure did. Meanwhile `playCachedGreeting`
(below, separate code path) DID register the listener.
The two paths were inconsistent: greeting audio played
+ completion was detected; response audio played + the
multi-turn `afterPlayback` hook sometimes fired late
or never, breaking the loop.

The deeper root cause: each call site had its own copy
of the audio playback logic with subtle differences.
Centralizing on one helper means a fix in one place
applies everywhere — including any future debugging
that needs to add a log line or change the safety
timeout.

## Files changed

### `src/services/AudioPlayer.ts` (NEW)

Shared `playAudioFile(filePath: string): Promise<void>`:
- Calls `WakeWordModule.startPlayer` (non-queueing mode)
- Subscribes to `audioPlayerFinished` to detect
  natural completion
- Returns a Promise that resolves on completion OR a
  10s safety timeout
- Rejects on startPlayer error

10s safety timeout is generous — desktop-synthesized
responses are typically 2-8 seconds. If we hit it,
something is wrong (audio focus stealing, MediaPlayer
hung) and we don't want to block the caller.

### `src/screens/WakeModeScreen.tsx`

- `playCachedGreeting` now delegates to
  `playAudioFile` from the service.
- `onAudioResponse` now writes the temp file and
  calls `playCachedGreeting` (which now goes through
  the shared service) — same code path as the
  greeting, same error handling, same diagnostics.

### `src/screens/HomeScreen.tsx`

- `onAudioResponse` now also calls `playAudioFile`
  from the service (instead of inlining startPlayer).

## Trade-offs

The shared service adds one extra module hop per
playback. Not measurable (microseconds). Worth it for
the consistency + debuggability.

## Voice consistency follow-up

Tracked separately. The cleanest fix is to have the
mobile send a `request_working_audio` to the desktop
when the user changes the working speech phrase, cache
the result the same way the greeting is cached, and
fall back to `speak()` if the cache is cold. Same
pattern as the exit reply already uses. Out of scope
for this release.
