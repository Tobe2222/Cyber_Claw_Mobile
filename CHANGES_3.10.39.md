# v3.10.39 — TTS init retry + 'Mic:' → 'Wake:' debug label

Tobe (post v3.10.38):

> "my log says mic error for some reason. Forgot that i had a
> log there lol"

## 1. 'Mic:' → 'Wake:' in the log debug label

The wakeDebug stream in HomeScreen's log tab catches EVERY
wake-module emit — mic init, OWW load, sample-match event,
TTS init, recorder WAV write, etc. But the UI labeled it
`Mic: ...` which was misleading. Tobe noticed v3.10.38 showed:

```
Mic: error: "TTS init failed: status=-1"
```

That label prefix dates back to v3.1.85-ish when the
debug stream only contained mic-related errors. Now it
catches all wake-module errors.

Fix: renamed `Mic: ...` to `Wake: ...` in HomeScreen.tsx.
Accurate to the underlying stream (the wake module's
debug emit). The status=-1 TTS error is still surfaced
clearly as a wake-module error, not mis-categorised as a
microphone problem.

## 2. TTS init retry on first-attempt failure

The screenshot's status=-1 = `TextToSpeech.ERROR`. This
fires when the Android system TTS service is busy or not
yet ready at cold start, which is common. Previously
getTts() would surface the failure immediately and the
JS-side fallback timer would kick in, but the fallback's
3.5s window had already started ticking.

### Fix

getTts() now wraps the bind in a single-attempt retry:
- Attempt 1 fires on cold start.
- If status != SUCCESS, schedule a retry via `handler.
  postDelayed({...}, 1000L)` (1s later).
- Attempt 2 fires.
- If attempt 2 also fails, surface the error to the
  caller (so the JS WebView speechSynthesis fallback
  still kicks in for genuinely broken TTS).

This catches the cold-start race where the system TTS
service is still spinning up. Tobe's screenshot pattern
(`status=-1` on a single startup event with no further TTS
errors in the log) matches exactly this race — the first
bind failed, but the second bind (triggered by the next
`getTts` call from a `speakText` retry) succeeded and went
on to actually produce audio.

The retry's onError is suppressed during the wait — only
attempt 2's onError is terminal — so the JS-side fallback
timer sees the real cumulative ~2s bind time, not a fast-
failing first attempt.

### Likely secondary win for v3.10.37's working cue

If v3.10.37's "Working" speech TTS was failing silently
on Tobe's device because of the same cold-start race (the
first speak() call hit the failing first bind, the
fallback ran, but the WebView path's speechSynthesis is a
no-op on some Android devices), this retry should make
the v3.10.37 cue/speech reliably audible. After this
build, the cycle is: bind attempt 1 (or 2) → TTS ready →
speak() actually speaks "Working" on the device's
default TTS engine.

## Files

- `src/screens/HomeScreen.tsx` — `Mic:` prefix → `Wake:`
  in the wakeDebugBar render. Comment block explaining the
  scope of the wakeDebug stream.
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — `getTts` wrapped in attempt-loop with retry. Uses
  the existing class-level `handler` field for the
  `postDelayed` retry scheduling. Error message now
  includes `(attempt N)` for diagnostic clarity.
- `package.json` 3.10.38 → 3.10.39
- `android/app/build.gradle` versionCode 265 → 266,
  versionName 3.10.39

## Side effects

- **Working speech TTS** should now reliably fire on
  voice-mode turns. The first speak() call after voice
  mode opens previously raced the TTS service init and
  sometimes failed (the v3.10.37 "It did not say working"
  report). The retry means the second attempt usually
  succeeds, and the actual speech plays.
- **Greeting / exit replies** were already covered
  indirectly: their speakText retry mechanics (separate
  from getTts — they re-call getTts on the next utterance)
  would have caught the race, but the user-visible label
  was misleading.
- **No regressions** — the retry is bounded (1 attempt
  only) and only fires on status != SUCCESS. If TTS is
  genuinely broken, both attempts fail, onError bubbles
  up, and the existing WebView fallback path runs
  unchanged.