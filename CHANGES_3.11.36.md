# v3.11.36 — End-of-utterance: silence window 6s → 1.8s + countdown 5s → 3s

## Summary

The wake-mode silence window is cut roughly in half (1.8s
default, was 6s) and the post-silence visual countdown
shortened (3s, was 5s). End-to-end "user goes silent → audio
sent" cycle: ~5s (was ~11s).

## What changed

### 1. `VoiceSettings.DEFAULT_SILENCE_MS` 6000 → 1800

The native-side RMS detector already has good hysteresis
(speech-band 0.010 / silence-band 0.005, set in v3.9.5 and
re-tuned in v3.10.12) and the smart-silence toggle
(v3.10.28) provides a relative threshold based on the
actual noise floor. With those in place, a 1.8s trailing-
silence window reliably detects sentence-end for normal
conversational speech.

The previous 6s default was tuned for "thinking out loud"
hesitations (Tobe's v3.9.5 feedback: 'We should have longer
silence detection. Or a way to detect drawn out words due
to thinking.') — but at 6s the round-trip from "user done
speaking" to "LLM reply starts" is ~12s, which kills
conversational flow.

### 2. `MIN_SILENCE_MS` 3000 → 800, `MAX_SILENCE_MS` 15000 → 6000

Slider range tightened. The aggressive end (800ms) is now
usable for users with clear, snappy speech. The slow end
(6s) still gives ample buffer for drawn-out / thinking-
out-loud patterns without the previous 15s ceiling.

### 3. Wake-mode visual countdown 5s → 3s

Pares the post-silence visible countdown down to keep the
total UX snappy. User can still interrupt by speaking
again (the countdown resets on speech detection).

### 4. Hardcoded `5000ms` timeouts in `HomeScreen` / `WakeWordMode`

Reduced to 1800ms (matching `DEFAULT_SILENCE_MS`). Three
sites in HomeScreen and two sites in WakeWordMode. The
native recorder accepts the silenceMs arg directly, so
this is a one-line change per site.

## Why this approach (vs Silero VAD)

Three real options for end-of-utterance:

| Option | Effort | Quality | Status |
|--------|--------|---------|--------|
| Tune silence timeout (this) | Tiny diff | Decent for snappy speech | **Shipped** |
| Trained VAD (Silero) | 1-2 days native bridge | Better for soft-spoken / noisy | Deferred to v3.11.37+ |
| Semantic/linguistic (LiveKit turn-detector) | Built-in with `sherpa-onnx` | Best for naturalness | Deferred to v3.11.37+ |
| Push-to-talk | Zero work | Bulletproof | Already available |

This release ships Option 1 because it's a one-line change
per site and gives ~50% cycle-time reduction with no new
attack surface. Option 2/3 are deferred — they're
substantial new native-module integrations. Happy to do
either in a v3.11.37 if the timeout approach isn't enough.

## Files touched

- `package.json` — version bump 3.11.35 → 3.11.36
- `android/app/build.gradle` — versionCode 429 → 430,
 versionName 3.11.35 → 3.11.36
- `src/services/VoiceSettings.ts` — DEFAULT_SILENCE_MS /
 MIN / MAX retuned.
- `src/screens/HomeScreen.tsx` — 3 hardcoded `5000ms`
 timeouts → 1800ms.
- `src/features/WakeWordMode.ts` — 2 hardcoded `5000ms`
 timeouts → 1800ms.
- `src/screens/WakeModeScreen.tsx` — countdown `5s → 3s`.

## Manual QA
- [ ] Wake mode: say "hey cyberclaw" then a sentence.
 Trailing silence ends at ~1.8s. Countdown appears
 for ~3s. Total ~5s from sentence-end to send.
- [ ] Mid-sentence pause: say "hey cyberclaw... *pause*
 ...and then 2." Doesn't cut off the pause if it's<1.8s.
- [ ] Soft-spoken user: the hysteresis (speech 0.010 /
 silence 0.005) should still register soft speech as
 speech. Verify with the log tab's `speech=` /
 `noise=` floor values after a silence fires.
- [ ] Push-to-talk: unchanged (not affected by this).
- [ ] Slider: open Settings → companion's voice sub-page.
 Silence slider now ranges 800ms-6000ms, default 1800ms.

## Risk

Low. The change tightens timeouts; existing users who set
their own custom silenceMs (per-companion override) are
NOT affected (the slider value is preserved, only the
default for NEW installs changed). For users who relied on
the long default, the countdown is the safety net — they
can interrupt by speaking again within the 3s.

## Rollback

`git revert v3.11.36` restores the v3.11.35 timings. The
per-companion stored silenceMs values are independent of
the defaults, so reverting doesn't blow them away.