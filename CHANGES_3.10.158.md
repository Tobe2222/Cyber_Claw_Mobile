# v3.10.158 — fix JS bundle SyntaxError in QuestsScreen

## What

The `onSave` callback in `QuestsScreen.tsx` was a sync
arrow function `(updates) => { ... }` but the v3.10.156
change added an `await AsyncStorage.getItem(...)` inside
it. Babel/Metro threw:

```
SyntaxError: /.../QuestsScreen.tsx: Unexpected reserved
word 'await'. (1080:32)
```

GitHub Actions `Build Release APK` workflow failed on
this for v3.10.156 and v3.10.157 (Tobe caught it via
the GH Actions UI).

## Fix

One-character change: `onSave={(updates) => { ... }}`
→ `onSave={async (updates) => { ... }}`. Confirmed the
JS bundle now builds cleanly:

```
$ npx react-native bundle --platform android --dev false \
    --entry-file index.js --bundle-output /tmp/test.js
LOG:Done writing bundle output
```

## Lesson

**TS/JS syntax checks ≠ runtime checks ≠ bundle checks.**

- `tsc --noEmit` happily accepted `await` inside a sync
  arrow function because `tsc` was running with the
  project's `target: ESNext` or similar and didn't
  enforce async-context rules on arrow callbacks.
  (Actually tsc usually DOES error on this — but in
  this codebase the surrounding context was a JSX prop
  in a deeply-nested object literal and tsc didn't
  flag it.)
- Metro/Babel is the source of truth for what ships in
  the APK. **Local `react-native bundle` should be part
  of the CI check** so we catch this before pushing.

Going forward: add `npm run bundle-check` to the
pre-push flow that runs `react-native bundle --dev
false` against a throwaway output. Cheap (~30s) and
catches the kind of thing that GH Actions caught today.
