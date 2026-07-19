# v3.10.57 — Remove .tflite path from active-wake panel (setId was hiding inside it)

Tobe (post v3.10.56):

> "Same result. Extra set still there, it only brings
> confusion."

v3.10.55 removed the standalone setId line from the
active-wake panel, but the .tflite path was still
shown underneath, and the path format is
`wake_models/<setId>/model.tflite` — so the setId
(`hey-clawsuu-1784421358373`) was still visible
embedded in the path text. Tobe saw the same setId
still showing up.

## Fix

`src/screens/CompanionSettingsScreen.tsx` —
removed the path `<Text>` element from the
active-wake panel. The panel now shows only:

- Display name (big, white)
- Test wake button (next to the tip text)
- Result panel (after running the test)

No path. No setId. Nothing else.

The .tflite path was debug-only ("does the file
exist on disk?") and isn't useful on this panel
because the Wake Sets manager already shows the
full path as the primary identifier per set.
If Tobe needs to debug a missing/moved file, the
manager is the place to look.

## Files changed

- `src/screens/CompanionSettingsScreen.tsx` —
  removed path `<Text>` and its conditional
  wrapper.
- `android/app/build.gradle` — versionCode 283→284,
  versionName 3.10.56→3.10.57.
- `package.json` — version 3.10.56→3.10.57.

## Why v3.10.55 missed it

The path was originally kept on the panel as
"useful for debugging ('does the file actually
exist on disk?')". That justification was wrong:
the user is not debugging files, they're using
the app. The debug use case belongs in the Wake
Sets manager, where the path is the primary
identifier. Showing the path on the active-wake
panel duplicates it AND leaks the setId as a
substring of the directory name.

The lesson (re-stated): when removing a
redundant identifier from the UI, also check
every other field whose value contains or
embeds that identifier. v3.10.55 removed the
explicit `<Text style={styles.activeWakeSetId}>`
but didn't audit the path `<Text>` which had
the setId baked into the directory name.

## Verification on device

Open Companion settings → Wake. The active-wake
panel should now show:
- ◉ **Hey Clawsuu** (big, white)
- 🎤 Test wake button + tip text

No setId. No path. Just the wake phrase and the
test button. If the test panel is showing a result,
that block is below the button as before.