# v3.10.51 — wake test uses stale options closure (initOww never called)

Tobe retested wake after v3.10.50. The diagnostic tip
NAILED it:

> "Mic heard you, but the test scored against the bundled
> 'hey_jarvis' model instead of your trained wake phrase.
> **The active wake binding may be missing** — open the
> Wake sub-page and verify the trained phrase is selected.
> **Loaded model: hey_jarvis**."

So v3.10.50's `scoreWavFile` correctly surfaced that the
detector was loaded with `'hey_jarvis'`. v3.10.51 finds
the root cause: the JS test path's `initOww(...)` call
was never executing at all.

## Root cause: stale options closure

`useClassifierTest(kind, options)` returns a `start`
function wrapped in `useCallback`. The deps were
`[kind]` — meaning `start` was the SAME function
reference for the entire component lifetime. It
captured the `options` object from the FIRST render.

In CompanionSettingsScreen, the hook is called like:
```js
const { start: handleTestWake } = useClassifierTest('wake',
  { wakeword: activeWakeDirect?.phrase });
```

`activeWakeDirect` is a state variable loaded in a
`useEffect` that runs AFTER the first render. So:

- First render: `activeWakeDirect = null` →
  `options = { wakeword: undefined }` → `start`
  captures this
- Second render (after useEffect): `activeWakeDirect =
  { phrase: 'Hey Clawsuu', ... }` → options object
  updates, but `start` is the SAME closure from
  before, still using the stale `options.wakeword =
  undefined`
- User taps "Test wake" → `start` runs → checks
  `if (wakewordToScore && ...)` → `wakewordToScore =
  options?.wakeword = undefined` → SKIP
- `initOww` is NEVER called → `owwDetector` stays
  whatever it was (the bundled `'hey_jarvis'` from
  HomeScreen's earlier init)

The diagnostic tip on v3.10.50 surfaced this
perfectly: "Loaded model: hey_jarvis" is exactly what
you'd expect when initOww was never called and the
detector kept its default.

This is a closure-stale-bug, the same pattern as
v3.9.4's "stop OWW before recording" fix (the listener
captured stale callbacks). The fix in both cases is
the same: re-create the function when its inputs
change.

## Fix

Added `options?.wakeword` to the `useCallback` deps:

```ts
const start = useCallback(async () => {
  // ...
  const wakewordToScore = options?.wakeword;  // fresh on every render
  if (wakewordToScore && WakeWordModule?.initOww) {
    try {
      await WakeWordModule.initOww(wakewordToScore, 0.5);
    } catch (e) {
      // log instead of silently swallow
    }
  }
}, [kind, options?.wakeword]);  // <-- new dep
```

Now `start` re-creates when the wakeword changes. On
the first render `options.wakeword = undefined`, so
the `if` is false → no initOww call → no harm. On
the second render `options.wakeword = 'Hey Clawsuu'`,
`start` re-creates, captures the new options, and
the user tap → real initOww call.

Also added a log entry to the initOww catch so a
genuine native-side failure (loadModels can't find
the model file, etc.) is visible in the log tab
instead of silently swallowed. The diagnostic tip
already says "Loaded model: hey_jarvis" for that
case, but the log entry explains WHY (e.g. "No
model file found for 'hey clawsuu' (bundled or
custom)").

## Files

- `src/components/ClassifierTest.tsx` —
  `useCallback` deps changed from `[kind]` to
  `[kind, options?.wakeword]`; catch on initOww
  now logs the error.
- `package.json` — 3.10.50 → 3.10.51
- `android/app/build.gradle` — versionCode 277 →
  278, versionName 3.10.51

## General lessons

### useCallback with mutable input needs the input in deps

`useCallback(fn, deps)` is a memoization primitive. If
`fn` reads any value from its closure that isn't
in `deps`, that value is stale forever. The
`useClassifierTest` API takes `options` as a parameter
that the caller expects to be "live" — but the
caller's `options` is a fresh object every render
(with new fields like the updated wakeword), and the
hook had no way to know to recreate.

The fix: `options?.wakeword` in deps. But the
correct fix would be `options` itself if it were
stable (it isn't — it's a fresh object literal
each render, so dep tracking would force recreate
on every render anyway). The `wakeword` field is
the relevant sub-field; tracking it specifically
keeps the memoization useful.

Same pattern as v3.9.4's "stop OWW before recording"
fix: a closure captured stale state because its
inputs weren't tracked. The lesson generalizes to:
**any useCallback that reads from an options
parameter needs the relevant options fields in
its deps**. A function that ignores its inputs is
fine with `[]` deps; a function that uses them
must list them.

### Don't use useCallback for events that should always be fresh

`useCallback` is useful when the function is passed
as a dep to a child or stored in a ref. Here, `start`
is just returned to the caller for use in an
onPress handler. The memoization isn't useful —
onPress doesn't care if the function reference
changes between renders. Removing useCallback
entirely would also work and skip the stale-options
trap:

```ts
const start = async () => { /* fresh options every render */ };
return { running, result, start, abort };
```

The trade-off: removing useCallback means `start` is
a new reference every render. If any useEffect
depends on `start` (none do here), it would re-run.
Since `start` is only used as an onPress handler,
the trade-off is worth it. But for consistency with
the abort ref pattern, keeping useCallback with
correct deps is the smaller-blast-radius fix.

### Silent catch on init flows is a recurring foot-gun

This is the second time `catch (_) {}` has bitten us
in this exact code path:

- v3.10.48: initOww catch was silent → couldn't
  tell why detector stayed on `hey_jarvis`
- v3.10.51: STILL silent — same code path, but the
  bug was actually elsewhere (stale closure). The
  silent catch hid the absence of the call entirely.

The lesson: init/connect flows that have a defined
"should succeed or fail loudly" expectation should
NEVER silently swallow. A failed init is a state
the caller needs to know about. Either log it,
surface it to the UI, or rethrow. The choice
depends on whether the caller can recover (here,
it can — scoreWavFile still runs and the diagnostic
tip surfaces the wrong-model state — so logging is
the right answer).

## What's NOT fixed

- If the user's wake-set registry is genuinely
  missing the trained model file, initOww will
  still fail at the native side. The catch now
  logs the error, but the test still shows
  "Loaded model: hey_jarvis" because the
  replacement detector fails to load the
  classifier. The user would see the log entry
  "initOww('hey clawsuu', 0.5) failed: No model
  file found for 'hey clawsuu' (bundled or
  custom)" in the log tab. Fixing this would
  require retraining the wake or fixing the
  registry, both outside the app code.