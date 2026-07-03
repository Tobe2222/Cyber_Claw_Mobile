# v3.5.1 — Voice mode re-opens itself after exit (race in wake-pending flag)

## Bug

Tobe's v3.5.0 feedback: "there still is a wake bug where it
triggers repeatedly after I tested wake a couple of times. I
then clicked exit but it opened voice mode right after a couple
of times. Like it automatically got clicked or wake triggered
right after closing."

The two symptoms ("wake triggers repeatedly" and "opened voice
mode right after closing") are actually the same bug, viewed
from two angles: every time voice mode closes, it re-opens
within ~300ms. From the user's seat that looks like wake
"triggering itself" — voice mode just keeps popping back up.

## Root cause

Race condition in the `cyberclaw-wake-pending` AsyncStorage flag
that backs voice-mode routing. Three parties read and write it:

1. `HomeScreen.handleWakeWord` (sets the flag to `'1'` when a
   wake event fires, schedules a 30-second `removeItem`).
2. `App.tsx`'s `onExit` lambda (clears the flag when voice mode
   closes, then calls `setScreen('home')`).
3. `HomeScreen`'s `checkPending` effect (runs on mount, on every
   2s counter tick, and on `AppState` becoming `'active'` — if
   the flag is `'1'`, opens voice mode).

The old `onExit` was:

```js
onExit={() => {
  AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
  WakeWordModule?.clearWakePending?.().catch(() => {});
  setScreen('home');
}}
```

The two `removeItem` calls are fire-and-forget; `setScreen('home')`
runs synchronously. React immediately unmounts `WakeModeScreen`
and mounts `HomeScreen`. `HomeScreen`'s `useEffect` runs
`checkPending()`, which calls `AsyncStorage.getItem`. In the
same JS tick, the in-flight `removeItem` from `onExit` may not
have committed to disk yet — `getItem` returns `'1'`. `checkPending`
consumes the flag, schedules a 300ms `setTimeout`, and calls
`onOpenVoiceMode()`. Voice mode re-opens.

Tobe observed this most reliably after testing wake "a couple of
times" in a row, because each wake call set the flag again — so
even after one exit cleared it, the next 30-second `setTimeout`
removal still hadn't fired and the flag was repopulated by the
caller's earlier writes. More wake events = more chances for
the race to win.

## Fix

Two layers, both small:

### 1. `App.tsx` — `onExit` awaits the storage clearing

```js
onExit={async () => {
  markWakeJustExited();
  await Promise.all([
    AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {}),
    (WakeWordModule?.clearWakePending?.() ?? Promise.resolve()).catch(() => {}),
  ]);
  setScreen('home');
}}
```

`setScreen('home')` now runs only after both clears have
committed. `HomeScreen`'s first `checkPending` tick sees the
cleared flag.

### 2. `HomeScreen.tsx` — in-memory "just exited" guard

```js
let _wakeJustExitedUntil = 0;
export const markWakeJustExited = (windowMs: number = 3000) => {
  _wakeJustExitedUntil = Date.now() + windowMs;
};
export const isWakeJustExited = () => Date.now() < _wakeJustExitedUntil;
```

`checkPending` now skips the AsyncStorage read entirely if
`isWakeJustExited()` returns true. The guard is in-memory only
(intentionally — the AsyncStorage flag is still the source of
truth for the "activity-torn-down" case where the JS process was
killed). The 3-second window is enough to cover the post-mount
`checkPending` ticks (mount, immediate `wakePendingCheckCounter`
bump from `setInterval`, and any `AppState` transitions during
the screen switch). After 3 seconds, normal wake-word detection
resumes.

Belt-and-suspenders for any future code path that re-reads the
flag — if `setScreen` ordering ever regresses, the guard still
holds.

## Why not just make `checkPending` smarter?

I considered a few alternatives and rejected them:

- **Drop the AsyncStorage flag entirely.** Tempting, but the
  flag is the safety net for the "activity-torn-down" case where
  React Native rebuilds the activity mid-wake and HomeScreen
  mounts from scratch with no module state. Removing it would
  break that recovery.
- **Use only the native SharedPreferences flag (`wake_pending`
  in `WakeWordModule.kt`).** Cleaner long-term, but requires
  adding a `getWakePending` `@ReactMethod` and rewriting both
  sides. Bigger change than this bug warrants.
- **Make `setScreen` `await` a microtask.** Wouldn't help — the
  race is between two real I/O operations on the AsyncStorage
  bridge, not React state.

The await + in-memory guard is the smallest change that closes
the race without losing the recovery semantics.

## Files

- Edited: `App.tsx` (`onExit` now async + awaits + calls
  `markWakeJustExited`).
- Edited: `src/screens/HomeScreen.tsx` (new module-level
  `markWakeJustExited` / `isWakeJustExited` exports;
  `checkPending` short-circuits while the guard is active).
- Edited: `package.json` (3.5.0 → 3.5.1).
- Edited: `android/app/build.gradle` (versionCode 188 → 189,
  versionName 3.5.0 → 3.5.1).

## Verification

`tsc --noEmit` is clean apart from the pre-existing stray `/>`
on `HomeScreen.tsx:2584` (left for separate cleanup — not
introduced by this release).

To smoke-test on device:
1. Install v3.5.1 over v3.5.0.
2. Open the app, say wake word → voice mode opens.
3. Click X → voice mode closes.
4. **Confirm voice mode does NOT re-open within ~3 seconds.**
5. Wait 3+ seconds, then say wake word → voice mode opens
   normally (confirms the guard expires and normal detection
   resumes).
6. Repeat 3–5 with several wake events in a row before exit
   (Tobe's original repro path).