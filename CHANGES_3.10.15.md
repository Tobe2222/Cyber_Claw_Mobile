# v3.10.15 — Auto-exit voice mode after 3 consecutive empty rounds

Tobe reported:

> "The whole experience now has turned worse. The
> first round seems ok, then i leave it hanging
> while thinking of my reply and it continues to
> loop. Which is fine, but i think we should have
> a function where if it does not detect recognizeable
> speech for a couple of rounds it should just exit
> voice mode. i think we have that tho its just that
> it seems for each round it goes it cuts me off more
> frequently."

## Fix

When voice mode loops through recording turns with
no speech detected (the gibberish-gate skip path),
count consecutive empty rounds. After 3 empty rounds,
exit voice mode automatically.

The 3-round cap = ~36s of total idle time (each round
= ~7s silence + 5s countdown = ~12s × 3 = ~36s). Long
enough that an idle user gets a clear "I'm giving up,
please come back" exit, instead of an infinite loop.

Counter resets to 0 whenever:
- Speech IS detected (the user is talking — implicit
  "all is well" signal)
- The auto-exit fires (cleanup)

## What's still wrong: the cumulative cut-off

Tobe also said "for each round it goes it cuts me off
more frequently." That's a separate issue. Each turn
in voice mode does the same thing: cached greeting
plays (~1-3s) → settle delay (4s) → cue play → recorder
starts. So technically each round has the same setup.
Tobe's perception of "more frequent" might be:
- Cumulative frustration as rounds fail
- Different audio paths per round (greeting cache
  miss on round 1, speech TTS on round 2, etc.)
- VAD state accumulating somehow

I haven't addressed this — the auto-exit at round 3
bounds the duration, but round 2 vs round 1 might
still cut off earlier than expected. If Tobe reports
this again after testing v3.10.15, I'll add per-round
timing logging to diagnose.

## Files

- `src/screens/WakeModeScreen.tsx`:
  - Added `consecutiveEmptyRoundsRef` ref and
    `MAX_CONSECUTIVE_EMPTY_ROUNDS = 3` constant
  - In the gibberish-gate path: increment counter on
    each empty round; if it reaches the cap, exit
    voice mode via `exitRef.current()`
  - On first-speech detection (vad owwVad event): reset
    counter to 0
  - On auto-exit: reset counter to 0 (in case voice
    mode restarts later in the session)
- `package.json` — 3.10.14 → 3.10.15
- `android/app/build.gradle` — versionName 3.10.14 →
  3.10.15, versionCode 241 → 242

## Lesson

**Auto-exit is a feature, not a failure.** The loop
itself is acceptable — the user explicitly said "which
is fine". The bug was that the loop had no exit, so an
idle user got stuck. Adding a cap on empty rounds
(3 silent turns = ~36s) makes the loop self-terminating
without forcing the user to manually tap X.

The right cap depends on the user's intent. 3 rounds
is a reasonable default for "idle user forgot about
voice mode". For active users, the cap is irrelevant
because the speech-reset prevents the counter from
accumulating.

**Lesson: when adding counters, document the
semantics of reset carefully.** I have three reset
points (first speech, auto-exit, not reset on
gibberish-gate iteration). Adding more in the future
without a clear mental model would lead to off-by-one
bugs.

## What's still wrong (not fixed)

- "Each round cuts me off more frequently" — no fix in
  this PR. Plan: add per-round timing logs to see if
  the cached greeting takes longer in later rounds (TTFB
  or TTS miss), or if the VAD state is leaking across
  turns.