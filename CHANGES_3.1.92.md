# v3.1.92 — pre-warm greeting cache at Wake Mode open

## Why

Tobe tested v3.1.91 and the greeting was still silent. The log showed:

```
🔊 no cached audio, requesting synthesis
🔊 Speaking: "Greetings master Toby"
❌ no TTS engine — install one
done (no-tts-engine, 3ms)
🎧 Listening for wake word...
```

The synthesis request was sent to the desktop, but the cache was empty for THIS wake event. The audio response takes 2-5s to come back from the desktop (piper TTS), so the user has to trigger wake TWICE before the cache is ready. Bad UX.

## What changed

### `src/screens/WakeModeScreen.tsx`

**Pre-warm the greeting cache at Wake Mode open** (before the listener starts), not at the wake event:
- Read `cyberclaw-ready-phrase` from AsyncStorage
- If a cache file already exists for this phrase → log `🔊 greeting cached ✓ (...)` and skip
- If no cache → log `🔊 pre-warming greeting via desktop...` and fire `ensureGreetingCached()` (synthesis request)
- By the time the user actually says the wake word (a few seconds later), the synthesis has (usually) completed and the cache is ready

### `src/services/GreetingAudioCache.ts`
- Added console logs around the synthesis request so the user can see in the Metro logs whether the request was sent, whether a duplicate was de-duped, and what the desktop sent back
- New `isSynthesisPending()` helper (currently unused, placeholder for future "is the desktop actually responding?" diagnostics)

## Expected behaviour

**First Wake Mode open after install (no cache):**
```
🔊 Greeting...
Matching: hey-clawsuu
🔊 pre-warming greeting via desktop...   ← NEW: cache pre-warm starts NOW
🎧 Listening for wake word...
[console] [GreetingAudioCache] Requesting desktop synthesis for "Greetings master Toby"
... 2-5 seconds pass, user says wake word ...
🔊 Speaking: "Greetings master Toby"
🔊 playing cached (cyberclaw-greeting-<hash>.wav)  ← NEW: cache hit
🔊 done (cached-play, 1842ms)
🎧 Listening for wake word...
```

**Second Wake Mode open (cache exists):**
```
🔊 Greeting...
Matching: hey-clawsuu
🔊 greeting cached ✓ (cyberclaw-greeting-<hash>.wav)   ← NEW: cache confirmed
🎧 Listening for wake word...
```

If the desktop isn't connected or isn't running v3.1.31+:
- The SyncClient's `send()` method logs `[SyncClient] Dropped 'request_greeting_audio' — WS not open`
- Or the desktop receives the request but doesn't recognize the message type (older desktop version)
- In either case the cache stays empty and the user sees `no cached audio, requesting synthesis` on every wake

## Why this is also a diagnostic improvement

The pre-warm happens at Wake Mode open, BEFORE the wake event. That means:
- The user sees `🔊 pre-warming greeting via desktop...` immediately on opening Wake Mode
- If the synthesis never arrives, the user can immediately check whether the desktop is connected
- Previously, the synthesis request was buried inside the wake event flow and easy to miss

The console logs around `requestGreetingSynthesis` make it visible in the Metro/device log:
- `[GreetingAudioCache] Requesting desktop synthesis for "..."` — request sent
- (no follow-up) — desktop didn't respond (outdated desktop version, or WS not open)
- `[App] Greeting audio cached: ...` — success

## Files
- `src/screens/WakeModeScreen.tsx` — pre-warm block at Wake Mode open
- `src/services/GreetingAudioCache.ts` — diagnostic logs
- `package.json` — 3.1.91 → 3.1.92
- `android/app/build.gradle` — versionCode 141 → 142
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.92

## Critical reminder for Tobe

**The desktop app also needs to be updated to v3.1.31** for the synthesis to work. The phone's synthesis request is silently dropped by older desktop versions. The Tags tab on the CyberClaw repo has v3.1.31 — install the matching update for the desktop.