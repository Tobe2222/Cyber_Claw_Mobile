# v3.5.2 — Voice mode re-opens after exit (v3.5.1 only fixed half the race)

## Bug

Tobe installed v3.5.1 and reported it still happens: "I did a
wake conversation, then exited it and it twice triggered right
after without my wake signal."

## Why v3.5.1 wasn't enough

v3.5.1 only short-circuited HomeScreen's `checkPending` effect
(the AsyncStorage-flag path) with the in-memory guard. It did not
cover the listener path.

The full path that opens voice mode from HomeScreen is two
separate code paths:

1. `checkPending` — reads `cyberclaw-wake-pending` from
   AsyncStorage. v3.5.1's `isWakeJustExited()` short-circuit
   covers this. ✅
2. `handleWakeWord` — called directly when the OWW detector's
   `owwWakeDetected` event fires. v3.5.1 did NOT touch this.
   ❌

The OWW detector (native side) runs continuously across screen
changes. When voice mode closes:
- The detector's listening thread is still alive (`owwThread`).
- `stopOwwListening` only sets `isOwwListening = false`; it
  doesn't kill the thread or reset state immediately.
- Audio frames already in the rolling melspec buffer are still
  classified against both wake and exit classifiers.
- The 2-second `DETECTION_COOLDOWN_MS` then expires, and a wake
  can fire even though the user already clicked X.

That fired wake lands in HomeScreen's `startSampleMatchListener`
→ `handleWakeWord` → `onOpenVoiceMode()` → setScreen. The
`cyberclaw-wake-pending` AsyncStorage flag was already cleared
by v3.5.1's awaited `removeItem` in `App.tsx.onExit`, so the
pending-flag race isn't the cause any more — the cause is the
direct owwWakeDetected → handleWakeWord path, which v3.5.1 left
untouched.

(Tobe saw it twice because the detector fires more than once
across the 2-second cooldown window on close audio — first
from the just-said exit phrase, then from the unsaid "bye"
trailing in the buffer.)

## Fix

Three changes, all in `src/screens/HomeScreen.tsx`:

1. `handleWakeWord` now also short-circuits on
   `isWakeJustExited()`. The listener is the second entry point
   to voice mode; it must respect the same guard as `checkPending`.

2. Guard window bumped 3s → 5s. The detector's natural cooldown
   is 2s, and it can take an extra couple of seconds for any
   "exit audio trailing in the buffer" to be classified and
   emitted. 5s gives the detector's rolling buffer time to drain
   past wake-like classifications without keeping the user
   locked out of a re-trigger unreasonably long.

3. Same window applies to the guard via `markWakeJustExited`'s
   default. App.tsx's `onExit` calls `markWakeJustExited()` with
   no argument, so it picks up the new 5s default automatically.

## Files

- Edited: `src/screens/HomeScreen.tsx` (guard check added to
  `handleWakeWord`; window bumped 3000 → 5000 in
  `markWakeJustExited`).
- Edited: `package.json` (3.5.1 → 3.5.2).
- Edited: `android/app/build.gradle` (versionCode 190 → 192,
  versionName 3.5.1 → 3.5.2).

## Verification

`tsc --noEmit` is clean apart from the pre-existing stray `/>`
on `HomeScreen.tsx:2584` (not introduced by this release).

To smoke-test on device:
1. Install v3.5.2 over v3.5.1 (or fresh).
2. Open the app, say wake → voice mode opens.
3. Click X → voice mode closes.
4. **Confirm voice mode does NOT re-open within ~5 seconds.**
5. Wait 5+ seconds, then say wake → opens normally (guard
   expires cleanly).
6. Test a few wake events in a row before exit, including
   saying the trained exit phrase on the way out (Tobe's
   original repro path).
7. **NEW (v3.5.2):** After a normal exit, say another wake
   word within 5–10s — should still be ignored. After ~10s,
   wake resumes normally.

## Why I didn't make the guard permanent

A persistent guard would require either:
- Persisting `_wakeJustExitedUntil` to AsyncStorage (heavy),
- Storing it in the native SharedPreferences (requires a new
  `@ReactMethod` and clearing it on a timer or next wake event),
- Or never allowing wake after an explicit exit for the session.

None of these match the user's mental model: "I clicked X
because I don't want voice mode right now, not because I'm
done using it forever." A 5-second window is the smallest
defence that closes the race; a permanent lock is a behaviour
change.

If the bug still happens in v3.5.2, the next step is to add
logcat output from the OWW detector (`adb logcat -s
WakeWord`) during a repro to see exactly which event is firing
after exit and from which classifier.