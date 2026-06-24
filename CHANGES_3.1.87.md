# v3.1.87

## Pre-warm native TTS + stop native when WebView fallback fires

Tobe (after v3.1.86): "Opens correctly now. But there is still no wake
greeting sound when wake mode opens"

The v3.1.85 speak() Promise + v3.1.86 cold-launch fix should have made
the greeting audible. But Tobe still reports no sound. The most likely
remaining cause is that **two TTS paths are racing for audio output**:

1. Native TTS init starts when speak() is called (T=0)
2. WebView fallback fires at T=600ms (v3.1.85 delay)
3. Native TTS init completes around T=700-1200ms (typical Android
   cold-start init time)
4. **Both paths now try to speak simultaneously.** Two TTS engines
   compete for the same audio output. The user hears either
   garbled audio, or no audio at all (audio focus contention
   between two TTS engines causes both to drop).

### Fix

Three changes:

1. **Pre-warm native TTS at App.tsx mount.** Add a `prewarmTts`
   method to `WakeWordModule` that initializes the engine
   without speaking. Called from App.tsx in a new `useEffect`,
   so by the time the user actually wakes the app (a few seconds
   later), the engine is ready and `speakText` works on the
   first call with a reliable `ttsDone` event. This eliminates
   the cold-start init race entirely.

2. **Cancel native TTS when WebView fallback fires.** Add
   `WakeWordModule.stopSpeaking()` call in `speakViaWebView()`.
   Once the fallback decision is made, the WebView path becomes
   the authoritative speaker. No more race.

3. **Bump the WebView fallback delay from 600ms to 1500ms.**
   Gives native TTS more time to catch up. With pre-warming,
   native TTS is usually already warm by the time `speak()` is
   called; the 1500ms is for slow devices where the pre-warm
   didn't fully complete.

4. **Bump the WebView estimate from 60ms/char to 80ms/char** and
   raise the minimum from 600ms to 1500ms. The WebView's
   speechSynthesis is consistently slower than native TTS, and
   the previous estimate was cutting some utterances off.

5. **Add elapsed-time diagnostics** to the `🔊 done (...)` log
   line. e.g. `🔊 done (webview-estimate, 2180ms)` so future
   debugging has timing data without needing a screenshot.

### Files

- `App.tsx` — new useEffect that calls `WakeWordModule.prewarmTts()`
- `src/screens/WakeModeScreen.tsx` — speak() cancels native TTS
  on WebView fallback, longer fallback delay + estimate
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  new `prewarmTts` method
- `package.json` — 3.1.86 → 3.1.87
- `android/app/build.gradle` — versionCode 136 → 137
- `.github/workflows/{build,android-build}.yml` — artifact names
- `CHANGES_3.1.87.md` (new)

### Lessons

**Two TTS paths racing for audio output is a recipe for silence.**
The v3.1.85 fallback was well-intentioned (cold-start native TTS
init can fail or take seconds), but it didn't account for native
TTS catching up after the WebView fallback had already fired.
The right fix is to **make the fallback decision once and stick
with it** — call `stopSpeaking()` when the WebView path takes
over. Similarly, pre-warming is the canonical way to avoid
cold-start init races; an async resource that takes seconds to
initialize should be initialized at app start, not at first use.

**Always log elapsed time when debugging async flows.** The
"voice log" pattern (logging key events with timestamps) is
invaluable for diagnosing async bugs that don't show up in
stack traces. v3.1.87's `done (source, Xms)` log gives us
immediate timing visibility — if the user sees a 6000ms `done`
followed by no audio, we know it's an audio focus issue, not
a TTS issue. The screenshot-with-voice-log pattern that
uncovered v3.1.83's bug continues to pay off.