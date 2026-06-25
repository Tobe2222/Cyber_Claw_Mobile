# v3.1.91 — desktop-side TTS synthesis for the wake greeting

## Why

v3.1.90 added the `<queries>` fix for Android 11+ package visibility, but Tobe's device is still missing a TTS engine entirely. The `<queries>` block makes the existing engine discoverable — it can't conjure one into existence. So `TextToSpeech.onInit` still fires with `status=-1` (TextToSpeech.ERROR) and the wake greeting stays silent.

Tobe's idea (in the screenshot comment): route the greeting through the desktop. The desktop has working piper TTS (used for AI replies via `synthesizeSpeech` in `local-ai.js`). Synthesize the greeting audio on the desktop, cache the resulting WAV on the phone, play it locally via `MediaPlayer` on every wake event.

This is robust because:
1. Desktop TTS always works (it's the AI-reply path, battle-tested).
2. `MediaPlayer` plays audio on every Android device — no TTS engine needed.
3. The greeting audio file is small (~50-200 KB), persistent in DocumentDirectory.
4. Synthesis happens once per phrase change, then cached forever.
5. Works offline IF the phone still has the cached file (cache survives restarts).

## What changed

### Desktop (CyberClaw v3.1.31)

**`src/sync-server.js`** — added new message handler `request_greeting_audio`:
- Strips emojis from the phrase (same `stripEmojisForTTS` helper used for AI replies).
- Calls `localAI.synthesizeSpeech(cleanText, 'lessac')` — the same piper path used for AI replies, so the greeting voice matches the in-conversation voice.
- Sends back an `audio_response` tagged with `requestId: 'greeting'` and the original `text` (echoed back so the phone can match it to its cache key).

### Mobile (CyberClaw Mobile v3.1.91)

**`src/services/SyncClient.ts`** — new `requestGreetingAudio(text)` method; the `audio_response` case now re-emits on a separate `greeting_audio` channel when `requestId === 'greeting'`.

**`src/services/GreetingAudioCache.ts`** (new) — permanent cache for desktop-synthesized greeting audio:
- One WAV file per greeting phrase, hashed (djb2 → 8-char hex) so the filename is stable.
- Stored in `DocumentDirectoryPath/cyberclaw-greeting-<hash>.wav`.
- Index in AsyncStorage under `cyberclaw-greeting-cache-index` so we can look up the file without re-hashing.
- `getCachedGreetingPath(phrase)` → returns the path or null.
- `requestGreetingSynthesis(phrase)` → fire-and-forget sync-server request.
- `saveGreetingAudio(phrase, base64)` → writes the file + updates the index.
- `ensureGreetingCached(phrase)` → returns existing cache or kicks off synthesis.
- `clearGreetingCache()` → wipes everything (for Settings → "re-record").

**`App.tsx`** — mounted listener for `greeting_audio` events. App-level so it works whether the user is on Home, Settings, or Wake Mode when the audio response arrives. Saves the WAV to disk on receipt.

**`src/screens/WakeModeScreen.tsx`** — greeting playback flow:
1. Check `getCachedGreetingPath(greetingText)` — if it exists, play via `WakeWordModule.startPlayer(path)` (the same MediaPlayer used for AI replies, emits `audioPlayerFinished` on completion).
2. If no cache, kick off `ensureGreetingCached(greetingText)` (background synthesis) and fall back to `speakText()` — which logs `🔊 ❌ no TTS engine — install one` on no-engine devices but doesn't block the listener from starting.
3. New `playCachedGreeting(filePath)` helper awaits `startPlayer` + `audioPlayerFinished` event, with a 10s safety timeout.

**`src/screens/SettingsScreen.tsx`** — `persistReadyPhrase` now also calls `ensureGreetingCached(v)` after the debounced save, so changing the greeting phrase kicks off synthesis in the background.

## Expected behaviour

First wake after install (no cache yet):
```
🔊 Speaking: "Greetings master Toby"
🔊 no cached audio, requesting synthesis
🔊 ❌ no TTS engine — install one       ← still shows because native is broken
🔊 done (no-tts-engine, 16ms)
🎧 Listening for wake word...
```
~2-5 seconds later (desktop piper synthesis finishes):
```
[App.tsx console] [App] Greeting audio cached: cyberclaw-greeting-<hash>.wav
```

Subsequent wake events:
```
🔊 Speaking: "Greetings master Toby"
🔊 playing cached (cyberclaw-greeting-<hash>.wav)
🔊 done (cached-play, 1842ms)
🎧 Listening for wake word...
```

The greeting now plays via MediaPlayer on every Android device, regardless of TTS engine status.

## Files

### Desktop (v3.1.31)
- `src/sync-server.js` — `request_greeting_audio` handler + `_handleGreetingAudio` helper
- `package.json` — 3.1.30 → 3.1.31

### Mobile (v3.1.91)
- `src/services/SyncClient.ts` — `requestGreetingAudio`, `greeting_audio` channel
- `src/services/GreetingAudioCache.ts` (new) — cache layer
- `App.tsx` — global greeting_audio listener
- `src/screens/WakeModeScreen.tsx` — playCachedGreeting + cache-first greeting flow
- `src/screens/SettingsScreen.tsx` — synthesis request on phrase change
- `package.json` — 3.1.90 → 3.1.91
- `android/app/build.gradle` — versionCode 140 → 141
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.91

## Lessons

- **When the device can't do X, ship the result of doing X elsewhere.** Native TTS is broken on this device, but the desktop's piper TTS is healthy. Instead of fighting the broken local path, use the desktop to make the audio once, cache it, play it locally forever. Classic "edge cache" pattern applied to audio.
- **Caches belong in persistent storage, not temp.** `DocumentDirectoryPath` survives app restarts; `TemporaryDirectoryPath` (which the AI-reply path uses) doesn't. The greeting cache must persist, so we use DocumentDirectory.
- **Stable cache keys via hash, not the phrase itself.** Phrases can change (whitespace, punctuation). Hashing the phrase means the same logical greeting always hits the same cache file, and we don't bloat the storage with `cyberclaw-greeting-Greetings master Toby!.wav` + `cyberclaw-greeting-Greetings master Toby .wav` + ...
- **Fire-and-forget synthesis + always-mounted listener.** The desktop might take 2-5s to synthesize, and the user might be on any screen when the audio arrives. Mount the save listener at App level so we never miss the response, and use the cache lookup path on next wake to play it instantly.
- **The audio_response channel is overloaded for AI replies AND greeting cache writes.** Tagging with `requestId: 'greeting'` and re-emitting on a separate `greeting_audio` channel keeps the two consumers independent. Same protocol, different routing.