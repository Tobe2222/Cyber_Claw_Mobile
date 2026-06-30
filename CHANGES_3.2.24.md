# 3.2.24 — Better status text, deduped voice log, trainable exit phrase is v3.2.25

## Reported by Tobe

After v3.2.23 (Alexa-style wait-for-speech), Tobe
reported:

1. **"Responding..." badge shown when it was actually
   the user's turn.** The status text was supposed to say
   "🎧 Listening..." during the user's turn, but it was
   stuck on "Responding..." because `voiceStatus` never
   reset between turns.

2. **Voice log filled with duplicate messages.** The
   multi-turn loop re-emitted the same chat messages on
   every turn, so the log showed 5x copies of the same
   joke. The user couldn't see new messages because the
   log was full of duplicates.

3. **Wanted: trained exit phrase** that is always listened
   for during voice mode and minimizes the app when
   triggered. (See "What about the trainable exit
   phrase?" below.)

## v3.2.24 fix

### Status text: YOUR TURN (green), Recording (red), Responding (orange)

- New `voiceStatusYourTurn` style: green (#10b981),
  28px, bold. Shown when `voiceStatus === 'listening'`
  in voice mode. The text reads **"🎤 YOUR TURN"** —
  impossible to miss.
- New `voiceStatusRecording` style: red (#ef4444), 22px,
  shown when user is actively being recorded.
- New `voiceStatusResponding` style: amber (#fbbf24),
  16px, shown when the AI is talking.

The previous version had a single orange status text
that stayed on "Responding..." even when the user had
moved on.

### Status reset between turns

- `afterPlayback` in `onAudioResponse` now explicitly
  calls `setVoiceStatus('listening')` before kicking off
  the next recording turn. Previously the 'responding'
  status from `onChat` persisted, showing the wrong
  text for the entire following turn.

### Voice log dedup

- `addVoiceLog` now drops an entry if it duplicates the
  previous one. So 5 broadcasts of the same joke show
  as one entry in the log.
- Cap raised from 5 to 6 entries so the overlay
  doesn't overflow on small phones.

## What about the trainable exit phrase?

Tobe asked for an exit phrase that "is always listened
for during voice mode. If triggered it minimizes the
app."

The implementation requires either:

- **A desktop-trained OWW model** for the exit phrase
  (same shape as wake-word training: 6 samples →
  desktop trains → TFLite model → OWW detector fires
  during voice mode). This is the "trained like wake"
  approach Tobe asked about in v3.2.20. Complex but
  accurate. Matches wake-word accuracy.

- **A local audio-stream DTW detector** (run the
  AudioSampleMatcher against live audio frames during
  recording). Fast, no desktop round-trip. Requires
  exposing audio frames from the native recorder —
  the current `SimpleAudioRecorder` only emits
  amplitude, not raw frames. Reasonable middle ground.

- **A text-fallback matcher on the transcription**
  (v3.2.17-20 pattern, one phrase, fuzzy substring).
  Already implemented, but slow (waits for STT) and
  breaks if the desktop pipeline stalls.

Deferring the trainable flow to v3.2.25 because the
audio-frame API change is a 1-2 day wiring job and I
want to land the smaller fixes cleanly first. Tobe
confirmed in the v3.2.20 discussion that this was a
stretch goal; the smaller status-log fix is what
ships in v3.2.24.

## Files

- `src/screens/WakeModeScreen.tsx` — voice status
  overlay reads from new state-aware style array;
  status text per state shows YOUR TURN / Recording /
  Responding. AfterPlayback resets voiceStatus.
  addVoiceLog dedupes consecutive identical entries.
- `package.json` 3.2.23 → 3.2.24
- `android/app/build.gradle` versionCode 169 → 170,
  versionName 3.2.23 → 3.2.24
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.24

## Lessons

- **Reset state on each transition, don't rely on
  reconstruction.** The voiceStatus stayed on
  'responding' across turns because no code path
  explicitly reset it. The fix is `setVoiceStatus(...)`
  at every state-change boundary. Implicit state
  inheritance looks harmless; in multi-step flows it's
  a source of "stale label" bugs.
- **Dedupe is a presentation, not data, problem.**
  The log was keeping every message; the user wanted
  only the last distinct one. Same data, different
  presentation. The fix is in the render path
  (`addVoiceLog` filter), not in the data model.
- **"Trained like wake" is a sentence about a UI flow,
  not a 30-minute fix.** The complexity is in the
  audio-frame API change + the detector wiring on
  the live stream. When Tobe asks for a feature like
  this, scope it carefully and ship the surrounding
  improvements as a separate version.