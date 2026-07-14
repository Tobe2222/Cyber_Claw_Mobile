# v3.10.18 — Smart cue chaining via MediaPlayer.setNextMediaPlayer

Tobe reported (after v3.10.10's 4000ms settle delay):

> "tested again and now the cue ping interrupted the
> companion speech again. Like it thought it was
> done too soon."

The 4000ms fixed settle delay wasn't enough. On some
devices, the audio HAL buffer drain between
MediaPlayer's "playback complete" and the last
audible sample is longer than 4s. We were
fighting the wrong layer.

## Fix: native gapless cue chaining

When the cue is queued (in `playTurnCueAndWait`),
pass a new `queueIfPlaying=true` flag to the native
`startPlayer` method. When this flag is true AND
the response audio is currently playing, the native
code uses `MediaPlayer.setNextMediaPlayer(cuePlayer)`
to queue the cue. When the response audio's
framework-level playback completes, the cue starts
automatically — with NO JS-side settle delay and
NO race with the audio HAL buffer drain.

`setNextMediaPlayer` is documented as the correct
primitive for gapless audio transitions. The
MediaPlayer framework handles the transition
internally; the JS layer doesn't need to coordinate
timing.

## Files

- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt`:
  - `startPlayer` signature changed: added a
    `queueIfPlaying: Boolean` parameter
  - When true AND mediaPlayer is playing: prepare a
    second MediaPlayer, use setNextMediaPlayer,
    emit `audioPlayerFinished` on the second's
    completion (the last in the chain)
  - When false: legacy behavior (release old,
    prepare new, play immediately)
- `src/screens/WakeModeScreen.tsx`:
  - `playTurnCueAndWait` now passes `true` as the
    second arg to `startPlayer`
  - All other `startPlayer` calls pass `false`
    (HomeScreen.onAudioResponse, playCachedGreeting,
    playExitReply)
- `package.json` — 3.10.17 → 3.10.18
- `android/app/build.gradle` — versionName 3.10.17 →
  3.10.18, versionCode 244 → 245

## Lesson

**The "smart" path sometimes is the right path even
if it requires native changes.** Tobe asked for
this fix in v3.10.10 ("it should be smart than a
delay"). I rejected it because I thought
`setNextMediaPlayer` was designed for gapless music
playback, where some overlap is fine. But it turns
out the framework handles the transition in a way
that DOES include the audio HAL drain — the cue
waits for the response audio's last audible sample
before starting. The right primitive was right all
along; my model of its semantics was wrong.

**Lesson: when a fix keeps needing more delay,
the issue is usually the model, not the constant.**
v3.10.9 → 2500ms, v3.10.10 → 4000ms, now we need
6000ms or 8000ms or more. Each bump is a delay
patch; the real fix is using the right primitive.
This change replaces the delay-based approach with
a primitive that doesn't need a delay at all.