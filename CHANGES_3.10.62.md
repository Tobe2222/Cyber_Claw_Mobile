# v3.10.62 — Active enrollment UI: lock the speaker profile in 30 seconds

Tobe (post v3.10.61):

> "a user friendly companion app with a focus on
> voice coms. a smooth conversation cycle and a
> companion(technically the app in this case) that
> learns your voice so the user commands it.
> continue with the next step"

This is the fourth of five improvements toward a
"personalized wake" architecture. v3.10.62 ships
the user-facing piece: a "Train my voice" button
that locks the speaker profile in 30 seconds instead
of waiting for natural accumulation (~30s of voice
activity in BG listening).

## What changed

### 1. `OpenWakeWordDetector` — `forceLockProfile(minSamples)`

New method that bypasses the natural lock thresholds
(`PROFILE_LOCK_SAMPLES = 1000`, `PROFILE_LOCK_WAKE_FIRES`)
and immediately locks the profile if at least
`minSamples` (default 50) voice-active samples have
accumulated. Used by the active-enrollment UI when
the user explicitly records 30s of voice and wants
the profile locked without further delay.

If fewer than `minSamples` were accumulated during
the recording (e.g. the user spoke too quietly or
the room was too noisy), `forceLockProfile` returns
false and the profile stays unlocked. The caller
can show a clear "try again in a quieter room"
message.

### 2. `EnrollmentAudioProcessor` — `forceLockProfile(minSamples)`

Delegates to the detector. Adds the same lock API
at the singleton level so `WakeWordModule` doesn't
need direct access to the detector.

### 3. `WakeWordModule` — three new ReactMethods

- `startActiveEnrollment(durationMs)` — starts a
  dedicated `AudioRecord` that pushes every 1280-
  sample PCM chunk into `EnrollmentAudioProcessor`.
  Auto-stops after `durationMs` (default 30s,
  clamped to 5s-120s). Returns `true` on success.
- `stopActiveEnrollment()` — stops early. Safe to
  call even when nothing is running.
- `isActiveEnrollmentRunning()` — synchronous check.
- `forceLockSpeakerProfile()` — delegates to
  `EnrollmentAudioProcessor.forceLockProfile(50)`.
  Returns `true` on success; rejects with
  `TOO_FEW_SAMPLES` if fewer than 50 voice-active
  samples were accumulated (the JS layer shows this
  as a friendly alert).

### 4. `getSpeakerStatus` rewritten

The previous version queried `owwDetector` (the
foreground WakeWordModule-owned detector) for the
profile state. v3.10.62 changes it to query
`EnrollmentAudioProcessor` instead — the singleton
that both BG paths and the foreground test path
share. So the status panel on the active-enrollment
UI now reflects the actual profile that the BG
service is using.

### 5. New `ActiveEnrollmentPanel.tsx` component

A self-contained card with:
- Status row showing profile state (none / unlocked
  / locked) + live sample count + live match score
  (color-coded: green ≥50%, orange <50%)
- Big "🎤 Train voice (30s)" button → starts a
  30-second active enrollment
- Live progress bar + countdown during recording
- A pangram paragraph the user reads aloud (gives
  the embedding model diverse phonemes — varied
  consonants, vowels, trickier words)
- "Lock profile (N samples)" button after recording
  completes (requires ≥50 samples)
- "✓ Profile locked! Match score: 87%" success
  banner
- "Re-train voice" button to do another session
- "Clear profile" button to reset and start over

The panel auto-stops at 30s, so the user can just
walk away after reading the paragraph.

### 6. Wired into `CompanionSettingsScreen`

Added `<ActiveEnrollmentPanel />` between the wake
test button and the wake phrases list. Active for
all companions — enrollment is device-wide (one
user, one device).

## How the user experiences it

1. Open Companion Settings → tap a companion → Wake
2. See the new "🎙️ Voice enrollment" card
3. Tap the big "Train voice (30s)" button
4. A 30-second countdown starts; the paragraph is
   shown on screen
5. User reads the paragraph aloud naturally
6. After 30s, recording auto-stops
7. User taps "✓ Lock profile (N samples)"
8. ✓ Banner shows "Profile locked! Match score: 87%"
9. From now on, the speaker gate is active — other
   voices saying "hey clawsuu" are rejected

If the user just keeps using the app normally
(opens voice mode, lets BG listening accumulate),
the profile still auto-locks via the v3.10.23
passive path. The button is the FAST path.

## Files changed

- **New** `src/components/ActiveEnrollmentPanel.tsx`
  (~360 lines)
- `src/screens/CompanionSettingsScreen.tsx`:
  - Import `ActiveEnrollmentPanel`
  - Render `<ActiveEnrollmentPanel />` after the
    wake test panel
- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt`:
  - New `forceLockProfile(minSamples = 50)`
- `android/app/src/main/java/com/cyberclawmobile/EnrollmentAudioProcessor.kt`:
  - New `forceLockProfile(minSamples = 50)`
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:
  - New ReactMethods: `startActiveEnrollment`,
    `stopActiveEnrollment`, `isActiveEnrollmentRunning`,
    `forceLockSpeakerProfile`
  - `getSpeakerStatus` rewritten to query
    `EnrollmentAudioProcessor`
- `android/app/build.gradle`: versionCode 288→289,
  versionName 3.10.61→3.10.62
- `package.json`: version 3.10.61→3.10.62

## Roadmap (next version)

- **v3.10.63** — Continuous learning + adaptive
  threshold. Every confirmed wake updates the
  profile with the recent embedding, so the model
  keeps adapting to gradual voice changes (cold,
  sore throat, ambient noise drift). Also a
  "strict mode" toggle that drops Vosk once the
  profile locks (battery saver).

## Verification on device

Install v3.10.62, open Companion Settings → tap a
companion → Wake. You should see the new
"🎙️ Voice enrollment" card.

**Test path A (fast, recommended):**
1. Tap "Train voice (30s)"
2. Read the paragraph shown on screen for 30
   seconds. Use a normal pace and volume; quiet
   rooms work best
3. After 30s, recording auto-stops
4. Tap "Lock profile (N samples)" — N should be
   100-500 depending on how much of the 30s you
   were actually speaking
5. ✓ Banner shows match score. 60%+ is good.

**Test path B (passive, default):**
1. Just keep using the app normally
2. After ~30s of total voice activity (across BG
   listening, voice mode, anywhere with voice),
   the profile auto-locks
3. The status panel updates to "🔒 locked"

**Test the gate:**
1. After lock, have someone else say "hey clawsuu"
2. Should NOT open voice mode (speaker gate rejects)
3. Logcat shows "BG OWW wake suppressed by speaker
   gate" or "Vosk wake suppressed by speaker gate"

## Lesson

The v3.10.23 design removed the speaker enrollment
UI because "the gate is invisible to the user; only
the 'did wake fire for me?' outcome differs". That
was right for a passive-only flow, but it left
users with no way to actively teach the app — they
had to wait for natural accumulation. v3.10.62
restores the UI as an explicit fast-path alongside
the passive slow-path. Both paths coexist:

- **Passive (v3.10.23):** profile grows from
  whatever voice activity you have, auto-locks
  at 1000 samples
- **Active (v3.10.62):** dedicated 30s session,
  force-locks at 50 samples

This is the "fast + slow path coexist" pattern —
useful whenever a system has a long-tail learning
mechanism that can be jump-started by an explicit
user action.