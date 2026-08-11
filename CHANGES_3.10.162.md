# v3.10.162 — working speech uses piper (single voice everywhere)

## What

The "Working..." cue now plays from the desktop piper
cache, same voice as the greeting + AI response + exit
reply. Android TTS is now only a rare cache-miss
fallback (first turn after changing the working
phrase, before the desktop synthesis arrives).

## Why

Tobe (2026-08-11 22:22): "this app is built on the
premise that the computer is online anyway. ... the
goal is to build as local as possible."

Three voice stacks were producing three different
voices:
- Greeting: desktop piper (lessac)
- Working speech: Android TTS (RHVoice SLT/CLB/BDL on
  Tobe's GrapheneOS)
- AI response: desktop piper (lessac)
- Exit reply: desktop piper (lessac) when cached, else
  Android TTS fallback

Three voices in one session = jarring. The fix is the
same pipeline as the greeting cache, which was already
working: mobile requests a synthesis, desktop piper
produces the audio, mobile caches it forever, all
subsequent plays hit the cache.

## Files changed

### `src/services/WorkingSpeechAudioCache.ts` (NEW)

Mirrors `GreetingAudioCache.ts` + `ExitReplyAudioCache.ts`.
Exports:
- `getCachedWorkingSpeechPath(phrase)` — returns the
  DocumentDirectoryPath file or null on miss.
- `ensureWorkingSpeechCached(phrase)` — fire-and-forget
  desktop synthesis request. Pre-warmed on app start +
  whenever the user changes the phrase in Settings.
- `saveWorkingSpeechAudio(phrase, base64)` — called
  from the audio_response listener when
  requestId='working_speech'.

### `src/services/SyncClient.ts`

- New `requestWorkingSpeechAudio(text)` method.
- `audio_response` handler routes
  `requestId === 'working_speech'` to a new
  `working_speech_audio` channel (same pattern as
  greeting + exit_reply).

### `App.tsx`

- New listener on `working_speech_audio` channel saves
  incoming audio to the cache.
- New mount-time `useEffect` pre-warms the working
  speech cache with the user's current working phrase.

### `src/screens/SettingsScreen.tsx`

- `persistWorkingSpeech` now calls
  `ensureWorkingSpeechCached(trimmed)` after writing
  AsyncStorage, so the next voice-mode turn plays the
  new phrase in piper voice.

### `src/screens/WakeModeScreen.tsx`

- `playWorkingCueAndSpeak` now reads from
  `getCachedWorkingSpeechPath` first; on cache hit, plays
  via `playAudioFile` (the v3.10.161 shared helper).
  On cache miss, falls back to `speakRef.current?.(speech)`
  (Android TTS).

## Desktop companion

cyberclaw v3.2.91 added the matching handler in
sync-server.js: `case 'request_working_audio'` dispatches
to `_handleWorkingAudio`, which calls
`localAI.synthesizeSpeech(cleanText, 'lessac')` and
sends back `audio_response` tagged
`requestId='working_speech'`.

## Trade-offs

- Cache miss on the first turn after the user changes
  the working phrase falls back to Android TTS. The
  user hears one piper-style voice turn, then
  piper from then on. Acceptable because Settings
  changes are rare.
- The piper cache adds ~50-200KB per phrase to the
  app's document directory (one WAV file per phrase).
  Trivial for the use case.

## Latency

The piper cache hit path reads a file + calls
startPlayer — no round-trip to the desktop. The first
play (cache miss) costs ~300-1500ms for the desktop
synthesis, but that's a one-time cost per phrase
change.

## What still uses Android TTS

Only the rare cache-miss path for the working cue.
Everything else (greeting, AI response, exit reply,
turn cue sound) uses piper or pre-recorded assets.
