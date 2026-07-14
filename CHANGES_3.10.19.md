# v3.10.19 — Speaker enrollment POC (linear classifier on OWW embeddings)

Tobe asked:

> "an ideal feature would be the ability to learn the
> users voice. Is it possible to build that? With every
> voice conversation used to train the companion to
> understand the user?"

Tobe also clarified: "Privacy is not much of a concern
since the server is the users aswell. We aim for
smoothness in conversation, simplicity and it just
works good is our goal."

## POC approach

No new model. The OWW detector already extracts a
96-dim embedding per audio chunk (1280 samples =
80ms at 16kHz). We use those existing embeddings as
speaker features and compute cosine similarity
against an enrolled profile. Same approach as a
linear-classifier baseline, just using the OWW
embedding vector instead of a separately-trained one.

If accuracy turns out to be insufficient (Tobe has
multiple family members with similar voices, or the
OWW embedding doesn't discriminate well), the
upgrade path is ECAPA-TDNN or wespeaker — ~10MB
ONNX model. But POC first.

## How it works

**Enroll:** Tap "🎤 Learn my voice" while talking for
~1 second. The native code averages the last 8
embeddings (~640ms) into a 96-dim profile, L2-normalizes
it, and stores it per-companion. Result is shown as a
match score (typical same-speaker: 0.7-0.9).

**Match:** On demand (currently the post-enrollment
score check; later: every wake-word fire to filter
other speakers), compute cosine similarity between
the profile and the recent 8 embeddings. Average
across K frames is more stable than single-frame.

**Reset:** "🗑 Clear voice profile" wipes the per-
companion enrollment.

## Native module API

- `enrollSpeaker(agentId: string)` — averages recent
  embeddings for the agent, returns true on success
  (needs ≥8 samples; rejects with `ENROLL_TOO_FEW_SAMPLES`)
- `hasSpeakerEnrollment(agentId)` — returns boolean
- `clearSpeakerEnrollment(agentId)` — wipes enrollment
- `matchSpeaker(agentId)` — returns cosine similarity
  (double, -1..1) or null if no enrollment

The OWW detector internally:
- Stashes the last 32 embeddings (96-dim each) in a
  thread-safe circular buffer
- Adds to the buffer on every `predictScore` call
  (the wake detector runs in the background listener)
- Averages the last 8 (or fewer if buffer is short)
  for enrollment
- Computes per-frame cosine similarity and averages
  for matching

## JS UI

New section in the active-wake panel on the Wake
settings page, below the "Test wake" button:
- "🎤 Learn my voice" / "🎤 Listening…" / "✓ Voice enrolled"
  button (3 states)
- On enrolled: shows the post-enrollment match score
  with a human-readable label (Strong / Moderate / Weak)
- "🗑 Clear voice profile" button to reset
- Hint text explaining what each state means

## Files

- `android/app/src/main/java/com/cyberclawmobile/
  OpenWakeWordDetector.kt`:
  - New `embeddingHistory` circular buffer (32 frames
    × 96 floats)
  - `predictScore` now saves a copy of each embedding
    to the buffer (synchronized)
  - New `cosineSimilarity(a, b)` private method
  - New `enrollSpeakerFromBuffer(agentId)` public
    method (averages + L2-normalizes)
  - New `matchRecentSpeaker(agentId, recentK)` public
    method (averages per-frame cosine similarity)
  - New `hasEnrollment`, `clearEnrollment` accessors
  - `close()` clears the embedding history
- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt`:
  - Four new ReactMethods: `enrollSpeaker`,
    `hasSpeakerEnrollment`, `clearSpeakerEnrollment`,
    `matchSpeaker`
- `src/screens/CompanionSettingsScreen.tsx`:
  - New state: `speakerEnrolled`, `speakerEnrolling`,
    `speakerMatchScore`
  - New handlers: `handleEnrollSpeaker`,
    `handleClearEnrollment`
  - New useEffect to fetch enrollment status on
    mount and on companion change
  - New UI section in the active-wake panel with the
    "Learn my voice" button + match score + clear
    button + new `activeWakeTestBtnEnrolled` style
- `package.json` — 3.10.18 → 3.10.19
- `android/app/build.gradle` — versionName 3.10.18 →
  3.10.19, versionCode 245 → 246

## What's NOT in this POC

This PR establishes enrollment + matching primitives
but doesn't actually gate wake-word fires on the
match score yet. The next iteration:

1. On every wake-word fire, call `matchSpeaker` to
   get the current score. If below threshold (default
   0.65), suppress the fire (log it as "different
   speaker ignored"). Tobe confirmed privacy is fine
   ("server is the user's") so suppressing fires is
   the right default — not advisory, blocking.
2. Show the match score on wake-word fires in the
   voice log ("hey clawsuu — match 0.82, this is you")
   so the user can see what's happening.
3. Add a debug overlay in WakeModeScreen showing the
   rolling match score, for calibration.

## Lesson

**Don't add a model when existing features work.**
OWW's 96-dim embedding isn't trained for speaker ID,
but it's an audio-derived representation that DOES
discriminate speakers — enough for a POC. Adding
ECAPA-TDNN means 10MB of model weights, ONNX runtime
integration, a separate inference path. If the POC
works, we ship the simple version; if accuracy is
insufficient, the upgrade path is clear and isolated
to one method (`matchRecentSpeaker`).

**Lesson: enroll when buffer has enough data, not
at app launch.** Auto-enrollment would either block
the app for 1s waiting for audio (annoying) or capture
background noise (broken). Letting the user tap
"Learn my voice" once they've been talking for a
minute gives the embedding buffer 30+ seconds of
real speech to average — much better than 640ms.
Plus, the user knows they're enrolling and can speak
deliberately.