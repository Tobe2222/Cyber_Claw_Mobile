# v3.1.89 — stop killing native TTS, surface cold-start diagnostic

## Root cause (finally)

The "(webview fallback) done (webview-estimate, 1696ms)" log line in v3.1.87 / v3.1.88 was a lie. Here's what was actually happening on Tobe's device:

1. Wake event → wake mode opens → `speak("Ready to chat")` called.
2. `WakeWordModule.speakText()` → `engine.speak()` is queued. The engine isn't done loading voice data yet (cold start after wake).
3. The JS fallback timer fires at 1500ms because `ttsDone` hasn't arrived.
4. **The WebView fallback called `WakeWordModule.stopSpeaking()`** — which cancelled the queued native TTS utterance that was about to actually play.
5. WebView fallback then injected `window.speechSynthesis.speak(u)` — but Android System WebView's `speechSynthesis` is **almost always a no-op** on React Native's bundled WebView (no TTS engine hooked into the Web Speech API).
6. Result: WebView fallback's `done (webview-estimate)` fires, but no audio ever plays.

So the v3.1.87 "fix" (call `stopSpeaking()` in the WebView fallback to avoid the audio focus race) was actually the bug that was silencing native TTS.

## What changed

### WakeWordModule.kt
- **Removed the `flushPendingUtterances` / `primeEngineWithFirstPending` complexity** that I added mid-edit. Simpler is better.
- Added `ttsVoicesReady` flag (diagnostic only, no longer gates speak()).
- `actuallySpeak()` now logs `engine.speak()` return code so we can see whether the utterance was accepted or rejected.
- `onStart` callback marks `ttsVoicesReady=true` when the first utterance actually starts producing audio — useful diagnostic for "is TTS actually working?".
- `engine.speak()` return code is now checked: if it's not `SUCCESS` (0), the JS promise rejects with `TTS_SPEAK_FAILED` instead of silently resolving.
- `getTts()` simplified: if the engine exists and is bound, hand it over immediately. No more "wait for voices" gate — the engine's own queue handles backpressure.

### WakeModeScreen.tsx
- **REMOVED `WakeWordModule.stopSpeaking()` from `speakViaWebView()`** — the v3.1.87 bug. Native TTS is no longer killed when the WebView fallback fires. If native TTS was about to play, let it play.
- **Fallback timeout bumped 1500ms → 3500ms.** Tobe's post-wake cold-start was taking 2-3s before `ttsDone` fired. 1500ms was racing past the actual speech.
- **Safety timeout bumped 5s → 8s.** Worst-case first utterance after wake.
- **Estimate duration bumped** from `max(1500, len*80)` capped at 4000ms → `max(2000, len*100)` capped at 6000ms. WebView fallback's "done" is now longer than the 3500ms fallback timer, so if native TTS fires `ttsDone` first (the happy path), we use that and the estimate timer just gets cleared. If native TTS truly fails, the estimate gives the WebView enough time to even attempt speech.
- Added `🔊 native enqueued (Xms)` log on `speakText` promise resolution — tells us how fast native enqueued the utterance.
- Added `🔊 native failed: ...` log on promise rejection — used to be silent.

### HomeScreen.tsx
- Voice log buffer 4 → 5, display 3 → 5 lines.

### WakeModeScreen.tsx
- Voice log buffer 4 → 5, display 3 → 5 lines. **(Tobe's request.)**

## Voice log overlay now shows 5 lines

Previously slice(-3) hid the Speaking / Greeting / Matching prelude, so we couldn't tell whether `speak()` was even being called. Now:

```
🔊 Speaking: "Ready to chat"
🔊 Greeting...
Matching: clawsuu
🔊 native enqueued (45ms)        ← new
🔊 done (native, 1842ms)         ← was "webview-estimate"
🎧 Listening for wake word...
```

Or, if native TTS is genuinely broken:

```
🔊 Speaking: "Ready to chat"
🔊 Greeting...
Matching: clawsuu
🔊 native enqueued (35ms)
🔊 native TTS slow, falling back   ← at 3500ms
🔊 (webview fallback)
🔊 done (webview-estimate, 5500ms) ← at 5500ms
🎧 Listening for wake word...
```

The new "native enqueued" line tells us whether the engine actually accepted the utterance — if we see it but still no audio, the problem is on the engine side (no voice data installed, audio focus contention, etc.), not in our speak() logic.

## Lessons

- **Removing a "safety" check broke the system.** v3.1.87 added `stopSpeaking()` in the WebView fallback to prevent "audio focus contention" — but the real audio focus contention was hypothetical, while the silent kill of native TTS was a real bug. The check existed to solve a problem that wasn't actually happening on Tobe's device.
- **The WebView `speechSynthesis` API is unreliable on Android React Native.** It depends on whether the System WebView was built with TTS support enabled, which is essentially never for the default Android WebView. Don't rely on it as a real fallback — only use it as a last-ditch diagnostic indicator.
- **Diagnostic logging is the fastest path to "why no audio".** The new `🔊 native enqueued (Xms)` + `TTS speak() returned N for "..."` lines will tell us in one glance whether native TTS is healthy.

## Files
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
- `src/screens/WakeModeScreen.tsx`
- `src/screens/HomeScreen.tsx`
- `package.json` — 3.1.88 → 3.1.89
- `android/app/build.gradle` — versionCode 138 → 139
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.89