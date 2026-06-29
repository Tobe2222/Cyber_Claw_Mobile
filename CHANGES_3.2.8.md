# v3.2.8 — Wake trainer: show what's currently trained

Tobe re-tested after the v3.2.7 watchdog shipped, opened the
trainer screen, and reported: "There is no indication that it
is trained. We need some indicator for that on this page."

The trainer's idle screen showed "0 / 6 samples" and a "Train"
button regardless of whether a model was already active. The
companion picker (HomeScreen → SettingsScreen) had a
"✓ trained" badge added in v3.2.1, but the trainer screen
itself didn't surface the same information. The user couldn't
tell from looking at the trainer whether:

- They had never trained a model for this companion,
- They had trained a model for a different phrase, or
- They had trained a model for the phrase currently in the
  input box (i.e. about to overwrite it).

This release adds a status badge at the top of the trainer
that answers all three questions at a glance.

## Two states

**Trained** (green-tinted badge with checkmark):
```
✓  Listening for "hey clawsuu"
   Training will overwrite this model.
```

The phrase comes from `WakeWordModule.getSavedWakeModels()`,
which the native side populates from `filesDir/wake_models/`
on app start and updates every time a new model is hot-swapped
in. The "will overwrite" line is shown when there's a model
on disk (so the user knows their next Train is going to
replace it).

**Untrained** (gray-tinted badge):
```
No trained model yet — record 6 samples and hit Train.
```

Shown when no entry exists for this companion. The phrasing
makes the path-to-trained explicit instead of leaving the
user to infer it from the empty sample counter.

## How the data flows

- **On mount:** the trainer calls
  `WakeWordModule.getSavedWakeModels()` and reads the entry
  for `companionId`. If present, sets the badge to the
  trained state. If absent, sets it to the untrained state.
- **After a successful training:** the trainer re-fetches
  the saved-models map (the same call) so the badge updates
  to reflect what was just installed. The native side is
  the single source of truth — we don't try to mirror its
  state in React.

The data is read once on mount + once after `stage` becomes
`'complete'`. No polling. The native `getSavedWakeModels()`
is a sync read of SharedPreferences (per the SettingsScreen
comment), so it's cheap to call.

## Why not the cache or the desktop

The desktop caches the most recent `wake_training_result`
per agent, but the trainer's "currently trained" question is
about what's installed on THIS device, not about what
training the desktop last ran. The two can legitimately
diverge: the user could have trained a model, then deleted
it from the phone, then opened the trainer. The native
`getSavedWakeModels()` is the right source.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — new
  `currentTrainedPhrase` / `trainedModelPath` state, mount
  + post-complete effects to populate them, status badge in
  the render, two new style blocks.
- `package.json` — 3.2.7 → 3.2.8
- `android/app/build.gradle` — versionCode 153 → 154
- `.github/workflows/{android-build,build}.yml` — artifact
  names to 3.2.8
