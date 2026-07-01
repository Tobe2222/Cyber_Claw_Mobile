# v3.2.28

## Critical fix: Settings crashes on tap (v3.2.27 regression)

**Bug**: Tapping Settings in v3.2.27 force-closed the app.

**Root cause**: `TrainedPhrasePicker` (newly added component for the
exit-phrase picker) used `useCallback`, but the React import at the
top of `SettingsScreen.tsx` only included `useState`, `useEffect`,
`useRef`. With `useCallback` undefined, the picker threw on first
render: `TypeError: useCallback is not a function` (or equivalent
"undefined is not a function" depending on bundler).

In RN production mode this is an uncaught React render error — no
red box visible — which surfaces as a force-close back to home
screen, OR the activity getting torn down by the system (matching
the v3.2.27 logcat pattern: `onHostDestroy`, no JS error line
because logcat filter was too narrow).

**Fix**: one-line patch at line 21 of `src/screens/SettingsScreen.tsx`:

```diff
-import React, { useState, useEffect, useRef } from 'react';
+import React, { useState, useEffect, useRef, useCallback } from 'react';
```

## Verification

- 1419 lines, brace/paren/bracket balance: 0/0/0
- `useCallback` referenced 2× (declaration + 1 call site in
  `TrainedPhrasePicker`), imported on the corrected line.
- Diff vs `v3.2.27`: 1 line in `src/screens/SettingsScreen.tsx`,
  1 line in `package.json` (3.2.27 → 3.2.28),
  2 lines in `android/app/build.gradle` (versionCode 173 → 174,
  versionName "3.2.27" → "3.2.28").

## Out of scope for this release

- Build workflow hardcoded APK filename `CyberClaw-Android-3.2.27.apk`
  (`${{ github.ref_name }}` not used in upload step). v3.2.28 will
  likely upload a 3.2.27-named APK. Fix deferred per user
  ("nevermind the rename").
- Stale `vv3.2.24` / `vv3.2.25` / `vv3.2.26` tags (from before the
  build-workflow title fix) — those still need local + remote tag
  cleanup from earlier conversation.
- Exit phrase **as confirmation** (the companion actually echoing
  back "goodbye" / "see you" before going silent) — upcoming.
