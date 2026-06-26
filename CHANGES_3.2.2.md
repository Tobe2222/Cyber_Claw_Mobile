# v3.2.2 — Drop the legacy wake-training UI; small polish

## What changed

Tobe tested v3.2.1 and asked for two things:

1. **Remove the old wake-training alternatives.** The
   "🎤 Wake training" button (DTW-based sample matcher) and
   "🎤 Test wake detection" button are gone. Only "🧠 Train
   with AI" remains — it's the proper openWakeWord pipeline and
   supersedes both.

2. **Add top padding on the training page.** The training
   modal was crashing into the status bar at the top. Fixed
   with `paddingTop: 60` on the ScrollView content (matches
   the convention in `WakeWordTester.tsx` and
   `TrainingDetailScreen.tsx`).

Also deleted the now-dead component files (the legacy trainer
UI) so the repo isn't carrying unused code:

- `src/components/WakeWordTrainer.tsx`
- `src/components/WakeWordTrainerV2.tsx`
- `src/components/WakePhraseMenu.tsx`
- `src/components/TrainingDetailScreen.tsx`
- `src/components/TrainingManager.tsx`
- `src/components/TrainingSummary.tsx`
- `src/components/SampleTrainer.tsx`
- `src/components/WakeWordTester.tsx`

The DTW sample matcher itself (in `WakeTrainingModel.ts`) is
left in place because `WakeModeScreen` still uses it for
`noteWakeModeOpen`/`noteWakeModeExit` analytics — those track
wake mode usage statistics, not the deprecated training data.

## Files

### Modified
- `src/screens/SettingsScreen.tsx` — removed the legacy buttons,
  removed related state vars + modal render blocks, removed
  `owwTrainerPending` (the picker now always routes to the OWW
  trainer), simplified picker onSelect handler, renamed the
  section from "Training" to "Custom wake word"
- `src/components/OpenWakeWordTrainer.tsx` — added
  `paddingTop: 60` to the scroll content

### Deleted
- 8 legacy trainer components (see above)

### Meta
- `package.json` — 3.2.1 → 3.2.2
- `android/app/build.gradle` — versionCode 147 → 148
- `.github/workflows/build.yml` + `.github/workflows/android-build.yml` —
  artifact names

## What the wake section looks like now

```
🎤 Wake Word
Train and tune the wake phrase that wakes your
companion in the background.

[ Background listening toggle + threshold sliders ]

Custom wake word
  🧠 Train with AI
  Record yourself 6 times — desktop trains a custom
  neural network wake word

Wake greeting
[ Phrase input ]

Audio buffer
[ ... ]
```

Cleaner. One path.

## Lessons

- **Don't ship "both" for long.** v3.2.0 shipped the new trainer
  *alongside* the old ones because we were rushing. v3.2.2
  finishes the cutover. The old code was actively misleading —
  users were picking the legacy DTW path when they thought they
  were picking "wake training," and wondering why their models
  triggered on any speech. The new path is the only path now.
- **When you delete UI code, also delete the files.** Even
  though no one imports them anymore, leaving the files around
  makes future grep'ing misleading and adds cognitive load
  during code review.

## Out of scope

- The legacy DTW training data is still in AsyncStorage from
  any users who trained before this update. `WakeTrainingModel.ts`
  exposes `migrateLegacyPhraseKeys` to convert old keys to the
  new format. Not deleting the legacy data preserves any
  analytics history but is otherwise dead weight. Could add a
  cleanup pass in a future version.
- The OpenWakeWord pipeline still requires the desktop to have
  run `scripts/setup_training_env.sh` once (17GB ACAV100M +
  195MB Piper voice). If a user installs the v3.2.2 APK but
  hasn't set up the desktop env, the training will fail at the
  first Piper TTS call with a clear error message. The next
  thing to build: a "Test desktop connection" check in the
  Settings that probes for the env readiness before letting the
  user tap Train.