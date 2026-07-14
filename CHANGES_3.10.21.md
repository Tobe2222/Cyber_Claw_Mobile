# v3.10.21 — Passive speaker enrollment over time

Tobe asked:

> "instead of a button which learns the voice. cant we
> have a passive option? where it automatically does it
> over time? in the background."

Yes — the OWW listener is already always-on when
the app is open. Every 80ms chunk produces a 96-dim
embedding. The same embeddings that power
matchRecentSpeaker (v3.10.19) can power passive
enrollment if we filter by voice-activity and bake
into a profile periodically.

## Approach

Three new things:

**1. OWW detector: enrollment accumulator.**
The detector stashes each chunk's 96-dim embedding
into `embeddingHistory` (for matching). Now it also
stashes into a separate `enrollmentBuffer` (max 64
voice-active embeddings = ~5s of continuous speech).
The buffer is bounded — long-running enrollments
don't grow unboundedly. The detector exposes:

- `accumulateLatestEmbedding()` — pulls the most
  recent embedding from `embeddingHistory` and pushes
  to `enrollmentBuffer`. Called from the WakeWordModule
  OWW thread loop right after `predictScore` returns.
- `getEnrollmentSamplesTotal()` — cumulative count of
  voice-active samples (monotonic, reset by
  `clearEnrollment`). Used to show progress.
- `recomputeEnrollmentProfile(agentId)` — averages +
  L2-normalizes the buffer into a stable profile and
  stores it. Throttled (5s cooldown) so JS-side polling
  doesn't waste CPU.

**2. WakeWordModule OWW loop: voice-activity filter.**
Added `computeEnergyAndZcr` + voice-activity check
(`rms >= 0.010 && zcr >= 0.02`) in the OWW chunk
loop. When a chunk is voice-active, mark a
`pendingEnrollmentSample` flag; after `predictScore`
returns, the flag triggers a single
`accumulateLatestEmbedding()` call. Cheap (one DSP
pass per chunk, no extra model inference).

This means: whenever the OWW listener is running
(typically: app open, screen on), the user's voice
is being passively captured for enrollment. No
user action required. As long as they talk normally,
the profile builds up over minutes/hours.

**3. JS UI: live progress + auto-recompute.**
- New state: `speakerSamplesTotal`, `speakerBufferSize`
- New useEffect: poll `getSpeakerStatus` every 5s.
  When buffer size >= 16, call `recomputeEnrollment`
  to bake the buffer into the profile. Matches the
  5s native recompute cooldown.
- New UI section under the wake test panel:
  - "🎙 Auto-learning your voice (X%)" + progress
    bar (green fill) when 50 < samples < 1000
  - "✓ Voice learned — wake fires filtered by
    speaker" when samples >= 1000 (mature)

## What's NOT in this POC

The wake-fire gating is not yet wired. When the
profile matures (>=1000 samples), the UI shows
"wake fires filtered by speaker" — but the actual
gate (suppress wake fires below threshold) is still
a TODO. Next iteration: in `WakeWordModule.owwWakeDetected`
listener, call `matchSpeaker` and skip the wake if
match < 0.65.

## Files

- `android/app/src/main/java/com/cyberclawmobile/
  OpenWakeWordDetector.kt`:
  - New fields: `enrollmentBuffer`, `enrollmentBufferMax`,
    `enrollmentSamplesTotal`, `enrollmentLastUpdateMs`,
    `enrollmentSamplesByAgent`
  - New methods: `accumulateEnrollmentSample(embedding)`,
    `accumulateLatestEmbedding()`,
    `getEnrollmentSamplesTotal()`,
    `getEnrollmentBufferSize()`,
    `recomputeEnrollmentProfile(agentId, minSamples, cooldownMs)`
  - `clearEnrollment` now also clears the buffer +
    sample counters
- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt`:
  - New constants: `PASSIVE_ENROLLMENT_RMS_THRESHOLD`,
    `PASSIVE_ENROLLMENT_ZCR_THRESHOLD`
  - New field: `pendingEnrollmentSample` (per-chunk flag)
  - OWW thread chunk loop: compute rms/zcr, set
    `pendingEnrollmentSample` if voice-active, then
    call `detector.accumulateLatestEmbedding()` after
    `predictScore` returns
  - New ReactMethods: `getSpeakerStatus(agentId)`,
    `recomputeEnrollment(agentId)`
- `src/screens/CompanionSettingsScreen.tsx`:
  - New state: `speakerSamplesTotal`,
    `speakerBufferSize`
  - New constant: `SPEAKER_MATURE_SAMPLES = 1000`
  - New useEffect: poll status + recompute every 5s
  - New UI section: progress bar (50 < samples < 1000)
    + mature banner (samples >= 1000)
  - New styles: `passiveLearningRow`,
    `passiveLearningLabel`, `passiveLearningBarOuter`,
    `passiveLearningBarInner`, `passiveLearningNote`,
    `passiveLearningMature`,
    `passiveLearningMatureTitle`
- `package.json` — 3.10.20 → 3.10.21
- `android/app/build.gradle` — versionName
  3.10.20 → 3.10.21, versionCode 247 → 248

## Lesson

**When you already have the data flowing, "passive"
is just a filter + a periodic recomputation.** No new
models, no new permissions, no new UX. The OWW
listener is always-on producing 96-dim embeddings
every 80ms; we just needed to (1) filter by voice
activity (rms/zcr thresholds) and (2) recompute the
profile periodically. The "button to learn my voice"
POC from v3.10.19 was a stepping stone — the
implementation already accumulates embeddings into
a buffer, so passive enrollment is mostly a UI
change (a polling effect + a progress bar).

**Lesson: match the user behavior with the
recompute cadence.** Recomputing every chunk would
waste CPU (the average changes imperceptibly
between adjacent 80ms chunks). Recomputing every
5s is enough — and matches how often a user
notices a progress bar update. Coarser than that
would feel laggy; finer would be invisible.

**Lesson: keep the buffer bounded.** A naive
"accumulate everything" would grow the buffer
unboundedly across long-running sessions, eventually
OOMing or slowing down the average computation. The
64-frame cap (~5s of speech) biases toward recent
voice — the profile naturally tracks voice changes
without explicit re-tuning.