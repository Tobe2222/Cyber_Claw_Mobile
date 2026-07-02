# v3.4.6 — Fix status-bar padding on iOS (v3.4.5 was Android-only)

## What changed

v3.4.5 added `paddingTop: 50 (Android) / 10 (iOS)` to clear the system
status bar. Tobe's screenshots after installing v3.4.5 showed the
sections still flush against the status bar — the device was an iPhone
(the Dynamic Island is visible in the status bar). The iOS=10 path
was insufficient.

Bumped iOS paddingTop from 10 → 50 to match Android. 50pt clears both
Android status bars (~30-40dp) and the iOS Dynamic Island (~30pt
+ safe-area inset) with breathing room.

## Files

- Edited: `src/screens/SettingsScreen.tsx` (content paddingTop)
- Edited: `src/screens/CompanionSettingsScreen.tsx` (scroll paddingTop)
- Edited: `package.json` (3.4.5 → 3.4.6)
- Edited: `android/app/build.gradle` (versionCode 183 → 184, versionName 3.4.5 → 3.4.6)