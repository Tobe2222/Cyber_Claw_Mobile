# v3.1.83

## Two bug fixes: cold-launch auto-wake-mode ping-pong + greeting silently dropped

Tobe (after installing v3.1.82): "wake opens to wake mode now, which is good.
But i still dont get the greeting phrase. ... And when i start the app it
goes right into wake mode, which is not correct."

Two separate bugs:

### Bug 1 — Cold-launch auto-wake-mode entry

The v3.1.82 native wake-pending flag (SharedPreferences `wake_pending`)
was doing its job: if the user killed the app while a wake event was in
flight (JS context never came up before the 5s emit-retry budget), the
flag persisted and was recovered on next mount.

But v3.1.82 ALSO wired the flag check into an `AppState=active` listener
that re-checked on EVERY foreground transition. Combined with the flag
sometimes still being set when the user manually exited Wake Mode (e.g.
tapped X during the greeting phase, before the emit-success path ran),
this created a ping-pong: exit Wake Mode → re-foreground → check flag →
re-fire handleWake → yank back to Wake Mode.

**Fix (v3.1.83):** Check the native flag only on the first mount. The
cold-start recovery case (the only case that needs it) is handled there.
The "JS context loaded but event dropped" race is already covered by
`MainActivity.onResume` which re-emits via `emitWakeOpenedWithRetry`.
The `AppState=active` re-check was redundant belt-and-suspenders that
turned out to be more bug than safety net.

Additionally: `onExit` for the wake-mode screen now also calls
`WakeWordModule.clearWakePending()` defensively, so if the user exits
Wake Mode before the normal emit-success path cleared the flag, the
flag won't linger into a future app restart.

### Bug 2 — Greeting phrase silently dropped on cold start

The greeting flow in `WakeModeScreen` calls `speak(greetingText)` then
starts the listener 1500ms later. The `speak()` function tries native
TTS first (`WakeWordModule.speakText`), with a WebView
`speechSynthesis` fallback in the JS catch.

The native path goes through `getTts { engine -> engine.speak(...) }`.
`getTts` initializes Android's `TextToSpeech` service asynchronously.
On the success path it calls the `onReady` callback and everything works.
**On the failure path** (status != SUCCESS, e.g. cold start while the
TTS service was busy), the old code only logged a debug event — it
never called any error callback. So `speakText`'s promise **never
resolved AND never rejected**, the JS `.catch` never fired, and the
WebView fallback never ran. The greeting was silently dropped.

**Fix (v3.1.83):**

- **Native:** `getTts` now takes an `onError: (String) -> Unit` callback.
  On init failure it calls `onError`, and `speakText` rejects the JS
  promise with `TTS_INIT_FAILED`. The JS catch path is now the
  deterministic fallback on failure (no longer silently dependent on
  the catch ever firing).
- **JS:** `speak()` also adds a 600ms timeout fallback. If native TTS
  hasn't spoken within 600ms (the catch path either didn't fire or
  fired after a delay), the WebView `speechSynthesis` runs anyway.
  This covers the case where TTS init *does* succeed but takes
  longer than the greeting window — without this, the listener
  could come on before the greeting finishes, which was the original
  v3.1.80 mic-during-TTS bug.
- **Voice log overlay:** every `speak()` call now logs
  `🔊 Speaking: "<text>"` so it's visible whether the path fired and
  which TTS engine actually spoke (native vs WebView fallback vs both
  failed). Makes future debugging trivial.

### What was NOT in scope

Tobe considered per-companion greetings and a settings-side test button
but decided: "I dont think we need a phrase per companion. One for all
is sufficient. We dont need to have a test button if that cannot be
tested inn settings. We can test it normaly when waked." So the
existing `cyberclaw-ready-phrase` storage key remains the single knob.
The fix above makes the greeting actually play; that's all that was
needed.

### Files

- `App.tsx` — drop `AppState=active` re-check; clear native flag on
  wake-mode `onExit`
- `src/screens/WakeModeScreen.tsx` — `speak()` adds voice log + 600ms
  WebView fallback timer
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  `getTts` + `speakText` reject on TTS init failure
- `package.json` — 3.1.82 → 3.1.83
- `android/app/build.gradle` — versionCode 132 → 133
- `.github/workflows/{build,android-build}.yml` — artifact names to
  3.1.83

### Lessons

**Cold-start races between the React tree and the Android activity
lifecycle are not just "first mount" events.** v3.1.82 added a
recovery flag for one specific race (JS context not ready when
MainActivity emits), but then re-checked it on every `AppState=active`
"just to be safe." The "just to be safe" became the bug. Recovery
flags are sticky by definition, so re-checking them on app-foreground
events means the user can never escape the recovered state. Always
pair a sticky recovery flag with a clear-on-successful-recovery path
AND a clear-on-user-explicit-exit path, and resist the urge to
re-check it "just in case."

**Async init callbacks with no error path = silent failure.**
`TextToSpeech`'s init lambda has two outcomes (success, failure),
but `getTts` only handled success. The promise shape in `speakText`
(then/catch) implied that failures would surface, but they didn't.
Lesson: if a Kotlin function is meant to feed into a JS promise,
both the success and failure paths of any async setup it does must
call the promise's resolve/reject. Silent swallowing of init errors
is a recurring source of "we tried, but nothing happened" bugs.