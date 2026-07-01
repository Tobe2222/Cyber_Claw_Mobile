# v3.2.29

## New feature: Exit reply phrase (mirror of Wake greeting)

The companion now says a short reply when voice mode closes.
The phrase is configurable in Settings → 🎤 Wake Word →
**Exit reply** (right under the existing Wake greeting
TextInput). Same flow as the greeting: type → save →
desktop synthesizes via piper TTS → cache WAV on mobile →
play on close.

**Empty phrase = silent close.** No audio, no log spam —
the user just drops back to passive wake listening. The
default is "Goodbye!" so new users get the behavior
out of the box without touching the setting.

**Cache strategy mirrors the wake greeting:**

- One WAV per phrase, hashed, stored in
  `DocumentDirectoryPath/cyberclaw-exit-reply-<hash>.wav`.
- AsyncStorage index at
  `cyberclaw-exit-reply-cache-index` maps phrase → file.
- On close: try the cache first, fall back to local
  Android TTS (`speak()`) while a desktop synthesis
  request is in flight. Subsequent closes use the
  warmed cache.

**Wire-level changes:**

- `request_exit_reply_audio` (sibling of
  `request_greeting_audio`).
- Audio response tagged `requestId='exit_reply'`
  (sibling of `requestId='greeting'`).
- Re-emitted on a separate `exit_reply_audio` channel
  (sibling of `greeting_audio`) so the AI-reply
  playback path doesn't race with the cache write.

## Bug fix: greeting audio cache was never being written

`GreetingAudioCache.saveGreetingAudio()` existed but
nothing was listening for the `greeting_audio` event,
so the desktop's synthesized WAVs were never written
to disk. The greeting kept working because the wake
flow fell back to `speak()` (local TTS) on cache miss,
but the cache was always empty, so every cold start
re-requested the synthesis. Same fix applies to the
new exit reply.

**Fix:** register `greeting_audio` and
`exit_reply_audio` listeners in `HomeScreen.tsx`'s
top-level `useEffect` (next to the existing
`audio_response` listener). The cleanup function
also tears them down.

## Files

**New:**
- `src/services/ExitReplyAudioCache.ts` (182 lines) —
  sibling of `GreetingAudioCache.ts`, same shape,
  different keys (`cyberclaw-exit-reply-*` vs
  `cyberclaw-greeting-*`).

**Modified:**
- `src/services/SyncClient.ts` — new
  `requestExitReplyAudio()` method; `audio_response`
  handler routes `requestId='exit_reply'` to the
  `exit_reply_audio` channel (sibling of the existing
  `requestId='greeting'` route).
- `src/screens/SettingsScreen.tsx` — new
  `exitReplyPhrase` / `exitReplySavedAt` state +
  `persistExitReplyPhrase()` debounced save (mirror of
  the wake greeting). New "Exit reply" subsection
  under the existing "Wake greeting" subsection in the
  🎤 Wake Word section, with the same TextInput +
  "✅ Saved at …" hint UX.
- `src/screens/WakeModeScreen.tsx` — new
  `playExitReply()` helper. Wired into the four
  voice-mode close paths:
  1. Exit phrase match (line ~939 region).
  2. LLM gibberish response (line ~1004 region).
  3. X close button (line ~1403).
  4. (Future: any new close path that calls
     `exitRef.current()` should call `playExitReply()`
     first.)

  All four call `playExitReply().catch(() => {})`
  before the close — fire-and-forget so the audio
  plays in the background while the screen tears down.
- `src/screens/HomeScreen.tsx` — registered
  `greeting_audio` and `exit_reply_audio` listeners
  in the top-level effect that owns the other
  `syncClient.on(...)` calls. Both call the
  respective `save*Audio(phrase, base64)` and
  swallow errors. Cleanup tears them down on unmount.
- `package.json` — version bump 3.2.28 → 3.2.29.
- `android/app/build.gradle` — versionCode 174 → 175,
  versionName "3.2.28" → "3.2.29".

## Desktop side

Sibling of v3.1.91's `request_greeting_audio` handler.
`src/sync-server.js` will need a new
`case 'request_exit_reply_audio'` that calls a sibling
`_handleExitReplyAudio(ws, text)` and replies with
`audio_response` tagged `requestId='exit_reply'`.
Code can be almost copy-paste from
`_handleGreetingAudio` — only the requestId differs.

## Out of scope (deferred)

- Per-companion exit reply (the wake greeting is
  currently global; this matches the existing design).
- Multi-phrase list (the wake greeting is a single
  TextInput, not a list; this matches the existing
  design).
- The v3.1.91 pre-existing TS error at HomeScreen
  line 2524 (pre-edit number) — unrelated
  TypeScript parse warning, not caused by these
  changes.
