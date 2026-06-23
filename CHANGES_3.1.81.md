# v3.1.81

## Visible "Retrain" button + small explanation text for the 5-style system

Tobe: "I still see no retrain here. It should briefly be explained
with a text also. Small texts."

### What changed

1. **Retrain button is now visible and clearly tappable** when
   a style is at max samples (3/3). Before v3.1.81, the button
   said "Normal • full" with a disabled style (gray border,
   no `onPress`). It looked like a status indicator, not an
   action. Now it says "🔁 Retrain 🗣️ normal" with a solid
   orange border and an active background. Tapping it opens
   the SampleTrainer with the same style; the trainer's
   auto-retrain logic compares the new sample to the existing
   ones and silently replaces the worst.

2. **Small hint text below the Retrain button**: "We'll
   auto-replace the worst sample if your new one is more
   consistent. Or ✕ to delete one first and add fresh." Two
   short lines, dimmed color, italic feel — fades into the
   background but answers the question.

3. **Top-of-screen help box** explains the 5 style categories
   in one short paragraph. The user understands at a glance
   why there are 5 styles and what "1 required, up to 3"
   means. Before this, the 3/3 / 1/3 / 0/3 counters were
   unexplained.

4. **Migration now persists immediately** when the legacy
   v3.1.67 shape is detected. Before v3.1.81, the migration
   ran in `loadWakeTraining` but only returned the migrated
   data in memory; storage still had the old (broken)
   shape. The user had to record a new sample or delete one
   to trigger a save. Now the migrated shape is written back
   on first load, so the 3934.0s / 3921.0s / 3959.0s display
   values are corrected the next time the user opens the
   Wake Phrases menu (without requiring any other action).

### Files

- `src/components/TrainingDetailScreen.tsx` — new help box,
  retrain button + hint, removed disabled state
- `src/services/WakeTrainingModel.ts` — migration now
  persists on load (was: in-memory only)
- `package.json` — 3.1.80 → 3.1.81
- `android/app/build.gradle` — versionCode 130 → 131
- `.github/workflows/{build,android-build}.yml` — artifact
  names
