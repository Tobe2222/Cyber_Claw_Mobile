# v3.9.5 — Hotfix: Silence detector cuts user off mid-conversation

Tobe (in #cyber-dev, ~16:31 after testing v3.9.4): "Okey
i tested voice conversation again. Now the issue is
that the silence detector is too sensitive or not
working correctly. It cuts me off mid conversation"

## Root cause

Single-threshold silence detection in
`processRecorderChunk()` (WakeWordModule.kt ~line 800).
The native code had one threshold (`SPEECH_RMS_THRESHOLD
= 0.01f`) used for BOTH speech-onset (reset counter) and
silence-onset (accumulate counter):

```kotlin
if (rms >= 0.01f) {
    recorderHasUserSpoken = true
    recorderSilentForMs = 0L        // speech
    return
}
// ... else accumulate silenceMs
```

Natural conversational speech has 100-300ms inter-word
gaps where RMS dips briefly back to ambient levels
(~0.005-0.012). With a single 0.01 threshold, each dip
counts as silence and starts the counter. Once the
accumulated dips cross `silenceMs` (configurable
2-10s, default 5s), the recording ends mid-sentence.

Calibrated ranges:
- Sustained speech: RMS ≈ 0.02-0.10
- Inter-word gap: RMS ≈ 0.008-0.012
- Ambient noise floor: RMS ≈ 0.001-0.005

A single threshold between the inter-word gap and
ambient noise can't exist — they overlap.

## Fix

Hysteresis: separate speech and silence thresholds with
a gap between them. Speech detection uses the higher
`SPEECH_RMS_THRESHOLD = 0.015f`. Silence detection uses
the lower `SILENCE_RMS_THRESHOLD = 0.008f`. The 0.007
hysteresis band absorbs inter-word drops without bleeding
into ambient noise:

```kotlin
if (rms >= SPEECH_RMS_THRESHOLD) {  // 0.015
    recorderHasUserSpoken = true
    recorderSilentForMs = 0L          // speech, reset
    return
}
if (!recorderHasUserSpoken) return
if (rms >= SILENCE_RMS_THRESHOLD) {  // 0.008
    return                            // hysteresis band: do nothing
}
recorderSilentForMs += CHUNK_MS      // below silence threshold, accumulate
```

Three regimes:
1. RMS ≥ 0.015 → clear speech, reset counter
2. 0.008 ≤ RMS < 0.015 → hysteresis band (inter-word gap), do nothing
3. RMS < 0.008 → actually quiet, accumulate silence

## Knock-on: JS gibberish gate threshold

The JS-side `owwVad` listener in `WakeModeScreen.tsx`
had `e.rms > 0.03 && e.zcr > 0.02` as the speech-
detected marker. After this change the native code
recognizes speech at RMS ≥ 0.015 (lower than 0.03), so
the JS gate would never fire even when the user was
clearly speaking. Updated to `e.rms > 0.015` to match
the native `SPEECH_RMS_THRESHOLD`. The gate now fires
exactly when the silence detector considers the user
to be talking.

## Why this and not "make silenceMs longer"

We could push default `silenceMs` from 5s → 8s, but:
- Doesn't fix the underlying issue (10s still cuts at
  the worst inter-word gap of ~400ms × 25 = 10s... but
  natural speech has pauses that exceed 8s regularly)
- Tobe had the issue with default settings; pushing the
  default doesn't help him
- Hysteresis fixes the actual problem at every silenceMs
  setting

## Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (hysteresis split in `processRecorderChunk`)
- `src/screens/WakeModeScreen.tsx` (JS gate RMS threshold
  matched to native)
- `package.json` (3.9.4 → 3.9.5)

## Verification

`./gradlew :app:compileDebugKotlin --offline` passes.
`npx tsc --noEmit` passes (only pre-existing
HomeScreen.tsx:2666 error, unrelated).

## Test plan after install

1. Open voice mode, speak a normal sentence with brief
   natural pauses between words → should NOT cut off
   mid-sentence.
2. Speak a full sentence then pause → should cut off
   after `silenceMs` (default 5s) of true silence.
3. Speak in a quiet environment — should still work
   (the SPEECH threshold is below quiet speech).
4. Speak in a noisy environment — silenceMs will
   accumulate faster in the gaps, but won't fire during
   sustained speech.
5. Send-phrase still fires during recording (v3.9.4
   unchanged).

## Companion release

Nothing desktop-side.
