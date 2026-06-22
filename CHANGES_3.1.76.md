# 3.1.76 — Wake training: companion picker goes to Phrases menu, not recording

## What it fixes

Tobe: "when i Click the companion to train i get right into the
training... It should rather be that when clicking the companion
to train i get into the samples."

The previous flow: Settings → Wake Word → Train button → modal
picks companion → click companion → goes STRAIGHT to the
recording screen (Training: 'hey Clawsuu', sample 1 of 3).

The new flow: Settings → Wake Word → Train button → modal picks
companion → click companion → goes to the **Wake Phrases menu**,
which lists all trained phrases for that companion with sample
counts and quality. From there the user can:
- See what's already trained
- Pick an existing phrase to view its samples or add more
- Add a new phrase (the existing "+ Add Wake Phrase" button)

The recording screen is one click further into the flow, accessed
from either the Wake Phrases menu (via phrase → Training Detail →
"+ Add More Samples") or by adding a new phrase.

## Change

`src/screens/SettingsScreen.tsx` — the companion picker's
`onPress` now sets `showWakePhraseMenu = true` instead of
`showTrainerV2 = true`. One line of behaviour change; no
state, storage, or component API changes.

```js
onPress={() => {
  setTrainingCompanionId(c.id);
  setTrainingCompanionName(c.name);
  setShowCompanionPicker(false);
  // Take the user to the Wake Phrases menu first ...
  setShowWakePhraseMenu(true);
}}
```

## Known limitation (not fixed here)

The wake-phrase data architecture is inconsistent across files:

- `WakeWordTrainerV2` saves under
  `cyberclaw-wake-samples-${companionId}` (per-companion, since
  v3.1.67)
- `WakePhraseMenu` reads from
  `cyberclaw-wake-samples-${phrase}` (per-phrase)
- `WakeWordTester` reads from per-phrase key
- `TrainingDetailScreen` reads from per-phrase key

The trainer writes to one key, the viewers read from another.
This means samples trained after v3.1.67 don't appear in the
Wake Phrases menu. The menu currently shows pre-v3.1.67 data
(migrated from the old single-key format on first run).

This is pre-existing and out of scope for this fix. Surfacing
it for future work: a clean data model is probably
`cyberclaw-wake-samples-${companionId}-${phraseSlug}` (per-
companion-per-phrase), with the trainer and all viewers reading
and writing that key.

## Files

- `src/screens/SettingsScreen.tsx` — companion picker onPress
  target changed from `showTrainerV2` to `showWakePhraseMenu`.

`versionCode` 125 → 126, `package.json` 3.1.75 → 3.1.76.

## Out of scope (future work)

- Per-phrase sample categorization by style (loud, whisper,
  short, elongated, etc.). This is a larger change — needs
  data model extension, trainer UI to pick a style before
  recording, viewer UI to group samples by style, and a
  migration path for existing samples.
- Per-companion filtering in the Wake Phrases menu (the
  current menu shows all phrases regardless of which
  companion was picked).