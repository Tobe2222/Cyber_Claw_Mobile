# v3.2.1 — "✓ trained" badges in the companion picker

Small follow-up to v3.2.0. The wake-training flow now has visible
state.

## What changed

When the user opens the companion picker (the modal that shows
when there are multiple companions and they tapped either
"Wake training" or "🧠 Train with AI"), each companion row now
shows a small "✓ trained" badge if a custom wake model has been
saved for them.

The badges are driven by `WakeWordModule.getSavedWakeModels()`
(which reads the SharedPreferences bindings the v3.2.0 hot-swap
wrote). The map is refreshed:

- When the picker opens (so badges are always current)
- When the OpenWakeWordTrainer completes a successful training
  (so the badge appears immediately, no need to reopen the picker)

## Visual

Companion with a trained wake model:
```
🐾  Clawsuu        ✓ trained  train →
```

Companion without one:
```
🐾  Lamasuu                    train →
```

Green badge, monospaced background, sits between the name and the
"train →" hint.

## Why it matters

Before this: after the desktop finished training and the phone
hot-swapped the model, the user had no way to tell that anything
had happened. The next time they wanted to "improve the wake
word," they'd tap "Train with AI" again, get the picker, and
have no indication that this companion already has a trained
model.

After this: the picker surfaces the state. The user can see at a
glance which companions have a custom wake model. They can still
re-train (it just overwrites the old model) but at least they
know the previous training wasn't lost.

## Files

### Modified
- `src/screens/SettingsScreen.tsx` — `savedWakeModels` state,
  picker-open refresh useEffect, badge render in picker row,
  picker-onComplete refresh, new `pickerRowBadge` style
- `package.json` — 3.2.0 → 3.2.1
- `android/app/build.gradle` — versionCode 146 → 147
- `.github/workflows/build.yml` + `.github/workflows/android-build.yml` —
  artifact names

## Lessons

- **Surface state that has cost.** Training a wake word is a
  2-10 minute operation on the desktop GPU, and the trained
  model is bound to a specific companion. If the UI doesn't show
  that the model is live, the user can't tell what happened.
  Status badges are cheap; the missing affordance is expensive.
- **Refresh on show AND on change.** Reading the saved-models
  map once on screen mount would miss in-session changes. Reading
  it on both events keeps the UI in sync with reality without
  requiring a full re-mount.

## Out of scope (still TODO)

- **Re-train UI flow.** The data plumbing is there
  (`deleteSavedWakeModel`) but no UI button for it. After a
  successful training, the user currently has to leave the
  trainer and reopen it to re-train. Easy follow-up.
- **Multi-language wake phrase support.** Piper voice is en-US
  LibriTTS only. Adding more voices is a one-line
  `OPENWAKEWORD_PIPER_MODEL` env change on the desktop side.
- **Edit-trained-phrase flow.** The badge tells you a model
  exists but doesn't let you change the phrase without retraining
  from scratch.