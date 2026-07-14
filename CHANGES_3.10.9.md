# v3.10.9 — Cancel silence countdown on speech resume + longer response settle

Tobe tested v3.10.8 and reported (channel `#cyber-dev`):

1. **Cue sound now plays** (great — the AssetManager
   fix worked).
2. **Cue sound "interrupts the companion speech at its
   end"** — the cue starts during what sounds like
   the last syllable of the response audio, instead of
   after the response fully ends.
3. **Silence detector cuts him off mid-sentence**:
   "For some reason it cuts me off a few seconds
   before my last sentence finishes. With varying
   durations of speech. I heard the cue now. Im going
   to try with 7 seconds Instead of 5 but 5 works
   nicely sometimes."

## Fixes

### #1 — Cancel the silence countdown when speech resumes

The silence detector works in two phases:
1. Native side: `recorder.start(path, silenceMs)` runs
   the recorder, emits `recorderSilence` when
   `recorderSilentForMs >= silenceMs`.
2. JS side: the `recorder.once('silence', ...)`
   listener starts a 5-second countdown. If the
   countdown reaches 0, `stopAndSendRecording('silence')`
   is called and the audio is sent.

The bug: the 5-second countdown runs to completion
regardless of whether the user resumes speaking. So a
sentence like "I went to the store [PAUSE 6.5s] to
get milk" with `silenceMs=6s` would:

- 0–3s: user speaks
- 3–6s: pause (no speech) → silence detector
  starts counting
- 6s: native emits `recorderSilence`, JS starts 5s
  countdown
- 6.5s: user resumes "to get milk" (mid-countdown)
- 11s: countdown reaches 0, audio sent (truncated to
  "I went to the store" — no "to get milk")

The fix has two parts:

**(a) Switch `recorder.once` → `recorder.on` with a
guard.** The native recorder emits `recorderSilence`
EVERY 80ms while silence persists (it's an
edge-triggered emit, not a one-shot — re-fires every
chunk past the threshold). With `once`, only the first
emission registers. With `on` + `silenceFiredRef`
guard, the countdown starts once per silence period
and can re-arm when speech resets it.

**(b) Cancel countdown on speech resume via the
existing `owwVad` listener.** The native recorder
already emits `owwVad` at ~1Hz with `rms` and `zcr`
fields. The existing listener checks for first-time
speech (sets `speechDetectedDuringRecordingRef`). I
extended it: if the countdown interval is currently
running and `rms > 0.015` (speech detected), cancel
the countdown and reset the silence-fired guard so
the NEXT silence period can re-fire normally.

Net effect on the example above:
- 0–3s: user speaks (recorder RMS > 0.015)
- 3–6s: pause
- 6s: silence detected, countdown starts
- 6.5s: user resumes "to get milk" → RMS goes above
  0.015 → owwVad event → countdown cancelled,
  silenceFiredRef reset, status back to 'listening'
- 9–10s: user finishes "to get milk", pauses again
- 16s: NEXT silence detected, countdown starts fresh
- 21s: countdown reaches 0, audio sent (full
  sentence)

Tobe's intent: send when he's done. The new behavior
matches that intent — pauses don't trigger the
countdown, only the FINAL pause does.

### #2 — Bumped RESPONSE_SETTLE_DELAY_MS 1500ms → 2500ms

`MediaPlayer.setOnCompletionListener` fires when
MediaPlayer's internal buffer is drained, but the
audio HAL still has 100-300ms of buffered audio on
the speakers. The 1500ms gap was sometimes not enough
to mask this — the cue would start while the last
syllable of the response was still audible through
the speaker.

The fix: 2500ms gives a comfortable buffer that should
always clear the speaker before the cue plays. With
the v3.10.8 cue sound actually playing (vs. silently
failing), the timing is now visible to the user, so
this matters.

## Files

- `src/screens/WakeModeScreen.tsx` (+~50 / -20):
  - `silenceFiredRef` ref added (tracks whether
    countdown started for current silence period)
  - Switched `recorder.once('silence', ...)` to
    `recorder.on('silence', onSilenceEvent)` with
    `silenceFiredRef` guard
  - `silenceFiredRef` reset in `stopAndSendRecording`
    AND in `startRecordingTurn` (for the new-turn case)
  - Extended `owwVad` listener to cancel the silence
    countdown when speech resumes (RMS > 0.015 during
    a running countdown)
  - Bumped `RESPONSE_SETTLE_DELAY_MS` 1500 → 2500
- `package.json` — 3.10.8 → 3.10.9
- `android/app/build.gradle` — versionName 3.10.8 →
  3.10.9, versionCode 235 → 236

## General lessons

**1. Pause-and-resume is a real pattern; detectors
need to know about it.** A silence detector that
triggers on pause duration is only correct if the
user has finished their full sentence. Pauses
between clauses ("I went to the store [PAUSE] to
get milk") are common and the detector should
ignore them. The fix: a speech-resume signal that
cancels any in-progress "send" decision. Without
this, the detector's "user is done" assumption is
always wrong at least once per turn for any user
who pauses to think.

**2. The native emit + JS counter pattern is fragile
to the emit's edge-vs-level semantics.** The native
recorder emits `recorderSilence` every 80ms while
silence persists (level-triggered). `recorder.once`
worked by accident because the listener unsubscribed
itself, but it ALSO blocked the re-fire path I needed
for speech-resume handling. The fix (`recorder.on` +
JS guard) is more explicit about the intent: fire
once per silence period, re-arm on speech.

**3. Audio HAL latency is real.** `MediaPlayer`'s
`OnCompletionListener` fires when MediaPlayer's
internal playback position reaches the end of the
file, not when the speakers finish playing the last
sample. The audio HAL typically has 100-300ms of
buffered samples that haven't drained through the
speakers yet. Any audio path that triggers another
playback on `OnCompletionListener` needs to wait
at least 300ms+ to avoid overlap. We were using
1500ms which was comfortable in testing (no audio
overlap visible) but the v3.10.8 cue sound actually
playing exposed the underlying timing.

**4. When fixing a bug, audit adjacent code that
"happens to work."** The native recorder's
`recorderSilence` emit semantics weren't documented.
I assumed it was one-shot because `once` worked.
When Tobe reported the mid-sentence cut-off, I had
to actually read the native code to understand the
emit pattern. Don't trust assumptions about
unfamiliar subsystems — read the source.

## What this fixes vs. doesn't fix

This fix makes the silence detector forgiving of
mid-sentence pauses. It does NOT change the
fundamental "did the user finish" detection. If
Tobe genuinely stops talking mid-sentence and walks
away, the audio will still be sent (now correctly,
since he's actually done). The fix is specifically
about "user pauses mid-sentence and continues" — a
common enough pattern that it should be the
default behavior.

If Tobe still wants more time to think before
sending, he can:
1. Bump silenceMs to 7-8s in Settings
2. Or extend the countdown to 7s (one-line change
   in WakeModeScreen.tsx)

Both are user-controlled and don't require code
changes.