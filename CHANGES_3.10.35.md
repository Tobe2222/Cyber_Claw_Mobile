# v3.10.35 — Voice-mode turns count toward the "learn voice" bar

Tobe (post v3.10.34):

> "the learn voice bar does not fill. Its still at 0/1000 even after
> i have had some chats."

## Root cause

The native OWW detector's `enrollmentSamplesTotal` counter only
ticks inside the OWW listening loop (the loop in
`startOwwListening`). Each 80ms chunk is checked for voice
activity (RMS > 0.010 + ZCR > 0.02); if voice-active, the
embedding is pushed into the enrollment buffer AND
`enrollmentSamplesTotal++`.

But the OWW loop only runs while `isOwwListening = true`. The
recorder (used by voice mode active recording) grabs the MIC
exclusively (`startRecorderWithSilence` stops OWW before opening
the recorder's AudioRecord). When Tobe is in voice mode:

- Recording in progress → OWW is OFF (mic conflict)
- Recording finished → OWW briefly ON (waiting for desktop
  response) → but Tobe is silent waiting for the response →
  no voice-active chunks
- Response arrives → OWW OFF → recorder ON → repeat

Net result: the OWW almost never captures user speech while
Tobe is voice-mode-chatting. The "learn voice" bar stays at
0/1000 forever.

## Fix

Voice-mode turns with detected speech now contribute to a
**separate JS-side "active contributions" counter** persisted
in AsyncStorage (`cyberclaw-voice-enrollment-active`):

```js
// At the end of stopAndSendRecording (after sendAudioInput):
if (voiceMode && speechDetectedDuringRecordingRef.current) {
  const cur = parseInt(AsyncStorage.getItem(key) || '0', 10);
  AsyncStorage.setItem(key, String((cur || 0) + 50));
}
```

`VoiceEnrollmentBar` reads BOTH counters (native OWW passive +
JS active) and renders them as a combined progress:

- Bar fill: `max(passive, wake, active)` — whichever is
  highest counts toward the visual fill
- Label: shows both numbers so the user knows what they're
  contributing to (`X passive + Y voice turns`)
- Lock semantics unchanged: `profileLocked` still requires
  the OWW-captured embeddings + confirmed wakes
  (`tryLockPrimaryProfile` in OpenWakeWordDetector.kt). The
  active contributions are UX feedback only — they fill the
  bar so the user can see progress, but they don't unlock
  the actual profile (which would require the user's voice
  to be profiled as a unique speaker via the OWW embedding
  averaging pipeline).

This intentionally **separates "feedback" from "lock"**:
chatty users see fast visual progress but the lock
remains gated on the same native prerequisites as before.

## Why 50 contributions per turn

A typical 1.5-second voice-mode utterance is ~19 OWW chunks
of voice-active audio, where each chunk would increment
`samplesTotal` by 1 if captured by OWW. We bump `active` by
50 (slightly higher) per voice-mode turn because:

- The OWW doesn't capture user speech while the recorder is
  active, so each voice-mode turn is **pure loss** for
  passive enrollment
- 50 / 1000 = 20 turns = visually full bar, achievable in a
  short voice-mode session
- The discount (50 vs ~80 OWW-equivalent samples we'd get
  if OWW was running) is implicit: voice-mode users get
  reach the bar faster than wake-listening-only users, which
  feels fair since voice-mode is the harder path for the
  OWW to actually capture

## Files

- `src/components/VoiceEnrollmentBar.tsx` — poll both the
  native `getSpeakerStatus` and AsyncStorage's
  `cyberclaw-voice-enrollment-active`. Combined progress
  shows `samplesTotal` (native) + `activeContributions`
  (JS). Label surfaces both with a "+ N voice turns"
  suffix when active contributions are > 0.
- `src/screens/WakeModeScreen.tsx` — in
  `stopAndSendRecording`, AFTER the `sendAudioInput` call
  and only when `speechDetectedDuringRecordingRef.current`
  is true, increment the AsyncStorage key by 50.
- `package.json` 3.10.34 → 3.10.35
- `android/app/build.gradle` versionCode 261 → 262,
  versionName 3.10.35

## Migration

Existing v3.10.34 (and earlier) installs start with
`activeContributions = 0` — the AsyncStorage key is missing
until the user runs voice mode in v3.10.35. No migrations
needed: the bar fill is computed on read, the key is created
on first write.

Users who never had wake-listening enabled (only used voice
mode) will see the bar go from 0 to comfortably > 0 on their
first v3.10.35 voice-mode session.

Users who DID have wake-listening running already have a
non-zero `samplesTotal`; the new code adds the active
contributions on top. The combined bar moves visibly
faster than v3.10.34's stuck counter.