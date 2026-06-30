# 3.2.27 — Multi-trained exit phrases + workflow `vv` fix

## Reported by Tobe

After v3.2.26 (trainer card styling), Tobe reported three
things:

1. **vv3.2.25 / vv3.2.26 on GitHub releases.** GitHub
   release titles were prefixed with two v's because my
   workflow in v3.2.25 used `--title "v${{ github.ref_name }}"`
   — but `github.ref_name` is already prefixed with `v`
   (it's the full tag name `v3.2.25`). So the release title
   became `vv3.2.25`.

2. **No way to know if a phrase is trained.** The exit-phrase
   section just had a single TextInput. Users couldn't tell
   whether they'd actually trained the phrase in it or not.

3. **Should support multiple phrases** (train many, pick
   which one is active). The single TextInput doesn't support
   that.

## v3.2.27 fixes

### GitHub release name bug

- Workflow `build.yml`: changed `v${{ github.ref_name }}`
  to use `${{ github.ref_name }}` directly (the tag already
  has the `v` prefix). New releases will be correctly named
  `v3.2.27`, not `vv3.2.27`.
- Existing `vv3.2.24`, `vv3.2.25`, `vv3.2.26` releases will
  need to be renamed manually in the GitHub UI (Tobe's
  account). The fix is forward-only.

### Multi-phrase trainer picker

- Removed the orphan exit-phrase TextInput from Voice mode
  loop section.
- New `TrainedPhrasePicker` component shows a list of all
  trained phrases (each as a radio button + ✓ trained
  badge). Tap one to make it active. The active selection
  persists to AsyncStorage.
- If no phrases are trained, the picker shows: "No trained
  exit phrases yet. Tap 'Train exit phrase' above to record
  6 samples." — directs the user to the trainer card.
- "Disable exit phrase" link appears when a phrase is
  active. Tap to clear the selection (voice mode will then
  close only on silence or X button).

The trainer card (added in v3.2.26) remains the single
source of truth for what phrases exist. The picker is the
single source of truth for which one is active. No more
orphan TextInput.

### Behavior

- Train a phrase → it auto-becomes active (radio on)
- Tap another trained phrase → switches active
- Disable link → clears active (no exit phrase)
- Voice mode runtime still uses text-match fallback
  (v3.2.20 — fuzzy substring on STT transcription) until
  v3.2.28 wires the audio-stream DTW detector

## Files

- `src/screens/SettingsScreen.tsx` — removed TextInput,
  added TrainedPhrasePicker component + styles
- `.github/workflows/build.yml` — fixed `vv` bug in release
  title
- `package.json` 3.2.26 → 3.2.27
- `android/app/build.gradle` versionCode 172 → 173,
  versionName 3.2.26 → 3.2.27
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.27

## Lessons

- **`github.ref_name` is the full tag, including the `v`.**
  When writing `v${{ github.ref_name }}` you get `vv3.2.27`.
  GitHub tag names are passed as-is — if you want a
  consistent title, copy the tag name directly.
- **"Trained" badges are necessary, not optional.** A
  user-facing control that says "phrase X" needs to
  communicate whether the system has actually learned X
  or the user just typed it. The ✓ trained badge makes
  the state visible without the user having to remember
  what they did.
- **Single source of truth reduces confusion.** The
  exit-phrase TextInput was a parallel input to the
  trainer. Two inputs for one concept = users confuse
  them. Removing the TextInput and pointing users at the
  trainer card up top keeps the trainer as the single
  source of truth.