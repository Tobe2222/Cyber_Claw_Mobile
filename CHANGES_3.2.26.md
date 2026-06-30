# 3.2.26 — Exit phrase trainer: same style as wake, sits next to it

## Reported by Tobe

After v3.2.25 (exit phrase trainer shipped), Tobe reported
that the Settings UI looked inconsistent:

> "It looks like this in the settings now. But why? Just
> make it look like the wake does. Why make differences?
> Its the exact same function but in reverse is it not?
> It can even be right under wake to make it look smooth."

Two issues:
1. The exit-phrase "Train" button used a plain `optionBtn`
   style that didn't match the dashed-border card the wake
   trainer uses.
2. It lived 4-5 sections below the wake trainer ("Custom
   wake word" → "Wake greeting" → "Voice mode loop" →
   exit phrase). Visually disconnected from the wake
   training UI it parallels.

## v3.2.26 fix

- Removed the plain `Train exit phrase (record 6 samples)`
  button from the Voice mode loop section.
- Added a new dashed-border trainer card right **directly
  under** the wake training card, with the same `trainBtn`
  style. Labelled "🚪 Train exit phrase" with sub-text
  "Record a short phrase 6 times — closes voice mode
  instantly when heard (v3.2.26 wires the runtime
  detector)".
- The exit-phrase **TextInput** still lives in the Voice
  mode loop section (that's where the user changes the
  phrase text). The TRAINER button moved up next to wake
  training for visual symmetry.

The two trainers now read as a pair:

> 🧠 **Train with AI**
> Record yourself 6 times — desktop trains a custom
> neural network wake word

> 🚪 **Train exit phrase**
> Record a short phrase 6 times — closes voice mode
> instantly when heard

The wake trainer still says "Train with AI" because it
uses the desktop GPU pipeline; the exit-phrase trainer is
local-only so it's just labelled "Train exit phrase" (no
"with AI" qualifier that would be misleading).

## Files

- `src/screens/SettingsScreen.tsx` — added the new trainer
  card under the wake training card; removed the now-
  duplicate plain button from Voice mode loop
- `package.json` 3.2.25 → 3.2.26
- `android/app/build.gradle` versionCode 171 → 172,
  versionName 3.2.25 → 3.2.26
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.26

## Lessons

- **Visual consistency reduces cognitive load.** When two
  UI elements do parallel things ("trainer for X" and
  "trainer for Y"), they should LOOK parallel. The wake
  trainer and exit trainer had identical purpose ("record
  yourself 6 times") but different styling — the user
  reads that as "they work differently." They don't.
  Match the visual grammar to the conceptual relationship.
- **"Right under wake to make it smooth" is good UX
  instinct.** Placing related controls near each other
  helps the user build a mental model. The wake + exit
  trainers are conceptual opposites (one starts a
  conversation, one ends it) — putting them on top of
  each other reinforces that pairing visually.
- **Naming reflects mechanism.** "Train with AI"
  correctly implied the wake trainer uses the desktop GPU
  pipeline (TFLite export). Naming the exit-phrase trainer
  "Train with AI" would be misleading — it's local-only,
  no desktop round-trip. Same UI grammar, accurate label.