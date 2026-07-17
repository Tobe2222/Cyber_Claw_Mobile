# v3.10.50 — voice-mode late-response retry bug + wake test diagnostic

Two issues from v3.10.49 testing.

## Issue 1: Voice-mode cycle bounces on delayed response

Tobe (post v3.10.49): "the companion started thinking then it
said no response and it was my turn again, then it jumped to
responding shortly after and i got the audio response from the
companion and while it was talking it for some reason said it
was my turn again. This is not how the cycle should be."

### Root cause

The 30-second transcribing timeout fires `setVoiceStatus
('retrying')` then queues `playTurnCueAndWait().then(start
RecordingTurn)`. The cue plays (~1-2s), then
`startRecordingTurn` calls `setVoiceStatus('listening')`
which shows YOUR TURN. Meanwhile, the desktop's response
finally arrives (chat text + audio_response). The chat
sets status to 'responding' and the audio_response
starts playback.

What the user sees:
1. ...thinking → "no response, retrying"
2. → cue plays (1-2s)
3. → **YOUR TURN** (briefly, while recorder opens)
4. → status flips to "responding"
5. → audio plays
6. → audio finishes → **YOUR TURN** (the cycle bounce)

Steps 3-4 are the bug — YOUR TURN visible for 1-2
seconds while the recorder is opening, immediately
overwritten by 'responding'. The cycle feels broken
because the user sees "my turn" twice in close
succession (once before, once after the response).

### Fix

Added a `lateResponseReceivedRef` boolean ref. Set
to `true` by `onChat` (assistant text) and
`onAudioResponse` (synthesized audio) — the two
event paths that constitute "the desktop responded".

The retry path now checks this ref synchronously
before doing anything:

```ts
if (voiceMode) {
  if (lateResponseReceivedRef.current) {
    addLogEntry('🔁 Retry path aborted — late response arrived', 'debug');
    return;
  }
  playTurnCueAndWait().then(() => {
    if (lateResponseReceivedRef.current) {
      addLogEntry('🔁 Retry path aborted — late response arrived during cue', 'debug');
      return;
    }
    startRecordingTurnRef.current?.().then(...).catch(...);
  }).catch(...);
}
```

