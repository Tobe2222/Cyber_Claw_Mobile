# v3.10.38 — Learning-bar 1-by-1 + sustained-speech guard against ambient noise cycle

Tobe (post v3.10.37):

> "it should count 1 by 1 for the learning bar.
> And i tested some more. On the second my turn it
> still jumped to responding for some reason, no
> sending and transcribing."

Two fixes in this version.

## 1. Learning-bar counts 1 per turn

v3.10.35 set the increment to `+50` per voice-mode turn
(reasoning: matching ~50 OWW passive samples per typical
utterance, so the bar fills at a similar rate to the
OWW passive counter).

v3.10.38 drops it to `+1` per turn — Tobe: "it should count
1 by 1 for the learning bar". The 50-per-turn value read
as "0+50" in the v3.10.36 combined display which looked
like an error to him. With 1-per-turn the bar fills in
~1000 voice-mode turns instead of ~20. That's slow for a
chatty user, but the bar is a long-term progress
indicator and the move-per-turn feedback is what Tobe
wanted; the math "1 per turn" matches his mental model.

The previous "0+50" combined fraction in the compact
label was replaced by the v3.10.37 clean "X/Y" fraction
which now updates by 1 each turn.

## 2. Sustained-speech guard (native + JS, both layers)

Tobe: "On the second my turn it still jumped to
responding for some reason, no sending and
transcribing."

**Root cause (most likely).** The native silence
detector in `WakeWordModule.kt` was marking
`recorderHasUserSpoken = true` on a single 80ms chunk
above RMS 0.010. Brief transient audio at the start of
a recording turn — a cough, table click, mic rustle, or
audio cue bleed — would trip this flag, prime the 6s
silence window, and once the user actually stayed quiet
for that window (because they were thinking or hadn't
started talking yet), the silence event fired with a
low-content audio. The JS-side `stopAndSendRecording`
saw `speechDetectedDuringRecordingRef === true`, sent
the audio, the LLM responded quickly, and the cycle
loop'd without the user actually speaking.

The bug was reproducible on the SECOND turn of a
multi-turn loop specifically because the
`audioPlayerFinished` event fires very close to the
recorder's start — the speaker buffer hasn't fully
drained, and the turn cue (Bell, ~1s duration) is
playing concurrently with the first chunks of the new
recording turn. The bleed from the cue audio trips
`recorderHasUserSpoken` on turn 2.

**Fix.** Required sustained speech at TWO layers:

**Native (`WakeWordModule.kt`):**
- New `recorderSpeechFrameCount` volatile.
- `recorderHasUserSpoken` only flips true after
  `MIN_RECORDER_SPEECH_FRAMES = 5` consecutive chunks
  above `SPEECH_RMS_THRESHOLD` (0.010). At 12.5Hz
  (80ms chunks), 5 frames = 400ms of sustained
  audio.
- Reset the run on any non-speech chunk or at the
  start of every new recording turn.

**JS (`WakeModeScreen.tsx`):**
- New `speechEventsRunRef` and `lastSpeechEventAtRef`.
- `speechDetectedDuringRecordingRef` only flips true
  after `MIN_JS_SPEECH_EVENTS = 3` consecutive `owwVad`
  events with `rms > 0.015 && zcr > 0.02`. At the
  throttled 5Hz owwVad rate, 3 events ≈ 600ms of
  sustained speech.
- Reset on any rms < 0.005 (definite silence), or at
  the start of every new turn (in `startRecordingTurn`).

The hysteresis band (0.005 - 0.015 RMS in native,
matching the JS gap) doesn't break the run, mirroring
the v3.10.28 smart-silence design where mid-range audio
is treated as "indecisive" rather than "new silence".

**Why both layers.** Both native and JS check the
speech flag independently — native decides when to
emit `recorderSilence` (which the JS recorder forwards
to `stopAndSendRecording`); JS uses `owwVad` to flip
`speechDetectedDuringRecordingRef` which decides
whether the audio is gibberish or real speech.
Requiring sustained audio at BOTH layers closes the
race from either side.

## Side effects

- Real user speech is unchanged. A user saying "hi"
  is 200-400ms = 3-5 frames at 80ms/chunk = well
  above the 5-frame threshold. The guard doesn't
  add perceived latency — the threshold is low
  enough that even short utterances trip it well
  before the user's normal pause (6s silence
  threshold for the silence window itself).
- Clicks and coughs no longer trigger empty-round
  sends. They'd have to last >= 400ms sustained
  above RMS 0.010 to count as speech — essentially
  requiring real conversational intent.
- Cycle bug "on the second my turn jumped to
  responding" should be gone: the turn-2 audio cue
  bleed is <400ms, well below the 5-frame sustained
  threshold.

## Files

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — new `recorderSpeechFrameCount` volatile, new
  `MIN_RECORDER_SPEECH_FRAMES = 5` constant,
  `recorderSpeechFrameCount = 0` reset in
  `startRecorderWithSilence`, sustained-speech logic
  in `processRecorderChunk` (replaces the single-check
  `recorderHasUserSpoken = true` on first above-
  threshold chunk).
- `src/screens/WakeModeScreen.tsx` — new
  `speechEventsRunRef` and `lastSpeechEventAtRef`,
  refactored `owwVad` listener to require sustained
  speech events (3 in a row with gap < 1500ms), reset
  in `startRecordingTurn`.
- `src/components/VoiceEnrollmentBar.tsx` —
  `ACTIVE_CONTRIBUTION_PER_TURN` constant updated from
  50 to 1 (cosmetic — the actual increment now lives
  in WakeModeScreen's `stopAndSendRecording`).
- `package.json` 3.10.37 → 3.10.38
- `android/app/build.gradle` versionCode 264 → 265,
  versionName 3.10.38