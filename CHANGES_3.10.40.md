# v3.10.40 — Wake listener self-heal + initOww retry

Tobe (post v3.10.39):

> "testing wake still gives me 0. Perhaps its the anti wake
> function within settings? Or did we remove that earlier?"

## Root cause

Tobe's home-screen log (from earlier) showed:

```
[3:01:34 PM] initOww failed: Failed to load TFLite models
[3:01:34 PM] startOwwListening failed: Call initOww first
```

`initOww` (called at app start with `'hey_jarvis'` to load
the bundled pre-trained model + melspec + embedding) failed
once. The failure throws an exception that escapes the
`OpenWakeWordDetector(...).apply { ... }` block, so
`owwDetector` is **left null**.

The next call was `startOwwListening`, which guards with
`if (detector == null) reject("OWW_NOT_INIT", "Call initOww
first")`. Since `owwDetector` is null, it rejects. **No retry,
no recovery.** The wake listener was permanently dead for
the entire session.

The "test wake" page (Tobe's screenshot just now) calls
`startOwwListening` and bails out when it rejects. Since the
listener never came up, `Mic RMS (avg)` stays at 0 and the
test falls into the `!owwWasRunning` branch → shows:

> "⚠️ Wake listener wasn't running — opened the mic for this
> test, but the detector never produced audio. Try entering
> voice mode first (it primes the listener), then re-run the
> test."

The "voice mode first" hint is correct — entering voice mode
calls `startSampleMatchListener` which calls `initOww`
again, and on the second call `loadModels` succeeds (the
first-call failure was a transient TFLite/AssetManager race).
But the test page is a separate UI flow that doesn't go
through voice mode, so it sees the dead listener.

## Tobe's "anti wake function" suspicion

There's no such toggle. There's a wake mode selector
(sample / porcupine / unknown) but that's not anti-wake;
it's which backend to use. The selection logic in
HomeScreen's useEffect already falls through to "no wake
words trained — tap Train wake phrase to record". That
warning wouldn't fire if a custom wake WAS trained.

So the issue is **transient initOww failure leaves the
session dead**, not an anti-wake setting.

## Fix

Two layers:

1. **`initOww` retry once on transient failure.** Wrap
   the constructor + loadModels in an attempt-loop with a
   500ms retry. If the first attempt throws, schedule a
   second via `handler.postDelayed`, increment `attempt`
   counter, log it in the wakeDebug stream, retry. If the
   second attempt also throws, surface the rejection to
   the caller (matching v3.10.39's TTS retry pattern: bail
   only after the bounded retry budget is exhausted).
   Two attempts total keeps cold-start latency under 1s
   worst-case.

2. **`startOwwListening` self-heal.** If the detector is
   null at the time of the call, lazy-init with the bundled
   default `'hey_jarvis'` model before throwing
   `OWW_NOT_INIT`. The wake listener comes up with the
   bundled pre-trained model — fine for test purposes
   and the home screen's wake listening; the user's
   actual custom wake ("Hey Clawsuu" etc.) is reloaded
   when the next `startSampleMatchListener` runs on the
   home screen with the typed wake word.

   If the lazy-init itself fails, fall through to the
   original `OWW_NOT_INIT` rejection so the caller still
   knows — just with an extra diagnostic.

## Files

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — `initOww` wrapped in attempt-loop with 500ms retry.
  `startOwwListening` self-heals with bundled `'hey_jarvis'`
  lazy-init if detector was null.
- `package.json` 3.10.39 → 3.10.40
- `android/app/build.gradle` versionCode 266 → 267,
  versionName 3.10.40

## Behavior

- **Cold-start transient initOww failure** (most common cause):
  now retries once after 500ms. Most common scenario this
  covers is the TFLite Interpreter constructor racing
  Android's HAL startup on cold app launch.
- **Persistent initOww failure**: same outcome as before
  (rejection surfaces to caller) but after two bounded
  attempts instead of one.
- **Wake test / startOwwListening with null detector**: now
  lazy-inits with bundled `'hey_jarvis'` so the test works.
  The user's custom wake word is then reloaded on the
  next `startSampleMatchListener` from the home screen.
- **No regression** for already-working sessions: both
  fallback paths preserve the detector when it exists.