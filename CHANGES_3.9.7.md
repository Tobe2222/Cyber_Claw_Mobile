# v3.9.7 — Voice mode: longer silence, exit-phrase reliability, your-turn cue sound

Tobe (in #cyber-dev, ~18:24 after v3.9.6): "the conversation
went better. But for some reason it exited voice mode a
couple of times. And we should have longer silence
detection. Or a way to detect drawn out words due to
thinking. [...] Also. We need a sound for when Its the
users time to talk. Get some elegant sounds."

Three things in this release:

1. Voice mode exit-phrase false-positive fix
2. Longer silence detection defaults + drawn-out-word tolerance
3. Your-turn cue sound (system-wide, 4 bundled sounds)

## 1. Exit-phrase false positives

Tobe reported voice mode closing on its own a couple
times during conversation without him saying the
configured exit word. Suspected cause: the v3.9.4
recorder-path exit detector uses `HIGH_SCORE_RUN = 3`
(240ms confirmation) — same as the wake detector, which
is too aggressive for a 1-syllable common word like
"thanks" that appears all the time in natural speech.

`android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:

Bumped the recorder-path exit detector's
`EXIT_HIGH_SCORE_RUN` from 3 to 5 (400ms confirmation).
OWW-side wake detector stays at 3 (short + distinct
word; 240ms is fine). Exit-phrase detection is
specifically the recorder path now since the OWW thread
is paused during recording (v3.9.4 architecture).

Why not bump the threshold instead? Threshold controls
sensitivity (how strong the score must be), confirmation
window controls durability (how long the score must
persist). False positives on common speech phrases are
a durability problem (single-frame detector spikes on
phonemes that happen to match), not a sensitivity
problem. 400ms confirmation is well within natural
perception but absorbs single-frame spikes.

## 2. Longer silence + drawn-out-word tolerance

`src/services/VoiceSettings.ts`:
- `DEFAULT_SILENCE_MS` 5000 → 6000
- `MIN_SILENCE_MS` 2000 → 3000
- `MAX_SILENCE_MS` 10000 → 15000

`src/screens/WakeModeScreen.tsx`:
- JS-side countdown `let count = 3` → `let count = 5`

Total "user goes silent → audio sent" window:
- Default: 6s silence + 5s countdown = **11s** (was 5+3=8s)
- Aggressive (MIN): 3s silence + 5s countdown = **8s** (was 5s)
- Relaxed (MAX): 15s silence + 5s countdown = **20s**

For drawn-out-word / mid-thought hesitation: the
existing v3.9.5 hysteresis already handles this. When
the user says "uumm..." or "errr..." the audio stays in
the hysteresis band (RMS 0.008-0.015) which is a no-op
in the silence detector — the timer doesn't accumulate.
So users who hold a vowel can think out loud as long as
they want without being cut off.

What changed in this release: longer *true* silence
tolerance (when the user actually stops making sound).
The "I'm thinking" case is already covered by v3.9.5's
hysteresis band, no change needed there.

## 3. Your-turn cue sound

Tobe: "We need a sound for when Its the users time to
talk. Get some elegant sounds. Some bird tweets or
simple sounds like messages etc."

### Sound assets

Four synthesized sounds bundled at
`android/app/src/main/assets/sounds/`. Synthesized from
sine waves at build time (Python + `wave` module):
- `turn-bird.wav` — rising 3-note chirp with FM
  warble, 0.5s
- `turn-bell.wav` — soft two-tone bell (E5 + B5 with
  inharmonic partials + exponential decay), 1.0s
- `turn-ding.wav` — single gentle A5 ding, 0.8s
- `turn-chime.wav` — C5-E5-G5 arpeggio chime, 0.9s

All mono, 44.1kHz, 16-bit. Total bundle size: ~270KB
uncompressed WAV. Could compress to MP3/OGG later if
APK size becomes a concern.

### Why synthesized instead of CC0 downloads?

- Zero external assets, zero license questions
- Trivially tweakable (frequency/duration in Python
  source)
- No per-platform asset management

If Tobe wants real recordings later, the bundle can be
swapped — the asset filenames and the JS-side lookups
don't change.

### Wiring

`src/services/VoiceSettings.ts`:
- `TURN_CUE_KEY = 'cyberclaw-voice-turn-cue'`
- `DEFAULT_TURN_CUE = 'off'` (conservative — preserves
  existing behavior for users on older builds)
- `TURN_CUE_OPTIONS = ['off', 'bird', 'bell', 'ding',
  'chime']`

`src/screens/SettingsScreen.tsx`:
- New "🔔 Your-turn cue sound" subsection under the
  voice settings
- OptionBtn row for the 5 options
- Setting persists immediately to AsyncStorage

`src/screens/WakeModeScreen.tsx`:
- In `afterPlayback` (called when desktop response
  audio finishes): read the cue preference, play the
  corresponding asset via the existing
  `WakeWordModule.startPlayer` path with
  `file:///android_asset/sounds/turn-{cue}.wav`
- Idempotency guard (`afterPlaybackFired` flag) — the
  cue sound's `audioPlayerFinished` event would
  otherwise re-trigger `afterPlayback` and start a
  second recording window

### Known limitation

The audioPlayerFinished listener is still registered
without cleanup, so listeners accumulate across turns.
Mitigated by the idempotency flag for v3.9.7. Proper
listener cleanup (capture subscription + remove on
effect teardown) is a follow-up for v3.9.8.

## Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (exit-phrase HIGH_SCORE_RUN bump)
- `src/services/VoiceSettings.ts` (silence defaults + TURN_CUE_KEY)
- `src/screens/WakeModeScreen.tsx` (countdown bump + turn
  cue playback + idempotency guard)
- `src/screens/SettingsScreen.tsx` (turn cue UI +
  updateVoiceTurnCue)
- `android/app/src/main/assets/sounds/turn-{bird,bell,ding,chime}.wav`
  (new asset bundle)
- `package.json` (3.9.6 → 3.9.7)

## Verification

`./gradlew :app:compileDebugKotlin --offline` ✅
`npx tsc --noEmit` ✅ (only pre-existing
HomeScreen.tsx:2666 error, unrelated)

## Test plan after install

1. Open Settings → voice area → "🔔 Your-turn cue
   sound" → pick "Bird" → back out.
2. Open voice mode. Have a 2-turn conversation. Listen
   for the bird chirp after each desktop response.
3. Switch through the 5 options and confirm each plays
   correctly.
4. Switch to "Off" and confirm no sound plays.
5. In a normal conversation, observe: silence timer is
   noticeably more tolerant (default 6s + 5s countdown
   = 11s before send).
6. Say "thanks" mid-conversation — voice mode should
   close (exit phrase works as before).
7. Have a 3-turn conversation without saying "thanks"
   — voice mode should stay open (exit-phrase
   false-positive fix).

## Companion release

Nothing desktop-side.
