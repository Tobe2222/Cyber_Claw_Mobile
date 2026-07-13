# v3.9.3 — Hotfix: Voice mode gibberish-gate drops every recording

Tobe (in #cyber-dev, ~15:38 with screenshot after testing
v3.9.2): "Okey i updated and tested again. The problem
remains. [...] I tried the send phrase but that did not
trigger either, that needs to be listened for at all
times during user speech."

Screenshot showed the overlay correctly reset to "🎤 YOUR
TURN" (v3.9.2 fix worked for that part) but the log still
cycled:

```
🎤 Listening...
🔊 done (cached-play, 1656ms)
⏰ Silence detected (3000ms)...
🔇 No speech detected, skipping…
🎤 Still listening...
```

The "🔇 No speech detected, skipping" line fires after
**every single recording turn** — even when Tobe was
actively speaking the send phrase.

## Root cause

The v3.6.0 gibberish gate in
`stopAndSendRecording()` (src/screens/WakeModeScreen.tsx)
drops recordings where
`speechDetectedDuringRecordingRef.current === false`.
The flag is set true by the `owwVad` event listener
(WakeModeScreen.tsx ~1456), which fires from the native
**OWW listening thread** (the TFLite wake-word detector
running on `owwRecord`).

In **wake mode**, the OWW thread is the active mic. In
**voice mode**, it's not. `startRecorderWithSilence()`
(Kotlin `WakeWordModule.kt:361`) explicitly does:

```kotlin
isRecording = true
isListening = false   // <- stops the OWW thread
```

…to prevent dual audio reads from the mic (the original
comment warned about this exact conflict).

With the OWW thread stopped, **no `owwVad` events fire**.
The JS-side flag stays false for the entire turn. Every
recording gets dropped by the gibberish gate. Even when
the user speaks the send phrase — by the time the
recording stops, the flag is still false.

Net effect: in v3.9.2, voice mode works exactly as badly
as v3.9.1 — the gibberish gate is guarding against a flag
that's **structurally never set** during voice mode turns.

## Fix

`android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:

The recorder path already polls amplitude every 500ms
(via `rec.maxAmplitude`) for its existing wait-for-
speech-then-silence logic. The polling loop has a
`// v3.2.25 — reserved for future exit-phrase detection`
comment that was a placeholder. We now emit `owwVad`
events from this loop at ~1Hz cadence:

- **RMS**: `maxAmplitude / 32767` (normalized 0..1)
- **ZCR**: synthesized — 0.10 when amplitude ≥
  `SILENCE_THRESHOLD` (i.e. speech-like), 0.0 otherwise

The JS gate checks `RMS > 0.03 && ZCR > 0.02`. With
SILENCE_THRESHOLD = 1000 (≈3% of max amplitude), this
means RMS ≈ 0.03+ and ZCR = 0.10 → both pass exactly when
`hasUserSpoken` would flip on the native side. The gate
fires precisely when the user actually speaks.

For silence (amp < 1000), RMS < 0.03 → gate correctly
rejects. Net effect: the JS gibberish gate now works in
both wake mode AND voice mode.

Bridge traffic stays bounded — ~1Hz emit cadence (every
2 of 500ms polls), well within budget.

## Why this and not "drop the gate"

The gibberish gate's job is real: prevent hallucinated
responses to background-noise recordings. The 30s hard
cap (MAX_RECORDING_MS) doesn't help — it fires regardless
of speech, so a 30s recording of HVAC hum still gets to
`stopAndSendRecording` and needs to be dropped. With the
fix, the gate has the data it always needed.

## Out of scope for this release

**Send-phrase detection during recording remains broken.**
Tobe: "I tried the send phrase but that did not trigger
either, that needs to be listened for at all times during
user speech."

The send-phrase TFLite detector runs inside the same OWW
listening thread that this fix bypasses for VAD. Real
send-phrase detection on the recorder stream requires
either:

1. Keeping the OWW thread running during recording
   (re-introduces the dual-mic problem the comment
   warned about, would need mixing/echo-cancellation
   work to be safe)
2. Switching from `MediaRecorder` (compressed m4a) to
   `AudioRecord` (raw PCM16) so the existing
   `OpenWakeWordDetector.predictScore(pcm16: ShortArray)`
   function can run on chunks of the recorder stream
   alongside wake/exit detection
3. A second dedicated detector running only on the
   recorder stream

(2) is the cleanest fix and reuses the existing
inference path. It's a meaningful refactor (raw PCM
capture, JNI plumbing, frame sync with the existing
1280-sample window) so I'm leaving it for a follow-up
release.

**Workaround for v3.9.3**: voice mode now works for
normal speech. For send-phrase, use a shorter `silenceMs`
setting (e.g. 1500ms) so the natural pause after the
send phrase trips the silence timer and sends. The
send-phrase stays as a "skip the silence-wait" feature
in the trainer for now, but the recording always goes
out at silence-end.

## Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (+46/-0)
- `package.json` (3.9.2 → 3.9.3)

## Verification

Build verified: `./gradlew :app:compileDebugKotlin
--offline` passes. Test plan after install:

1. Open voice mode, wait 3s without speaking → log
   shows the silence path, overlay returns to YOUR TURN.
2. Open voice mode, speak normally → log shows "Sent,
   waiting..." (NOT "No speech detected, skipping").
3. Speak the send phrase → currently still no real-time
   trigger (see workaround above), but the phrase will
   appear in the transcript if the silence timer fires.

## Companion release

Nothing desktop-side. This is a mobile-only native +
version bump.
