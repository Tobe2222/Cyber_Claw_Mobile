# v3.10.54 — wake-trainer stale closure on `_onModel` (typed phrase dropped on save)

## What

The wake-trainer was saving new wake sets with an empty phrase
regardless of what the user typed. The mobile-side wake-set
display then showed the setId (a timestamp-based fallback) instead
of the user's typed name.

## Why (root cause)

The trainer's `_onModel` handler is registered with `useRef` so its
identity stays stable across renders (so `sync.on(...)` doesn't
re-register on every render):

```js
const _onModel = useRef(async (msg: any) => {
  // ...
  WakeWordModule.setWakeModelFromBase64(companionId, msg.base64, wakePhrase);
  // ...
}).current;
```

`useRef` captures the function once, on the FIRST render. The
captured `wakePhrase` is therefore the initial value of the state
on first render — which is:

- `''` if `presetPhrase === ''` (the "Train new wake phrase" path
  from `CompanionSettingsScreen.tsx` passes `presetPhrase: ''`),
  OR
- `presetPhrase ?? 'hey ${companionName}'` (typically `'hey clawsuu'`)
  if a `presetPhrase` was passed (the "retrain" path from the
  picker).

The user then types a new phrase in the TextInput. `setWakePhrase`
updates the state and the component re-renders — but `_onModel`
still references the original closure with the FIRST render's
value.

When training completes (asynchronously, often minutes later),
`_onModel` fires `setWakeModelFromBase64` with the STALE
`wakePhrase`. The native side stores an empty phrase (because
`presetPhrase=''` was the initial value, and "hey clawsuu"
became the trainer's typed default if the user didn't replace it
before tapping Train), meta.json has `phrase=""`,
`displayName=""`, and `setId` falls back to
`wake-<timestamp>` (the `ifEmpty { "wake" }` branch).

The UI then shows the setId because `displayName || phrase` is
both empty, falling through to the setId display.

Tobe hit this on 2026-07-18 19:55 GMT+2:

> "Okey i retrained. Its name is still not the same as i set it
> to, i called it 'Hey clawsuu'. It should keep that name. And
> if one already exist with that name it should be replaced."

## Fix

Introduce a `wakePhraseRef` that's kept in sync with the
`wakePhrase` state on every render. Use the ref (not the captured
variable) inside the `_onModel` useRef callback:

```js
const wakePhraseRef = useRef(wakePhrase);
wakePhraseRef.current = wakePhrase;

// ...inside _onModel:
WakeWordModule.setWakeModelFromBase64(companionId, msg.base64, wakePhraseRef.current);
```

This preserves the stable function identity (no re-registration
on every render) AND reads the latest typed phrase at fire time.
Same shape used by the `BackgroundService.start(wakePhraseRef.current)`
call right after.

## Verification

After installing v3.10.54:
1. Tap "Train new wake phrase for Clawsuu".
2. In the trainer TextInput, type "Hey clawsuu" (capital H, capital C).
3. Record 6 samples, tap Train, wait for completion.
4. The active wake panel on the Wake settings screen should show
   "Hey clawsuu" (not "wake-<timestamp>").
5. The setId in the meta directory on-device should be
   `hey-clawsuu-<timestamp>`, not `wake-<timestamp>`.

If a wake set named "Hey clawsuu" already exists when a new
training completes, the existing set should be deleted (the
existing dedup logic in `setWakeModelFromBase64` checks for
same agentId + phrase case-insensitive). After dedup, only one
"hey-clawsuu-*" set should exist for that companion.

## Files

- `src/components/OpenWakeWordTrainer.tsx`:
  - new `wakePhraseRef` declaration after `wakePhrase` state.
  - `_onModel` reads `wakePhraseRef.current` instead of `wakePhrase`.
  - `BackgroundService.start(wakePhraseRef.current)` in the same callback.
- `package.json`: 3.10.53 → 3.10.54.
- `android/app/build.gradle`: versionCode 280 → 281,
  versionName "3.10.53" → "3.10.54".

## What this doesn't fix (still open)

The wake test still shows peak=0% even with the right model
loaded and the new augmentation applied (verified:
`hey_clawsuu.tflite` on disk produces a healthy sigmoid
distribution on random embeddings, score range 0.05-0.69,
mean 0.395 — the model is alive). The v3.10.54 fix
addresses the **naming** bug only.

Wake-detection investigation needs more info from the phone:
- Logcat output from a wake test session (would show
  `initOww` success/failure, `setWakewordModelFromFile`
  success/failure, and any predictScore warnings).
- OR a Python-side test that scores the trained model
  against the user's actual recordings (we have access to
  `~/.openclaw/cyberclaw/wake-training/clawsuu/output/model/hey_clawsuu/`
  on the desktop side, but not the user's recordings
  directly).

If wake detection still fails after this fix, the next step
is to add a one-line diagnostic that dumps predictScore's
per-chunk output to the log tab so Tobe can see exactly
what the model is returning.

## General lesson

**`useRef(async (msg) => { ... state_var ... })` captures
state_var at first render. Always.** This is the same trap
as v3.10.51's "stale options closure" fix
(`useClassifierTest`'s `start` captured `options` from first
render). Both fixes follow the same pattern:

- Old approach: capture state directly in the useRef callback.
- New approach: capture a ref via `useRef(state_var)` and update
  the ref on every render (`ref.current = state_var`). The
  callback reads `ref.current` at fire time.

The ref pattern is the right primitive for "stable callback
identity + latest state". `useCallback` re-creates the function
on every relevant state change (good for `deps` tracking, bad
for `sync.on(...)` re-registration). `useRef` keeps the
function stable (good for one-time registration, bad for
state freshness without the ref indirection).

Whenever you see `useRef((...) => { ...someState... })` in
React, ask: "is `someState` read inside the callback? If yes,
is it OK to be stale?" If the answer is "not OK", promote
the state to a ref.

## Related

- v3.10.51: same pattern of bug in `useClassifierTest.start`
  (different hook, same shape). The trainer had the same
  shape but wasn't part of the v3.10.51 fix scope.
- v3.10.6: UI hides setId line when it duplicates
  displayName/phrase — related UX guardrail, doesn't fix
  the underlying state-staleness.
- MEMORY.md "v3.10.51" entry: the v3.10.51 root cause
  writeup, which this fix builds on.