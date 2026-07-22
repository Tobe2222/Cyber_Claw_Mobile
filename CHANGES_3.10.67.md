# v3.10.67 — Active enrollment: 30s auto-stop works + notifications

Tobe reported two bugs after testing v3.10.66's active
enrollment UI:

1. "It also did not stop after 30s as it says it will."
2. "No notification after manual stop."

Both are real, both have the same root cause: the v3.10.66
panel had no clean signal between the native recording
thread and the JS UI, so when the auto-stop fired the JS
side didn't notice and the mic gate stayed engaged.

## Bug 1: 30s auto-stop leaked the mic gate

**Symptom:** Tobe tapped "Train voice", the progress bar
ran to 30s, the UI kept saying "Listening…" indefinitely.
The native AudioRecord had been released in the thread's
finally block, but `EnrollmentCoordinator.end()` was
NEVER called on the auto-stop path. The BG service and
foreground listener stayed gated until Tobe pressed the
manual Stop button (which DID call `end()`).

**Root cause:** the `startActiveEnrollment` thread loop
exits via two paths:

```kotlin
while (activeEnrollmentRunning && time < durationMs) { … }
// (loop exits here on duration OR on stopActiveEnrollment)
finally {
    rec.stop(); rec.release()
    activeEnrollmentRunning = false
    // <-- no EnrollmentCoordinator.end() here!
}
```

`stopActiveEnrollment` calls `end()` AFTER joining the
thread, so manual stop was fine. The auto-stop path
relied on `stopActiveEnrollment` to be called *eventually*
(by the user) to flip the gate back. If they didn't,
nothing did.

**Fix:** in the thread's finally block, detect whether the
loop exited because the duration deadline elapsed (vs.
because someone called stop). If yes, call
`EnrollmentCoordinator.end()` ourselves. The `manual` stop
path still calls `end()` — it's idempotent, so the second
call is a harmless no-op (and is now wrapped in a guard
to avoid the double-call entirely).

```kotlin
var endedByDuration = false
try {
    while (activeEnrollmentRunning && time < durationMs) { … }
    endedByDuration = activeEnrollmentRunning   // true ⇒ auto-stop
} finally {
    rec.stop(); rec.release()
    activeEnrollmentRecorder = null
    activeEnrollmentRunning = false
    if (endedByDuration) EnrollmentCoordinator.end()
}
```

Also added a JS-side watchdog: a `setTimeout` of
`DEFAULT_DURATION_MS + 3000` that calls
`stopActiveEnrollment` from JS if the native side hasn't
emitted the auto-stop signal by then. Belt + suspenders
in case the native thread is stuck on a slow
AudioRecord.read or the OS paused our process.

## Bug 2: no notification after manual stop

**Symptom:** Tobe tapped "⏹ Stop early", the recording UI
disappeared, but no Toast appeared confirming the stop.
For the auto-stop, the UI just kept showing "Listening…"
indefinitely (Bug 1's symptom), which the user
interpreted as "no notification happened".

**Fix:** new native event `activeEnrollmentStopped` is
emitted from BOTH the auto-stop path (handler.post on the
main thread) AND from `stopActiveEnrollment`. JS-side
listener in `ActiveEnrollmentPanel` reacts with:

- Toast via `NativeBackground.showToast(...)` —
  "✅ Listening complete — review and lock profile" on
  auto-stop, "⏹ Stopped" on manual
- Cleanup of tick/poll/watchdog timers (the manual stop
  case duplicates what JS already did; the auto-stop case
  is the new fix)
- `setRunning(false)` so the panel UI flips to the
  post-recording state

The listener guards with a `stoppedRef` so a manual-stop
followed immediately by the auto-stop emit (race) only
fires the Toast once.

## Lessons

**Pair every native background action with a JS-visible
signal.** The v3.10.62-v3.10.66 active enrollment had a
native thread that exited silently from JS's perspective.
JS had to poll `isActiveEnrollmentRunning` to know when
to update the UI, and even then the panel didn't show a
Toast because there was no explicit "this just stopped"
event. Adding a `NativeEventEmitter` event for
lifecycle transitions (started / stopped / failed)
solves both at once: UI cleanup AND user feedback.

**Cleanup paths need to mirror success paths.** The
thread's `finally` block releases the recorder. The
`stopActiveEnrollment` JS method releases the mic gate.
But the auto-stop path went through neither — it just
exited the loop and called `finally`. When you have a
multi-step teardown (recorder + coordinator + UI +
notification), every exit path needs to walk through all
the steps, not just the "happy" path the developer
thought of. The cheap pattern: every cleanup step
records itself in a "did I do X?" set, and at the end
the program verifies each step actually ran.

**Idempotency is cheap insurance.** Calling
`EnrollmentCoordinator.end()` twice in a row on the
manual-stop path is harmless because the AtomicBoolean
just flips false→false. So even if the new `if
(endedByDuration)` guard misses a case, a stray extra
`end()` won't break anything. Compare to the alternative
("make sure every call site only calls end() exactly
once") which is correct but fragile. For shared
resources, prefer idempotent teardown.

**A JS watchdog isn't a substitute for fixing the native
side — but it's still worth having.** The JS
`setTimeout(watchdog, duration+3s)` will catch any future
bug where the native thread fails to exit. It doesn't
fix the underlying issue, but it bounds the user-visible
damage to 33s instead of "until the user notices and
manually hits Stop".

**Why no GitHub release yet for v3.10.66 fix?** Tobe's
report of "don't see anything on github yet" is most
likely the GitHub mobile app's cached release list. The
v3.10.66 release was published 2026-07-21 20:50 UTC
(confirmed via `https://api.github.com/repos/Tobe2222/
Cyber_Claw_Mobile/releases`). Hard-refreshing the
releases page on GitHub mobile usually clears the
cache. The v3.10.67 fix will publish via the same CI
workflow within ~10 min of pushing the tag.

## Files changed

- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt` (startActiveEnrollment thread
  finally + stopActiveEnrollment emit + new reason arg)
- `src/components/ActiveEnrollmentPanel.tsx`
  (NativeEventEmitter listener + watchdog timer +
  showToast call)
- `android/app/build.gradle` — versionCode 292→293,
  versionName 3.10.66→3.10.67
- `package.json` — version 3.10.66→3.10.67