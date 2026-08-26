# v3.10.176 — voice mode uses one piper voice everywhere

Tobe (2026-08-26): "i noticed when i tested voice mode that it still
used different voices for greeting/exit and response. Make sure that
all are routed to the user selected voice."

## Two stacked bugs

### Bug 1: cache lookup never used the per-companion voice

`getCachedGreetingPath`, `getCachedExitReplyPath`, and
`getCachedWorkingSpeechPath` were called from `WakeModeScreen.tsx`
without a `companionId`. `getCurrentVoiceIdForCache()` reads the
per-companion override `cyberclaw-voice-local-id-${companionId}` first,
then the global `cyberclaw-voice-local`, then `'lessac'`. The picker
only writes the per-companion key (`saveVoiceFor`), so without a
`companionId` the resolver always returned `'lessac'`. Every
companion's caches collided on the same `'lessac::phrase'` slot, and
the per-voice isolation added in v3.10.166 was a no-op in practice.

Fix: pass `companionId` through to all four call sites in
`WakeModeScreen.tsx` (voice-mode greeting, wake-mode greeting,
exit-reply, working speech). Now the cache resolves the voice the
user actually picked.

### Bug 2: Android TTS fallback used a different voice from piper

On cache miss the code did:

```ts
ensureGreetingCached(text).catch(() => {});
await speak(text);   // Android TTS
```

`speak()` routes through `WakeWordModule.speakText` →
`engine.setVoice(...)` against the bound Android TTS engine
(RHVoice / Google). The voice picker writes
`syncClient.setTtsVoice('kristin')` (piper name) AND
`wm.setTtsVoice('kristin')` to Android TTS. Android TTS has no voice
called `'kristin'` (RHVoice names are `slt`, `clb`, `amy`, etc.) —
the `setVoice` call fails silently, Android TTS keeps whatever voice
it had (typically the engine default like Google TTS en-US), and the
user hears THAT for greeting / exit / working speech.

AI replies go through the desktop piper cache-miss path (`main.js:5290
synthesizeSpeech(cleanText, ttsVoice)`), so they always use the voice
the user picked. Greeting, exit, and working speech all took the
cache-miss → speak() fallback. Three different voices in one session
when the cache was cold.

Fix: drop the `speak()` fallback on cache miss for greeting, exit
reply, and working speech. Piper is the single voice across the
session (Tobe 2026-08-11: "the goal is to build as local as
possible"). On cache miss:

- **greeting (voice mode)**: fire `ensureGreetingCached`, wait up
  to 4s for the WAV, play it. If it doesn't arrive, skip the
  greeting audio for this turn (next wake uses the warmed cache).
- **greeting (wake mode)**: kick off background synthesis for next
  time, skip audio for this turn.
- **exit reply**: fire-and-forget synthesis, wait up to 4s, play
  if it arrives. Skip otherwise.
- **working speech**: kick off background synthesis, skip audio
  for this turn.

The user either hears piper (the picked voice) or a brief silent
gap — never Android TTS. The Android-TTS engine is still bound
because Tobe uses it for things outside piper's scope (e.g. the
WebView speechSynthesis fallback inside `speak()` itself), but
those paths don't interject in voice mode anymore.

## Files

`src/screens/WakeModeScreen.tsx` — six call sites updated
(voice-mode greeting, wake-mode greeting, exit-reply, exit-reply
error path, exit-reply cache miss path, working speech cache miss
path). `package.json` 3.10.175→3.10.176, `android/app/build.gradle`
versionCode 383→384, versionName 3.10.175→3.10.176.

## Lesson

Two recurring patterns, both worth calling out:

1. **Resolver-with-optional-context needs an explicit fallback
   warning.** `getCurrentVoiceIdForCache(undefined)` silently
   returns `'lessac'` and the call sites never knew they were
   missing the argument. A `console.warn` on the no-companionId
   path would have caught this in v3.10.166 — the v3.10.166
   comment explicitly says "when voice is not provided, it is
   resolved internally from AsyncStorage (per-companion override,
   falling back to the global default, falling back to 'lessac')",
   which sounds intentional. It wasn't — the call sites just
   never passed companionId because they didn't know they should.

   Rule: any resolver that silently substitutes a default when an
   argument is missing should either (a) require the argument, or
   (b) warn when it falls back. The current behaviour hides
   bugs.

2. **"Fallback to a different engine" is rarely a real fallback
   for audio.** When piper is the source of truth for voice, an
   Android-TTS fallback doesn't give the user "something" — it
   gives them a jarring different voice. The right fallback for
   a missing-cache scenario is "wait longer" or "play nothing
   this turn", not "play a different voice". The bug class is
   "fallback path produces audio the user hears as the wrong
   thing", and the fix is to make the fallback path silent.
