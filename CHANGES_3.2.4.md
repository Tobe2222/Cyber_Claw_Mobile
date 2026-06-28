# v3.2.4 — Fix wake-trainer "Recording failed: stop failed"

## Bug

Tobe tapped "record" on the v3.2.3 trainer and got an instant
`Recording failed: stop failed.` modal with `Samples recorded: 0 / 6`.
Couldn't capture a single sample.

## Root cause

In `src/components/OpenWakeWordTrainer.tsx`, `recordOne` was calling

```ts
await recorder.start(path, 1500);
const finalPath = await recorder.stop();   // ← immediate
```

The `1500` was meant as a silence-detection timeout passed to the
native `startRecorderWithSilence`, but the trainer was calling
`stop()` *immediately* after `start()` — never waiting for the
silence event, never giving the user time to speak.

Android's `MediaRecorder.stop()` throws "stop failed" when called
in the first tens-of-milliseconds after `start()`, before any
frames have been written. So every recording died before any audio
landed.

The native side's silence-detection timer (in
`WakeWordModule.startRecorderWithSilence`) was working fine all
along — the JS just wasn't listening to it.

## Fix

`recordOne` now wires `recorder.once('silence', …)` and races it
against a 4-second hard cap. `stop()` is only called when one of
those fires. As belt-and-braces, the `stop()` call is wrapped in a
150 ms retry: if `MediaRecorder.stop()` still throws on the second
try, the original error surfaces as before.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — main fix
- `package.json` — 3.2.3 → 3.2.4
- `android/app/build.gradle` — versionCode 149 → 150, versionName 3.2.4
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.2.4

## Lesson

When wrapping a `MediaRecorder` (or any state-machine recorder),
**don't assume `start()` returning means "ready to stop"** — it
means "capturing, but maybe no frames yet." Always listen for an
event that signals "frames have landed" (silence threshold, max
duration, max-amplitude tick) before calling `stop()`. The 1500ms
silence timeout passed to the native side is meaningless if JS
ignores the silence event it produces.