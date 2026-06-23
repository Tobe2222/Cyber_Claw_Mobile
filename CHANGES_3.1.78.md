# v3.1.78

## Wake training: shorter min duration + smarter rejection + legacy duration fix

### What changed

1. **Min recording duration 0.15s → 0.08s** (`AudioUtils.ts`).
   Consonant attacks in "hey" are 30-80ms. 0.15s required the
   trailing "y" to finish, which is unintuitive and made the
   "short" style nearly impossible to record. 0.08s still
   rejects accidental taps (typically <50ms) but accepts
   cleanly-clipped wake phrases.

2. **New onset check in `validateAudio`** — first 50ms must
   contain at least one sample with amplitude > 1000
   (normalized ~0.03). This catches the "recorder fired
   silence immediately" bug where the native module returns
   0 audio but the silence event still fires, leaving a
   0-length file that would otherwise save as Quality 80%
   with `duration: 0.00s`.

3. **Legacy duration migration fix** (`WakeTrainingModel.ts`).
   `AudioFeatures.duration` is the PCM sample count (set by
   `extractAudioFeatures`), NOT seconds. Pre-v3.1.77 the
   trainer wrote `f.duration` straight into the
   `WakeSample.duration` slot, producing "3934.0s" /
   "3921.0s" / "3959.0s" on the Normal samples (i.e.
   ~65 min of audio that doesn't exist). The migration now
   divides by 16000 to get seconds. Existing on-device
   entries are corrected the next time the user opens the
   Wake Phrases menu.

4. **Stop hard-coding quality 0.8** in `SampleTrainer`. The
   pre-v3.1.77 trainer wrote `quality: 0.8` into the saved
   record *before* computing the actual DTW-based quality.
   Users always saw "Quality: 80%" on the success screen
   even when the real score was different. We now write 0
   as a placeholder, then update the slot with the real
   computed quality. The visible "Quality: X%" message on
   success now reflects the actual score.

5. **"Too similar" rejection** at record time. Before
   saving, compare the new sample's DTW features against
   all existing same-style samples for this phrase. If the
   best match is > 0.85 similarity, reject with "Too similar
   to an existing NORMAL sample (X% match) — try a different
   tone, volume, or mic position." Keeps the 3 slots per
   (phrase, style) filled with diverse utterances
   automatically. No analysis tool needed — just a 5-line
   comparison at save time.

### Why max 3 samples per style stays at 3

DTW runtime is O(N×M) per (candidate, sample) pair. With
5 styles × 3 samples × 1-2 phrases = 15-30 templates per
companion. That's fine. Going to 5 would:
  - double the template count
  - give the matcher more chances to false-positive on
    outlier samples
  - increase on-device AsyncStorage size linearly
  - show diminishing returns past 3 in literature

3 well-recorded samples beats 5 mediocre ones. The
"too similar" check (change #5) is the high-leverage
fix: it ensures the 3 slots are *diverse*, which is the
real reason more samples help, not the raw count.

### Files

- `src/services/AudioUtils.ts` — looser threshold + onset check
- `src/services/WakeTrainingModel.ts` — legacy duration fix
- `src/components/SampleTrainer.tsx` — too-similar rejection + real quality
- `package.json` — 3.1.77 → 3.1.78
- `android/app/build.gradle` — versionCode 127 → 128
- `.github/workflows/{build,android-build}.yml` — artifact names
