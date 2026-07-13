# v3.9.6 — Hotfix: Silence detector gets faster over the conversation

Tobe (in #cyber-dev, ~17:00 after testing v3.9.5): "Okey
tested more. The issue is still silence detector. It has
to be longer perhaps. But it did seem to work good in
the start of the conversation but the longer it went the
faster silence triggered it seemed."

## Root cause

JS-side listener + setInterval accumulation across
recording turns. Two leaks working together:

### Leak 1: silence listener never removed on early-end paths

`startRecordingTurn` (WakeModeScreen.tsx ~1057) registers
a `recorder.once('silence', handler)` per turn and
captures the unsub function in a local const
`unsubSilence`. `recorder.once` auto-unsubcribes when
the event fires — but ONLY if the event fires. If a
turn ends without silence (via send-word, gibberish-
gate skip, etc.), the listener stays in the SimpleAudio-
Recorder's listener Set forever.

After N turns where silence never fires, the listener
Set has N handlers. When silence eventually DOES fire
(e.g. a normal conversational pause), ALL N handlers run
synchronously. Each one:

- Logs "⏳ Silence detected" (so the log gets spammed)
- Sets voiceStatus to 'silence_countdown' (idempotent —
  looks fine)
- Starts its own 3-second `setInterval` countdown

After 3s, every countdown's final tick fires
`stopAndSendRecording('silence')`. The `stopInFlightRef`
guard blocks all but one of these from doing real work,
but the others still call `stopAndSendRecording` and
once the in-flight call finishes and `stopInFlightRef`
flips back to false, **the orphaned setIntervals keep
ticking** and each subsequent tick kills whatever new
turn just started.

### Leak 2: JS-side countdown setInterval orphaned on early-end

The 3s countdown `setInterval` (line ~1062) is captured
in a local `tick` const. It clears itself when count
hits 0 — but if the turn ends early (via send-word or
gibberish-gate skip), nothing calls `clearInterval(tick)`.
The setInterval keeps ticking in the background and
fires `stopAndSendRecording('silence')` after 3s on
whatever recording is currently active.

### Combined symptom

The longer the conversation goes, the more listeners
and orphaned intervals accumulate. Eventually a real
silence event triggers all of them simultaneously,
producing a cascade of premature `stopAndSendRecording`
calls that cut every subsequent recording off within
1-2 seconds instead of `silenceMs + 3`.

This matches Tobe's report exactly: "worked good in
start of conversation" (first few turns), "the longer
it went the faster silence triggered" (after listeners
accumulated).

## Fix

`src/screens/WakeModeScreen.tsx`:

1. Lifted the unsub function to a `silenceUnsubRef`
   ref so it's accessible from `stopAndSendRecording`
   across closure boundaries.

2. Lifted the countdown `setInterval` id to
   `silenceCountdownIntervalRef`.

3. In `startRecordingTurn`, before registering a new
   silence listener, clean up any prior turn's pending
   listener + interval. Store the new unsub in the ref
   once registered.

4. In `stopAndSendRecording`, at the top of the function
   (before the `stopInFlightRef` guard so it also runs
   when we early-return), call the listener unsub and
   clear the interval.

After the fix, exactly one silence listener and zero
orphaned intervals exist at any time. Silence fires
once per turn, the 3s countdown runs once, the
recording ends cleanly.

## Why this and not "just call unsubSilence on early-end paths"

Could have tried to clear the listener in every early-
end branch (send-word path, no-speech-skip path,
transcribing-timeout path, etc.) — 5+ call sites,
easy to miss one. Lifting to a ref and clearing in one
place (top of stopAndSendRecording) is more robust:
ONE place, ONE pattern, all paths covered.

## Files touched

- `src/screens/WakeModeScreen.tsx` (two refs + cleanup
  in startRecordingTurn + cleanup in stopAndSendRecording)
- `package.json` (3.9.5 → 3.9.6)

## Verification

`npx tsc --noEmit` passes (only pre-existing
HomeScreen.tsx:2666 error, unrelated).

## Test plan after install

1. Voice mode, hold a normal conversation for 5+ turns.
   Each turn's silence detection should take the full
   `silenceMs + 3s` (default 8s). If a turn ends early
   via send-word, the NEXT turn's silence should still
   take the full `silenceMs + 3s`.
2. Watch the log: should see exactly ONE "⏳ Silence
   detected" per silence event, not multiple.
3. Send the send-phrase mid-sentence. Recording should
   stop immediately (v3.9.4). The next turn's silence
   detection should still work normally.

## Companion release

Nothing desktop-side.