Two check points: once before playing the cue, and
once after the cue (because a late response can
arrive during the cue's 1-2s playback).

The ref is reset to `false` at the start of
`stopAndSendRecording` (every user turn) so it
tracks the current turn's response, not a previous
turn's.

When the ref is true and the retry aborts:
- Status remains whatever onChat/onAudioResponse set
  it to (likely 'responding')
- The audio_response handler's `afterPlayback`
  function still runs on audio finish → sets
  status to 'listening', shows YOUR TURN
- Net effect: smooth transition from
  thinking → responding (audio plays) → listening
  (YOUR TURN) — same as a non-delayed response

The "no response, retrying" log line still fires (we
don't suppress the timeout message), but the visual
status is now 'responding' instead of bouncing
'retrying → listening → responding → listening'.

## Issue 2: Wake test still peak=0% after v3.10.48

Tobe retested wake after v3.10.48. Same result as
v3.10.47: peak 0%, avg 0%, Mic RMS 0.105, listener
running, diagnostic "model never matched".

The v3.10.48 fix was supposed to re-init the OWW
detector with the user's active wake phrase before
scoring. Either:
- `initOww(wakeword, 0.5)` failed silently (the JS
  catch in `useClassifierTest` swallows the error)
- The init succeeded but the detector still scored
  against the wrong model
- The audio didn't actually contain the wake phrase

Without logcat we can't tell which. The diagnostic
tip "Mic heard you, but the model never matched"
points at the user's pronunciation, but it could be
"wrong model loaded" — and the tip doesn't tell us
which.

### Fix

`scoreWavFile` now returns `loadedWakeword` (the
detector's current wakeword string) and
`detectorLoaded` (boolean). The result object in JS
exposes these to the diagnostic tip:

- If `loadedWakeword === 'hey_jarvis'` (the bundled
  default), the test scored against the wrong
  model. Tip says: "the test scored against the
  bundled 'hey_jarvis' model instead of your
  trained wake phrase. The active wake binding may
  be missing — open the Wake sub-page and verify
  the trained phrase is selected."
- If `loadedWakeword` is the user's phrase, the
  model was loaded correctly. Tip says: "the loaded
  model (hey clawsuu) didn't match what you said.
  Try again with the exact phrase, or retrain with
  cleaner samples."
- If `detectorLoaded` is false, the detector is
  null. Tip mentions "Detector not loaded".

This breaks the previous "everything-is-model-miss"
diagnosis into three concrete cases the user can act
on. If `loadedWakeword === 'hey_jarvis'` on the
next test, the v3.10.48 initOww path silently
failed and we need to fix the catch (most likely a
JS-side promise issue). If `loadedWakeword` is the
user's phrase, the wake phrase recognition itself
is at fault (retrain needed). If `detectorLoaded`
is false, the detector initialization failed.

The native `initOww` failure mode in v3.10.48 was
silent — the JS caught it with `catch (_) {}` and
moved on. The scoreWavFile ran against whatever was
left in the detector (probably the bundled
'hey_jarvis' from HomeScreen's earlier init). With
`loadedWakeword` in the result, the user can SEE
this case and we can address it explicitly in a
follow-up.

## What's NOT fixed

- The actual wake model not matching the user's
  phrase. That's a model-training / audio-recording
  issue, not a code issue. The diagnostic info
  surfaces it; the fix is in the user's training
  data or microphone behavior.
- TTS install prompt. v3.10.49's prompt body
  (recommends RHVoice / eSpeak NG) is the latest;
  no change in this release.
- The bar `Learning 20/20` indicator. v3.10.48's
  cap fix is the latest; no change in this release.

## Files

- `src/screens/WakeModeScreen.tsx` —
  `lateResponseReceivedRef` declared, set in
  onChat + onAudioResponse, reset in
  stopAndSendRecording, checked in retry path
  (twice: before cue and after cue)
- `src/components/ClassifierTest.tsx` —
  `loadedWakeword` + `detectorLoaded` in result
  type, captured from scoreWavFile, surfaced in
  diagnostic tip for peak < 5%
- `android/.../WakeWordModule.kt` —
  `scoreWavFile` returns `loadedWakeword` +
  `detectorLoaded` in the result map
- `package.json` — 3.10.49 → 3.10.50
- `android/app/build.gradle` — versionCode 276 →
  277, versionName 3.10.50

## General lessons

### Two-stage guards on retry paths

A guard at the top of a retry path is not the same
as a guard before the user-visible side effect.
`playTurnCueAndWait` runs for 1-2s and shows a
visible cue sound. If a late response arrives
during the cue, the cue plays even though the
response is already in flight. The fix is a second
guard AFTER the cue resolves. This is the same
pattern as v3.9.4's "stop OWW before recording"
comment: a guard at the action, not just at the
listener. The listener can be correct but the
action can still race with a late event.

### Diagnostic info beats logcat

When a user can't provide logcat (no computer, on
the go, etc), surfacing diagnostic info in the UI
is the only way to diagnose without a
developer-mode setup. The previous "peak=0 means
model mismatch" tip was correct in spirit but
didn't tell the user what model was loaded. Adding
`loadedWakeword` to the result turns the next test
into a self-diagnosing step: if the user sees
"Loaded model: hey_jarvis" in the diagnostic, they
know the initOww path failed and we can address it
explicitly. If they see "Loaded model: hey clawsuu"
with peak=0, they know it's a genuine miss and the
fix is to retrain.

Same pattern as v3.10.39's "Mic: error: TTS init
failed: status=-1" → "Wake: error: TTS init
failed: status=-1" rename: the diagnostic should
tell the user enough to act, not just report a
failure.

### Late-response races

The general pattern: any path that "starts a new
user-facing action after a timeout" needs to
re-check whether the awaited event already arrived.
The retry path is the obvious one (we waited 30s
for a response; if it arrives at second 31, the
retry fires anyway). But the same pattern applies
to:

- Silence detection: a response that arrives
  during silence detection
- Exit phrase detection: a chat message that
  arrives during exit-phrase polling
- Reconnect: a successful reconnection during the
  reconnect countdown

Each of these needs a synchronous check for
"did the awaited event happen during the wait?"
before proceeding. The `lateResponseReceivedRef`
pattern is a small, reusable primitive for this.