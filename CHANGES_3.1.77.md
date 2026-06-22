# 3.1.77 — Wake training: per-style samples + multiple phrases per companion

## What it does

Restructures the wake training flow to address Tobe's three
requests:

1. **Click a companion → see that companion's wake phrases**
   (not all phrases globally — the menu is now per-companion).
2. **Style-tagged samples** — every sample is recorded as one
   of `normal / loud / whisper / short / elongated`. The
   TrainingDetailScreen groups samples by style with per-style
   "Add sample" buttons (1 mandatory, up to 3 per style).
3. **Multiple wake phrases per companion** — Clawsuu can be
   triggered by "Hey Clawsuu" AND "Hey Babe" simultaneously.
   Both phrases' features contribute to the matcher.

## Data model (unified)

One entry per companion under
`cyberclaw-wake-samples-<companionId>`:

```ts
{
  features: AudioFeatures[],            // flattened: every sample's features
  phrases: [{                           // one entry per trained phrase
    phrase: string,                     // e.g. "hey clawsuu"
    samples: [{
      style: 'normal'|'loud'|'whisper'|'short'|'elongated',
      features: AudioFeatures,
      duration: number,
      quality: number,
      date: string,
    }, ...]
  }],
  trainedAt: string,
}
```

The top-level `features` array is the flattened sum across all
phrases and styles — recomputed on every save. The matcher in
HomeScreen / WakeWordTester reads `parsed.features` directly
without caring about phrase or style structure. **Multiple
phrases per companion means saying ANY of them triggers the
companion** (the matcher can't tell which phrase triggered,
just which companion).

## New files

- `src/services/WakeTrainingModel.ts` — types, storage helpers,
  and migration. `WAKE_SAMPLE_STYLES`, `WAKE_SAMPLE_STYLE_LABELS`,
  `WAKE_STYLE_MIN = 1`, `WAKE_STYLE_MAX = 3`, `loadWakeTraining`,
  `saveWakeTraining`, `addWakeSample`, `countByStyle`,
  `migrateLegacyPhraseKeys`.
- `src/components/SampleTrainer.tsx` — single-sample recorder
  (replaces the old WakeWordTrainerV2's "record 3 samples"
  mechanic). Takes `companionId / companionName / phrase /
  style` as props, records one sample, saves via
  `addWakeSample`, returns to parent.

## Replaced files

- `src/components/WakePhraseMenu.tsx` — now per-companion (takes
  `companionId / companionName` props). Shows each phrase with
  X/Y samples and N/5 styles-completed. "+ Add Wake Phrase"
  creates a phrase with a placeholder sample; the user fills
  the real samples in TrainingDetailScreen.
- `src/components/TrainingDetailScreen.tsx` — now groups samples
  by style with per-style "+ Add … sample" buttons. Mounts
  SampleTrainer for the chosen style.

## Migrated data

- Pre-v3.1.67 keys (`cyberclaw-wake-samples-<phraseSlug>`) are
  loaded on first run, assigned to a companion via substring
  matching on the phrase/companion id (Tobe's "Hey Clawsuu"
  entries resolve to companion "clawsuu"), and saved as the
  new per-companion entry with style `normal`. Idempotent:
  existing new-shape entries aren't overwritten.
- Pre-v3.1.77 single-key entries (`cyberclaw-wake-samples`
  without suffix) are read on demand by `loadWakeTraining` and
  upgraded in memory to the new shape.

## What you should see after install

**Wake Phrases menu** (after picking Clawsuu):
```
🎤 Wake Phrases
Clawsuu
2 phrases · 6 samples total

hey clawsuu                          3 samples · 5/5 styles  ✓
hey babe                             3 samples · 5/5 styles  ✓
+ Add Wake Phrase
```

**TrainingDetailScreen** (after picking a phrase):
```
← Back
📊 "hey clawsuu"
Clawsuu

Total samples  3

🗣️ Normal          1/3
  Sample 1    Quality 95% · 1.2s · 6/22/2026
  + Add 🗣️ normal sample

📢 Loud            1/3
  ...
🤫 Whisper         0/3     • 1+ required
  + Add 🤫 whisper sample
...
```

## Files

- `src/services/WakeTrainingModel.ts` (new)
- `src/components/SampleTrainer.tsx` (new)
- `src/components/WakePhraseMenu.tsx` (per-companion rewrite)
- `src/components/TrainingDetailScreen.tsx` (per-style rewrite)
- `src/screens/SettingsScreen.tsx` — migration call, removed
  WakeWordTrainerV2 wiring, updated helper text.
- `src/components/WakeWordTrainerV2.tsx` — left in place but
  no longer imported. Safe to delete in a future cleanup.

`versionCode` 126 → 127, `package.json` 3.1.76 → 3.1.77.

## Out of scope

- **Per-style recording duration validation.** The "short" and
  "elongated" styles are tagged but the trainer doesn't enforce
  that the recorded audio actually matches the style duration.
  A future version could reject a "short" sample that's >1s.
- **Style-aware match scoring.** The matcher treats every sample
  the same regardless of style. A future improvement could
  weight style-tagged samples by style quality.
- **Deleting the dead WakeWordTrainerV2.tsx file.** Harmless
  dead code; cleaned up in a future PR.