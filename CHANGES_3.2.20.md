# 3.2.20 — Transcribing timeout + simplified exit phrase UI

## Reported by Tobe

After v3.2.19 (greeting restored), Tobe reported:

1. **Voice mode got stuck on "Transcribing..."** — audio was
   sent (`Sent, waiting...` in the log) but the desktop never
   responded. The mobile stayed on the transcribing state
   indefinitely, requiring a force-close.
2. **Settings had too many exit-phrase fields** — 6 preset
   toggles + a custom-phrase input. Tobe wants ONE phrase.
3. **Exit phrase should be trainable** — like the wake word.

## Root cause of the transcribing-stuck bug

The mobile's `startRecordingTurn` calls
`syncClient.sendAudioInput(base64, 'audio/m4a')` and sets the
status to `transcribing`. It waits for the desktop's
`chat` / `audio_response` events to come back. If the
desktop pipeline stalls (network blip, STT hang, LLM
timeout), the events never arrive and the mobile waits
forever.

There's no built-in recovery from this state. The user
sees "Transcribing..." with no progress indication, no
timeout, no way to recover without force-closing the app.

## v3.2.20 fixes

### Transcribing timeout (30s)

- New `transcribingTimeoutRef` in WakeModeScreen. Set when
  audio is sent (alongside `setVoiceStatus('transcribing')`).
- Cleared when a `chat` or `audio_response` event arrives
  from the desktop (the pipeline is alive).
- Cleared on unmount (no stale timers after exit).
- On timeout: log "⏰ Transcribing timeout (30s) — no
  response from desktop", reset `wakeWordBusyRef`, and in
  voice mode start a new recording turn. The user can keep
  talking. The desktop pipeline can recover in the
  background; the mobile keeps the loop alive.

### Simplified exit phrase UI

- Replaced the 6 preset toggles + custom-phrase TextInput
  with a single TextInput (default `thanks`, max 40 chars,
  auto-saves on blur).
- Empty phrase = feature disabled.
- 1-4 words validation; longer phrases are rejected.
- The Settings UI is now actually readable.

### VoiceSettings simplified

- Dropped the `exitPhrases: string[]` field and the
  `MAX_EXIT_PHRASES` constant. Now `exitPhrase: string`.
- Storage key changed from `cyberclaw-voice-exit-phrases`
  (JSON array) to `cyberclaw-voice-exit-phrase` (single
  string). The hydrate code auto-migrates from the old
  array format if it finds one (first phrase wins).
- Added `loadExitSamples` / `saveExitSamples` /
  `clearExitSamples` helpers for the future trainable exit
  phrase (v3.2.21).

### pollForExitPhrase updated

- Now matches against a single phrase instead of an array.
- Reads the current phrase from storage on each chat event
  so a Settings change mid-poll takes effect.

## Files

- `src/services/VoiceSettings.ts` — simplified to single
  phrase, added load/save/clear helpers for future
  training
- `src/screens/WakeModeScreen.tsx` — added
  `transcribingTimeoutRef`, 30s timeout logic, unmount
  cleanup; updated `pollForExitPhrase` for single phrase
- `src/screens/SettingsScreen.tsx` — replaced toggle grid
  + custom input with single TextInput, auto-save on blur,
  old-array hydration migrated
- `package.json` 3.2.19 → 3.2.20
- `android/app/build.gradle` versionCode 165 → 166,
  versionName 3.2.19 → 3.2.20
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.20

## What about trainable exit phrase?

Tobe's third request: "This exit phrase could be trained
just like wake could it not? If so then lets do that."

Acknowledged. The infrastructure for it is now in place
(`loadExitSamples` / `saveExitSamples` in VoiceSettings).
The actual training flow + the in-audio-stream detector
will land in v3.2.21. The current v3.2.20 ships the
text-fallback matcher (fuzzy substring) which works
without any training — but is slow because it waits for
STT to finish. v3.2.21 will add the audio-stream
detector so the exit fires the moment the user says the
phrase, without waiting for the desktop to respond.

## Lessons

- **Every async send needs a timeout.** This is a
  recurring class of bug across this codebase
  (`transcribingTimeoutRef` is the third variant in this
  conversation alone, after the wake listener
  "matching but never fires" and the silence-event
  "fires but doesn't send"). Any operation that waits
  for a remote response must have a recovery path.
  Default the timeout to 30s for interactive voice, 60s
  for background tasks.
- **"Many toggles" is itself a UX failure.** The v3.2.17
  UI gave the user 6 presets + 8 custom slots and called
  it "optional exit phrases". The user couldn't decide
  which to enable and gave up. When in doubt, present
  ONE field with a sensible default and let power users
  add complexity via separate screens. The toggle grid
  was a "configuration theatre" — it looked powerful but
  hid the simpler model behind noise.
- **The exit-phrase storage key change is a quiet data
  migration.** Switching from array to string without
  preserving user data would silently reset everyone's
  exit phrases to default. Always check both the new
  AND old keys on hydrate.