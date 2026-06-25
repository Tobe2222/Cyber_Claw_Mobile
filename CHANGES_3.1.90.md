# v3.1.90 — Android 11+ package visibility fix + TTS install path

## Root cause (the actual one)

v3.1.89's improved diagnostic made the real bug visible for the first time:

```
🔊 Speaking: "Greetings master Toby"
🔊 native failed: TTS init failed: status=-1
🔊 (webview fallback)
🔊 done (webview-estimate, 2107ms)
🎧 Listening for wake word...
```

**`status=-1` from the `TextToSpeech.OnInitListener` is `TextToSpeech.ERROR`** — the engine binding failed. This happens on Android 11+ (API 30+) when the app's manifest doesn't declare the `android.intent.action.TTS_SERVICE` intent in `<queries>`: package visibility restrictions prevent the system from binding the cross-process TTS engine.

Tobe's manifest had no `<queries>` block, so the system's default TTS engine (usually Google TTS, sometimes Samsung TTS) couldn't be discovered. The init listener was called with `ERROR`, our code rejected the JS promise, the WebView fallback fired, and `window.speechSynthesis` was a no-op — and that's why the greeting has been silent across every release since wake mode was added.

## What changed

### AndroidManifest.xml
- **Added `<queries>` block** with `android.intent.action.TTS_SERVICE` intent. **This is the actual fix.** Required for Android 11+ package visibility.
- Also added `android.intent.action.INSTALL_TTS_DATA` so we can launch the system TTS install dialog from JS.

### WakeWordModule.kt
- **`hasTtsEngine(promise)`** — new React method. Probes `PackageManager` for activities responding to `ACTION_CHECK_TTS_DATA`. Returns `true` if at least one TTS engine is installed.
- **`installTtsData(promise)`** — new React method. Launches the system TTS install activity (which opens a Play Store prompt to install Google TTS / eSpeak NG / etc.).

### App.tsx
- On `prewarmTts()` rejection, calls `hasTtsEngine()` and logs a clear, actionable warning:
  - No engine: `"No TTS engine installed on device. Voice greetings will be silent. Install Google TTS or eSpeak NG from Play Store, then re-open CyberClaw."`
  - Engine installed but init failed: `"Engine is installed but init failed. May need voice data download — check Android Settings → Accessibility → Text-to-speech output."`

### SettingsScreen.tsx
- `testLocalVoice()` now probes `hasTtsEngine()` first. If no engine is installed, shows an Alert offering to launch the install dialog via `installTtsData()`.

### WakeModeScreen.tsx
- When `speakText` rejects with `TTS_INIT_FAILED` + `status=-1`, the log shows `🔊 ❌ no TTS engine — install one` and `done()` resolves immediately with source `no-tts-engine` — no point trying the WebView fallback (also a no-op on these devices).
- Other TTS init failures (not -1) still fall through to WebView fallback as before.

## Expected behaviour after install

After the manifest queries fix, on a device with Google TTS / Samsung TTS / eSpeak NG installed, the next wake event should produce:

```
🔊 Speaking: "Greetings master Toby"
🔊 native enqueued (45ms)
🔊 done (native, 1842ms)
🎧 Listening for wake word...
```

If the device has no TTS engine, the user will see:

```
🔊 Speaking: "Greetings master Toby"
🔊 ❌ no TTS engine — install one
🎧 Listening for wake word...
```

…and a clear console warning in dev mode. They can tap "Test voice" in Settings → Install the recommended engine → return to CyberClaw.

## Files
- `android/app/src/main/AndroidManifest.xml` — `<queries>` block added
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — `hasTtsEngine`, `installTtsData`
- `App.tsx` — prewarmTts diagnostic
- `src/screens/SettingsScreen.tsx` — testLocalVoice offers install
- `src/screens/WakeModeScreen.tsx` — clearer no-engine log + skip WebView fallback
- `package.json` — 3.1.89 → 3.1.90
- `android/app/build.gradle` — versionCode 139 → 140
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.90

## Lessons
- **Android 11+ package visibility is a silent killer.** Many APIs that "just worked" on Android 10 need explicit `<queries>` declarations on Android 11+. The failure mode is silent ERROR, not a thrown exception.
- **Three layers of "fixes" in a row is the diagnostic telling you the model is wrong.** v3.1.85 / .86 / .87 / .88 all touched TTS init paths. The actual root cause was always package visibility at the manifest level — outside any of the TTS code I'd been editing.
- **Diagnostic logs pay back immediately.** v3.1.89's `🔊 native failed: TTS init failed: status=-1` line was the first time we'd seen the actual error. Without that one-line addition this would have been a much longer "why no audio" rabbit hole.
- **A WebView speechSynthesis fallback is theater on Android.** It almost never produces audio on React Native's bundled WebView. Don't rely on it as a real fallback — only as a diagnostic indicator.