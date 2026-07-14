# v3.10.12 — Lower VAD speech threshold (soft-spoken cut-off fix)

Tobe reported (channel `#cyber-dev`, screenshot of voice
log mid-cut-off):

> "it cutted me off while talking again. I was mid
> sentence"

Voice log showed: `Silence detected (7000ms)...` — so
the recorder's VAD had concluded that Tobe was silent
for 7 continuous seconds, even though Tobe was still
talking.

## Root cause

The native VAD uses an energy-based RMS detector with
two thresholds:

```kotlin
SPEECH_RMS_THRESHOLD   = 0.015f   // resets silence counter
SILENCE_RMS_THRESHOLD  = 0.008f   // accumulates silence
// Between 0.008 and 0.015: hysteresis band —
// neither resets nor accumulates (absorbs natural
// inter-word drops).
```

The intent was good: hysteresis band absorbs the brief
RMS dips between words/clauses so the silence timer
doesn't fire on natural speech pauses. But for
soft-spoken users (low mic gain, phone at a distance,
quiet headset mic, etc.), their continuous speech RMS
can sit in the 0.008-0.015 band — above silence but
below speech. In that band, the silence timer is NEVER
RESET. It just keeps growing on every chunk that's
below the speech threshold.

If Tobe spoke for 7 continuous seconds at an RMS that
hovered between 0.008 and 0.015 (e.g., soft volume or
distant mic), the silence counter reaches
`silenceMs=7000`, the native side emits
`recorderSilence`, the JS countdown starts, and the
recording is sent — cutting Tobe off mid-sentence.

This is the same class of bug as the previous cut-off
fixes (v3.10.7, v3.10.9), but operating on a different
axis. The previous fixes addressed:
- v3.10.7: countdown runs to completion (timer)
- v3.10.9: countdown doesn't cancel on speech resume

This fix addresses the **upstream** issue: the
silence-detection counter accumulates during continuous
soft speech because the RMS sits in the hysteresis
band.

## Fix

Lowered both thresholds:

```kotlin
SPEECH_RMS_THRESHOLD   = 0.010f   // was 0.015
SILENCE_RMS_THRESHOLD  = 0.005f   // was 0.008
```

The hysteresis band shrinks from 0.007 wide to 0.005
wide. Still wide enough to absorb natural inter-word
drops in normal speech (where the RMS briefly dips
between words but not all the way to ambient noise
floor), but narrow enough that soft-spoken users'
RMS gets recognised as speech (above 0.010).

Room noise floor is typically 0.001-0.003 (per the
existing comment), so 0.005 leaves a comfortable gap
above ambient noise — false-positives from a quiet
room shouldn't fire the silence timer because the
RMS would stay below 0.005.

## Files

- `android/app/src/main/java/com/cyberclawmobile/
  WakeWordModule.kt`: `SPEECH_RMS_THRESHOLD` 0.015 →
  0.010; `SILENCE_RMS_THRESHOLD` 0.008 → 0.005.
- `package.json` — 3.10.11 → 3.10.12
- `android/app/build.gradle` — versionName 3.10.11 →
  3.10.12, versionCode 238 → 239

## Why I'm not adding per-user RMS calibration

A more sophisticated fix would be to:
1. Calibrate the user's voice during a "training"
   session (record 5s of speech, compute avg RMS, set
   thresholds at 80% of avg)
2. Adaptively lower the thresholds over the first few
   turns (assume soft-spoken user if no high-RMS
   frames detected in the first 3 seconds)
3. Use a learned VAD model (Silero, webrtc-vad) instead
   of energy-based

These are larger changes. The current fix is a
two-constant change that addresses the most common
case (soft-spoken user) without needing user input or
training. If the new thresholds still cause issues
(hyperactive false positives on quiet rooms, or still
not capturing very-soft speech), we move to option 2
or 3.

## Lesson

**Energy-based VAD with a hysteresis band is a
trade-off between false-positives (silence detected
during soft speech) and false-negatives (silence not
detected during speech pauses).** The hysteresis band
width is the knob. Wider = more speech pauses survive
(less cut-off), but more soft speech gets stuck in
the band (more cut-off). Narrower = opposite trade-off.

The original 0.007 wide band was sized for normal
speech (RMS 0.02-0.10). For soft speech (RMS 0.01-0.02)
the band is too wide. There's no single setting that
works for everyone — the right answer is per-user
calibration, which we're deferring.

Going forward: if soft-speech cut-offs keep being
reported, the answer is adaptive thresholds
(option 2) rather than chasing the constant again.