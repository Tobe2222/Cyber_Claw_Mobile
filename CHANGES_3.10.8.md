# v3.10.8 — Wake Test button + cue-sound AssetManager fix

Tobe tested v3.10.7 and reported (channel `#cyber-dev`,
screenshot of the voice-mode screen):

1. **Wake still needs to be repeated right after
   startup**, and **false triggers from ambient
   noise** are still happening. Tobe wants a way to
   **test the wake phrase** so we can see how
   confident the model is when he says it, and so he
   can rule out "model doesn't recognise my voice"
   vs "threshold is too tight".

2. **Cue sound still doesn't play**, even after the
   v3.10.7 race-condition fix. The wait-for-cue-
   finish code runs but no audio is heard.

## Fixes

### #1 — "🎤 Test wake" button on the Wake settings page

Added a test button to the "Currently active wake"
panel (under each companion's Wake sub-page). On tap,
the page starts a 4-second listening window during
which it polls `WakeWordModule.getLatestScores()`
every 80ms (matching the OWW chunk rate) and records:

- **Peak wake score** — highest confidence the model
  had that the user said the wake phrase during the
  window
- **Peak exit score** — same for exit phrase
- **Peak send score** — same for send word
- **Fired?** — whether `owwWakeDetected` actually
  fired during the window (the model passed the
  threshold for `HIGH_SCORE_RUN=3` consecutive
  frames = 240ms confirmation)

Result panel shows: ✓ Wake fired (78%) or ✗ No
fire, plus the three peak scores, plus a tip
("aim for Wake peak ≥ 70%").

**Why this matters for diagnosis:**
- If peak wake is high (>0.7) but `fired=false`,
  the OWW detector isn't firing reliably across
  the `HIGH_SCORE_RUN=3` window. Either lower the
  threshold, or the model's score is oscillating
  (false positives interleaved).
- If peak wake stays low (<0.5) even when the user
  says the phrase clearly, the model doesn't
  recognise their voice — needs retraining.
- If peak wake spikes on ambient noise (TV, other
  conversations), the false-positive issue is
  confirmed — raise the threshold or retrain with
  more diverse "this is NOT the wake word" examples.

Native side: added `@Volatile latestWakeScore /
latestExitScore / latestSendScore` fields to the
OWW listening thread (updated every 80ms chunk) and
a new `getLatestScores()` ReactMethod that returns
the current scores as a map. JS-side polls every
80ms and tracks peak.

### #2 — AssetManager-based startPlayer for asset paths

The cue sound `file:///android_asset/sounds/turn-${cue}.wav`
was failing to load. The previous `setDataSource(String)`
on a `file:///android_asset/` URI is unreliable across
Android builds — in some versions the MediaPlayer
enters the Error state SILENTLY (no exception, no
log line), and `start()` does nothing. The v3.10.7
code waited for a `audioPlayerFinished` event that
would never come, fell through to the 3s timeout,
and the user heard nothing.

Native-side fix (WakeWordModule.kt's `startPlayer`):

```kotlin
if (path.startsWith("file:///android_asset/")) {
    val assetRel = path.removePrefix("file:///android_asset/")
    val afd = reactContext.assets.openFd(assetRel)
    mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
    afd.close()
} else {
    mp.setDataSource(path)
}
mp.setOnErrorListener { _, what, extra ->
    emitDebug("error", "MediaPlayer error what=$what extra=$extra")
    try { mp.release() } catch (_: Exception) {}
    mediaPlayer = null
    true
}
mp.setOnCompletionListener { ... emit("audioPlayerFinished") ... }
mp.prepare()
mp.start()
```

The `AssetManager.openFd()` approach is the
documented Android way for bundled assets — it
returns a `FileDescriptor` with explicit
`startOffset` and `length`, which `setDataSource`
handles deterministically.

Also added `setOnErrorListener` so any future
MediaPlayer failures are visible in the debug log
(previously they were silently swallowed).

## Files

- `src/screens/CompanionSettingsScreen.tsx`
  (+~180 / -10): added `wakeTestRunning` and
  `wakeTestResult` state, `handleTestWake`
  useCallback, test button + result panel, and
  `activeWakeTest*` style cluster. Hook order
  preserved (state at top, before any conditional
  early returns).
- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt` (+~30 / -10): AssetManager
  path in `startPlayer`, `OnErrorListener`,
  `getLatestScores()` ReactMethod, three
  `@Volatile` score fields updated per OWW chunk.
- `package.json` — 3.10.7 → 3.10.8
- `android/app/build.gradle` — versionName
  3.10.7 → 3.10.8, versionCode 234 → 235

## Lessons

**1. Always provide a diagnostic surface for
state-driven bugs.** Tobe's wake-sensitivity and
false-trigger issues looked identical from the
outside ("wake fires or doesn't"). Without a way
to see the actual scores, we were guessing. The
test button gives both of us a concrete readout:
peak scores + fired/not, on demand. When the
diagnosis takes one tap instead of "edit code,
rebuild, install, say wake word, watch log, repeat
five times" the iteration loop tightens by 10x.

**2. Silent failure in error states is the worst
failure mode.** `MediaPlayer.setDataSource(String)`
on an asset URI silently entering the Error state
on some Android builds was the cue-sound bug for
3+ versions (v3.9.8 → v3.10.7). No exception,
no log line, the start() call returns, the user
hears nothing. The fix has two parts: use the
documented AssetManager path so the error doesn't
happen, AND register an `OnErrorListener` so
future silent failures get logged. Both fixes
together.

**3. The diagnostic primitive (peak score) is
the same shape as the failure mode (low score
→ no fire).** When you can't tell why a feature
isn't working, expose the underlying signal so
the user can read it directly. `getLatestScores`
gives back exactly the data the OWW detector
uses to decide whether to fire — same numbers,
same units (0.0-1.0 confidence), same notion of
peak. No translation needed.

**4. "Build it and they will tell you" is
slower than "ask them what to build".** Tobe's
"some button beside it" was a direct, concrete
feature request. The implementation took ~120
lines (state + handler + UI + styles + native).
But the design was 5 minutes: just give them
what they asked for. Don't second-guess the
shape of the diagnostic tool.

## Forward plan

If Tobe runs the test multiple times after
startup and the peak wake is consistently
>0.7 but it still doesn't fire reliably, the
next step is to lower the threshold further
(0.5 → 0.4) and check whether false positives
appear. If the peak stays low, retraining with
more samples or in a different acoustic
environment is the path.

If the cue still doesn't play after v3.10.8,
next steps are: (a) verify the asset path is
correct by adding a startup test sound, (b)
add AudioFocus request to startPlayer so we
get explicit feedback when audio focus is
denied, (c) try SoundPool instead of
MediaPlayer for the cue (lower latency,
designed for short SFX).