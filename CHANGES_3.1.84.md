# v3.1.84

## Hotfix: cold-launch wake mode re-introduced with screen-guard

Tobe (after v3.1.83): "updated and tested. Now wake dont open directly into
wake mode again ... when opening the app normaly it should open into the
home screen. But when opened by wake it should open directly into wake mode"

### What broke

v3.1.83 fixed the cold-launch auto-entry ping-pong by removing the
`AppState=active` listener that re-checked the native `wake_pending` flag
on every foreground transition. But that listener wasn't just
belt-and-suspenders — it was actually the **fast path** for the cold-
launch wake case:

1. App killed
2. Wake word fires → MainActivity created with `from_wake_word=true`
3. `checkWakeIntent` sets `wake_pending=true` in SharedPreferences,
   schedules `emitWakeOpenedWithRetry(0)` (first retry at T=250ms)
4. React tree mounts (T≈100–200ms) → `wakeOpenSub` listener subscribed,
   `checkNativePending()` called
5. **At the same moment, `AppState=active` fires** (the activity is
   foregrounded for the first time). In v3.1.82, this fired
   `checkNativePending()` which read the flag and opened wake mode
   *immediately*, without waiting for the 250ms retry.

Without the `AppState=active` listener, wake mode only opens when
`wakeOpenSub` catches the eventual emit (after the 250ms retry). In
Tobe's testing, that path wasn't firing reliably — possibly because
the first `emitWakeOpenedWithRetry` raced with the React mount and the
emit was dropped (the listener wasn't subscribed yet at T=250ms, then
the flag was cleared in MainActivity on success, so the mount-time
`checkNativePending()` saw flag=false).

### The fix: re-add the listener with a screen-guard

The listener needs to be re-added for the cold-launch wake case, but
guarded so it doesn't ping-pong after manual exit. The guard checks
`screenRef.current === 'home'` before consuming the flag. If the user
is already in wake-mode, settings, or voice-mode, the listener no-ops.

```js
const checkNativePending = () => {
  if (!WakeWordModule?.isWakePending) return;
  if (screenRef.current !== 'home') return;  // ← guard
  WakeWordModule.isWakePending().then((pending) => {
    if (pending) {
      clearWakePending();
      handleWake();
    }
  }).catch(() => {});
};
checkNativePending();  // mount-time check still fires
const sub = AppState.addEventListener('change', (s) => {
  if (s === 'active') checkNativePending();
});
```

The `screenRef` is needed because `useEffect`'s `[]` deps capture
`screen` at mount time. A separate `useEffect([screen])` keeps the ref
in sync.

### Why this is correct

- **Cold-launch wake (the case v3.1.83 broke):** user kills app, says
  wake word, activity comes to foreground. `AppState=active` fires
  `checkNativePending` → `screenRef.current === 'home'` → reads flag →
  opens wake mode. ✓
- **Manual exit from Wake Mode:** user taps X, `setScreen('home')`,
  `screenRef.current` updates to `'home'` (via the sync useEffect).
  Now if `AppState=active` fires (notification shade toggle, screen
  lock+unlock), `checkNativePending` reads the flag (now cleared by
  `onExit` defensively), finds nothing, no-ops. ✓
- **User already in Settings/Wake Mode/Voice Mode:** `screenRef.current`
  is not `'home'`, listener no-ops. ✓
- **Normal app launch (no wake event):** flag is false, listener
  no-ops. ✓

### What was NOT changed

The greeting fix (Bug 2 in v3.1.83) and the `clearWakePending()` call
on `onExit` are kept from v3.1.83 — both were correct.

### Files

- `App.tsx` — re-add `AppState=active` listener with `screenRef`
  guard; add `useRef` import; add `screenRef` synced via `useEffect`
- `package.json` — 3.1.83 → 3.1.84
- `android/app/build.gradle` — versionCode 133 → 134
- `.github/workflows/{build,android-build}.yml` — artifact names
- `CHANGES_3.1.84.md` (new)

### Lessons

**The "redundant safety net" was load-bearing.** v3.1.83 removed the
`AppState=active` listener as "redundant belt-and-suspenders" because
`wakeOpenSub` and `mount-time checkNativePending()` covered the wake-
entry case in theory. In practice, the first `emitWakeOpenedWithRetry`
(250ms postCreate) races with React mount: if the React tree isn't
mounted when the emit fires, the listener isn't subscribed, the emit
is dropped, the flag is cleared by MainActivity on success, and the
mount-time check sees flag=false. Wake mode never opens. The
`AppState=active` listener was the **fast path** that bypassed this
race.

**Always-on side effects need state-aware guards, not removal.**
When an effect turns out to be too aggressive (the ping-pong), the
fix is rarely "remove it" — it's "guard it with current state so it
only fires when appropriate". Removing it created a regression.
Adding `screenRef.current === 'home'` is the right fix: the listener
still fires on every active transition, but only consumes the flag
when the user is actually on the home screen.

**Use a ref for current-state checks inside `useEffect` closures.**
`useEffect(..., [])` captures variables at mount time. If the effect
needs to read CURRENT state of a React-managed value, the closure
needs a ref synced via a separate `useEffect([thatState])`. Same
pattern as `latestRef` in React Query / SWR — the closure escapes
re-renders, the ref escapes stale captures.