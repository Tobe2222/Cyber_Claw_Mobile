# v3.10.13 — Play turn cue on no-response retry

Tobe reported (channel `#cyber-dev`, screenshot of voice
log stuck in retry loop):

> "This time it failed to respond for some reason and
> again it continued the conversation Instead of
> retrying. And when it was the user turn it did not
> make the cue sound either."

Voice log showed:
```
⏰ No response, retrying...
⏳ Silence detected (7000ms)...
🚫 No speech detected, skipping...
🎧 Still listening...
⏳ Silence detected (7000ms)...
```

The system entered a retry loop — silence detector
fires (no one is talking), skip-silence-silence
loops forever until Tobe says something.

## Root cause

The "no response" timeout fires after 30s of waiting
for the desktop. The retry path:

1. Clears `wakeWordBusyRef`
2. Sets status to `'retrying'` (yellow overlay)
3. Calls `startRecordingTurnRef.current?.()` to open
   a new recording window

But **no cue sound plays** because `afterPlayback`
(the only place the cue is played) only fires on
`audioPlayerFinished`, which only fires when the
desktop sent audio response. No audio response → no
cue.

So Tobe's experience was:
- Audio sent to desktop
- Desktop didn't respond (timeout)
- Status flashed "retrying" briefly
- New recording window opened (silent — no cue)
- User has to figure out they're being recorded again
- Silence detector fires, loop continues

## Fix

Lifted the cue-play + wait-for-completion code out of
`afterPlayback` into a shared `playTurnCueAndWait()`
callback (defined near `playExitReply`). Now called
from TWO places:

1. **afterPlayback** (existing path): after a
   successful response audio finishes, play cue
   before opening next recording turn.

2. **No-response retry path** (new): when the
   transcribing timeout fires, play cue before
   opening the new recording window. The user
   always gets audio feedback that their turn is
   starting, regardless of whether the desktop
   responded.

Visual overlay continues to flip to `'listening'`
("YOUR TURN") when the recording actually opens —
only the audio cue is gated on the retry path.

## Why I'm not changing the retry behavior itself

Tobe also said "it continued the conversation Instead
of retrying." That's a separate question: should
"no response" trigger:
- (a) Open a new recording window (current behavior
  — manual retry, user speaks again)
- (b) Re-send the audio to the desktop (automatic
  retry — requires keeping the audio bytes around)
- (c) Close voice mode entirely (give up)

Option (a) is what we have. The user's instinct is to
retry (speak again) so opening a new recording window
is the right semantic — we just need to make sure
the user knows the retry is happening (via the cue
sound + overlay).

If Tobe wants (b) — automatic retry of the audio
bytes — that's a larger change. We'd need to keep
the audio bytes around in memory, and add a "retry"
path that resends them to the desktop. Implementing
this would also need a backoff strategy (don't
retry forever) and a circuit-breaker (give up after
N retries and close voice mode).

For now: (a) with explicit cue + overlay so the user
knows they're in retry mode. If Tobe wants (b) we
can add it.

## Files

- `src/screens/WakeModeScreen.tsx`:
  - Added `playTurnCueAndWait` callback (lifts the
    cue-play + 3s safety timeout + wait-for-completion
    code out of afterPlayback)
  - `afterPlayback` now calls `await
    playTurnCueAndWait()` (replaces the inline cue
    block)
  - No-response retry path now calls
    `playTurnCueAndWait().then(() =>
    startRecordingTurnRef.current?.())` so the cue
    plays before the new recording window opens
- `package.json` — 3.10.12 → 3.10.13
- `android/app/build.gradle` — versionName 3.10.12 →
  3.10.13, versionCode 239 → 240

## Lesson

**"Retry" can mean different things to different
people.** Tobe's instinct is "retry = the system
should try again automatically." My implementation
was "retry = prompt the user to try again manually."
Both are valid interpretations of "retry" — the
difference is whether the system can make progress
on its own or needs user input.

When the desktop pipeline is down (no response), the
system CAN'T make progress on its own — even with
the audio bytes, resending would just hit the same
timeout. So opening a new recording window and
prompting the user to speak is the correct semantic.
But the user needs to KNOW that's what's happening,
which is what the cue + overlay are for.

When implementing "retry" in the future, always
specify WHICH of (a/b/c) you mean. The word itself
is ambiguous.