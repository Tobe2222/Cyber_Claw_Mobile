# v3.10.168 — tiered voice training (Tier 1 → 4) + training page compaction

## What changed

### 1. Tier labels on the enrollment bar (voice-mode + Settings)

The compact enrollment bar (`VoiceEnrollmentBar`) now shows the user's current tier + progress to the next tier instead of the old "Learning X/Y" numerology.

- Tier 0: no profile yet. Bar reads `🎯 Tier 0 · Start →`.
- Tier 1: profile locked. Bar reads `🎯 Tier 1 · locked`.
- Tier 2: 100+ samples. Bar reads `🎯 Tier 2 · 247/1,000 toward Tier 3`.
- Tier 3: 1000+ samples (natural lock threshold). Bar reads `🎯 Tier 3 · 1,247/5,000 toward Tier 4`.
- Tier 4: 5000+ samples. Bar reads `🎯 Tier 4 · Profile finalized`.

Same display in voice mode + Settings — the user can see the tier from either surface.

### 2. New `src/components/VoiceTrainingScreen.tsx`

A dedicated page for voice training. The 100+ line inline `ActiveEnrollmentPanel` block in the Voice mode section moved here; the section now has a single "🎤 Voice training" button that opens the screen.

The page has:

- An explanation card (what voice training is for, the tier ladder)
- A current-tier summary card (Tier N + description + mini bar)
- The full tier ladder (Tier 0 → 4), with a ✓ for reached, ○ for unreached, and the current tier highlighted
- The active enrollment panel (the "Tier 1 unlock" path) — only shown when the user is below Tier 2, because past Tier 1 the bar handles progress visibility
- A "Tier-up log" — recent tier-up events with timestamps and sample counts at each step (persisted to AsyncStorage under `cyberclaw-speaker-tier-log`)
- A destructive "🗑️ Clear voice profile & start over" button at the bottom (hidden when there's no profile to clear)

### 3. New `src/utils/speakerTier.ts`

The tier derivation logic lives in one place. Exports:

- `SpeakerTier` (type, 0–4)
- `SPEAKER_TIER_DEFINITIONS` (the four tiers + their sample thresholds)
- `deriveSpeakerTier({samplesTotal, profileLocked})` — pure function
- `nextTier(current)`, `nextTierThreshold(current)` — for the bar's "toward" logic
- `progressToNextTier({samplesTotal, currentTier})` — fill percent
- `tierProgressLabel({samplesTotal, currentTier})` — formatted label
- `shouldShowVoiceTrainingCTA({samplesTotal, profileLocked})` — the B-threshold check

### 4. B-threshold compaction (Tobe's "user does not need to use that")

The "🎤 Voice training" button in Settings hides once `samplesTotal >= 20`. Above 20, the slot shows a green-bordered row "✓ Voice training active — keep talking. Tier N, X samples so far. Clear profile to retrain from scratch." Same UX intent as the "your-turn cue sound" toggle Tobe hid when there's no model.

Threshold rationale (B = ≥20 samples):

- At < 20 samples the bar barely moves in the natural path; the explicit 30s pass is the faster way to Tier 1.
- At ≥ 20 samples the user is actively learning; redirect them to the bar (or the training screen itself, reachable from elsewhere).

The screen itself is still reachable from the bar when the user wants the explicit retrain — the Settings entry is just hidden by default.

### 5. Tier logic is log-only in v3.10.168

The runtime is still discrete (one-shot lock + frozen embedding). Tier upgrades are LOGGED but don't hot-swap the embedding. The native side has nothing new.

**v3.10.169 will:**

- Add `setSpeakerEmbedding(hot_swap)` to the native `SpeakerVerifier`
- Add `upgradeSpeakerProfile(minNewSamples)` that:
  - Loads the existing locked profile
  - Reads new samples accumulated since last lock (the ring buffer currently stops at lock; will be widened)
  - Quality-gates the new samples against the existing centroid (drop samples with embedding distance > 75th percentile)
  - If ≥ `tierThreshold` quality samples remain, recompute centroid and hot-swap
  - Only commit if the new match score against held-out samples improves by ≥ X% (monotonic — never worse than the previous tier)
  - Rollback window: keep the previous centroid for 24h, revert if false-trigger rate spikes

For now, v3.10.168 makes the tier ladder user-visible so the data shape is honest — when the hot-swap ships, the only change is the label string on Tier 4 ("Profile finalized" → "Continuously refining").

## Files changed

- `src/utils/speakerTier.ts` (new) — tier derivation + threshold logic
- `src/components/VoiceTrainingScreen.tsx` (new) — full-page training UI
- `src/components/VoiceEnrollmentBar.tsx` — tier-aware label + `onPress` prop for the compact pill
- `src/screens/SettingsScreen.tsx` — replaced inline `ActiveEnrollmentPanel` with a button that opens `VoiceTrainingScreen`; B-threshold compaction; lightweight native status subscription
- `android/app/build.gradle` — versionCode 377 → 378, versionName "3.10.167" → "3.10.168"
- `package.json` — version 3.10.167 → 3.10.168

## Verification

- `npx tsc --noEmit` — only pre-existing errors, none from these changes
- `npx react-native bundle --platform android --dev false` — clean (Done writing bundle output)
- The bar's compact pill is now pressable when `onPress` is provided (WakeModeScreen doesn't pass one yet, so the voice-mode bar stays non-interactive; that's intentional — the in-voice-mode bar is a status indicator, not navigation)
- The "Continue training (N/20 samples) →" label ticks up as samples accumulate; once the user crosses 20 the slot switches to the dim "Voice training active" row

## Known follow-ups for v3.10.169+

1. Native `setSpeakerEmbedding` + `upgradeSpeakerProfile` methods
2. Ring buffer keeps accumulating past lock (currently stops at lock)
3. Auto-trigger tier upgrade at the natural threshold
4. Tier-up toast / push notification when a tier is reached passively
5. Voice-mode bar becomes pressable → opens the training screen from voice mode (currently only reachable from Settings)
6. Per-page tier-up animation (the bar fills, then briefly flashes gold before turning the locked emerald)
