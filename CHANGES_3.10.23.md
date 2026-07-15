# v3.10.23 — global passive speaker profile (single voice, no UI)

**TL;DR:** speaker enrollment is now a single global user-voice
profile. The OWW detector learns it passively from the user's
voice-active audio, gates wake detection on speaker match, and
persists across restarts. No button, no progress bar, no per-
companion settings.

## Why this exists

v3.10.19 introduced speaker enrollment as a per-companion opt-in
("Learn my voice" button inside CompanionSettingsScreen). v3.10.21
turned that into a passive accumulator with a progress bar — but
still keyed per-companion. Tobe's v3.10.23 direction: "lift it out
entirely. Analyze the user's turn in each conversation in voice
mode. Learn the user voice through that. This learning should help
all voice features independent of companions. No button. Empower
wake, exit, send and transcription."

The v3.10.21 shape was wrong:
- per-companion (the user's voice doesn't change between
  companions)
- opt-in (the user has to remember to tap a button)
- UI surfaced in settings (the user has to dig through screens
  to see what's happening)
- scope: only the wake word path consumed the score

v3.10.23 fixes all four.

## What's new

### Native (Kotlin) — OpenWakeWordDetector.kt

- **Replaced** `enrollments: HashMap<String, FloatArray>` (per-
  companion) with `primaryProfile: FloatArray?` (single global).
- **Added** auto-lock: when either (a) `enrollmentSamplesTotal
  >= 1000` OR (b) `confirmedWakeFires >= 5`, the profile is
  locked + persisted to SharedPreferences. After lock, the
  wake gate activates.
- **Added** `confirmedWakeFires` counter — only incremented
  when a wake-fire was preceded by a voice-active embedding
  within the same chunk cycle. This is the alternative auto-
  lock trigger (so a power user doesn't have to wait for 1000
  background samples; 5 confirmed wake-fires from real voice
  is also enough).
- **Added** wake-suppression gate. `shouldSuppressWakeForSpeaker()`
  returns `true` iff the primary profile is locked AND the
  recent audio's cosine match < 0.5. Wake detection WITHOUT a
  locked profile is unchanged (the system has to work BEFORE
  it can learn).
- **Added** `persistPrimaryProfile()` / `loadPersistedPrimaryProfile()`
  — round-trip a 96-float vector as base64 in SharedPreferences.
  Cold-start restores the profile so the user doesn't have to
  re-teach the app on every restart.
- **Added** `getPrimaryProfileBase64()` / `setPrimaryProfileBase64()`
  — debug + future desktop-side use.
- **Added** `recomputePrimaryProfileIfReady()` — returns
  `Pair(updated, justLocked>`; the second flag lets the wake
  module log the lock transition exactly once.
- **Removed** `enrollments` HashMap, `enrollmentSamplesByAgent`
  HashMap, all per-companion enrollment methods.

### Native (Kotlin) — WakeWordModule.kt

- All `enrollSpeaker(agentId)` / `matchSpeaker(agentId)` /
  `hasSpeakerEnrollment(agentId)` / `clearSpeakerEnrollment(agentId)`
  / `getSpeakerStatus(agentId)` / `recomputeEnrollment(agentId)`
  ReactMethods now take **no** arguments — single global profile.
- **Added** `loadPersistedSpeakerProfile` — JS calls this once
  on app boot to restore the profile. Emits `speakerProfileLoaded`
  event on success.
- **Added** `getSpeakerProfileBytes` — debug / future use.
- **Renamed** `recomputeEnrollment` → `recomputeSpeakerProfile`.
  Returns `{updated, justLocked}` instead of a single bool.
- **Added** `speakerProfileLocked` event emission — fires once
  when the profile first locks in this session.
- **Modified** the wake-fire path: after the existing wake
  threshold + cooldown checks, calls
  `shouldSuppressWakeForSpeaker()`. If true, the wake event
  is suppressed entirely (highScoreFrames reset, chunkFill
  reset, continue). If the recent audio was voice-active,
  `noteConfirmedWakeFire()` is called to bump the auto-lock
  counter (only for "real" wakes, not stray TV).

### JS / UI

- **Stripped** CompanionSettingsScreen of all speaker UI:
  - state: `speakerEnrolled`, `speakerEnrolling`,
    `speakerMatchScore`, `speakerSamplesTotal`,
    `speakerBufferSize`, `SPEAKER_MATURE_SAMPLES`
  - callbacks: `handleEnrollSpeaker`, `handleClearEnrollment`,
    the 5s poll useEffect, the `hasSpeakerEnrollment` useEffect
  - JSX: the "Learn my voice" button, the progress bar,
    the "Voice learned" panel, the match score card
  - styles: `passiveLearning*`, `activeWakeTestBtnEnrolled`
- **Removed** `addLogEntry` import from CompanionSettingsScreen
  (only the speaker callbacks used it; the v3.10.22 fix is
  preserved as a comment for the long-term LogStore refactor).
- **Added** App.tsx boot effect: calls
  `WakeWordModule.loadPersistedSpeakerProfile()` once on mount
  (1.5s delay so initOww has a chance to run first). Logs the
  restore if successful. The gate activates automatically for
  any wake fires after that.

## What's NOT in v3.10.23 (intentional scope)

- **Exit + send speaker-gating.** The exit and send paths
  today are ML binary-classifier scores; gating them on
  speaker match requires ANDing the score with the speaker
  match — straightforward but separate behavior. Deferred to
  v3.10.24 so this release can ship and be tested in isolation.
- **EMA drift.** Once locked, the profile is static. As the
  user's voice drifts (colds, age, mic change) over weeks/
  months, the match score may drop. v3.10.24 will add EMA
  drift — only on samples WITH a confirmed wake-fire +
  matched audio (avoiding the "learn a guest" failure mode).
- **Transcription personalization.** Transcription in the app
  is done by the desktop (Vosk) on the streamed audio. To
  personalize, the desktop would need the profile (via WS
  message) and the ASR would need to apply per-speaker
  biasing. Desktop-side work. Deferred to v3.11+.
- **UI for inspecting the profile.** Tobe said "lift it out
  entirely" — so v3.10.23 has zero UI surface for the speaker
  profile. A debug-only "Voice profile: locked (1247 samples)"
  status line in global Voice mode settings could be added
  later if needed; not in v3.10.23.

## Migration from v3.10.22

- v3.10.22 stored per-companion enrollment profiles in
  SharedPreferences with a different key prefix. v3.10.23
  uses `speaker_profile_v1` as the SharedPreferences name
  with a single `***` key. Old per-agent profiles are
  simply orphaned — they take ~1KB of disk each and don't
  conflict with the new shape. A future cleanup could
  enumerate the old keys and delete them; not urgent.
- Behavior change for users who DID tap "Learn my voice" in
  v3.10.22: their per-companion profile is gone in
  v3.10.23. The new passive global profile starts fresh
  and will lock after either 1000 voice-active samples
  (~30s of speech) or 5 confirmed wake-fires (whichever
  first).

## Lessons / rules codified

1. **The user's voice is one thing.** Never key the speaker
   profile by anything but user identity. v3.10.19/v3.10.21
   keyed by `agentId` — wrong because the same user talking
   to two companions shouldn't produce two profiles.
2. **Voice learning has to be invisible to ship.** Any
   feature that requires opt-in (a button) is opt-out for
   most users. Passive + global is the only way to actually
   get the training data flowing.
3. **Gate on, gate early.** Speaker matching should suppress
   bad wake fires, not just adjust a score. v3.10.23
   suppresses the wake event entirely (other speakers in
   the room won't open voice mode). A weaker "down-weight
   the score" approach was considered but rejected — too
   forgiving of false wakes.
4. **Restore on cold start or it's not a real feature.**
   Without SharedPreferences persistence, the user would
   have to re-teach the app every cold start (1-3 minutes
   per day). The v3.10.21 shape didn't bother persisting;
   v3.10.23 does.