# 3.1.52 — Wake/Voice mode shows currently active chat companion

## What it fixes
Tobe: "the voice and wake mode can actually display the currently selected text channel companion"

The wake/voice mode was showing a STALE companion — the one loaded from AsyncStorage when the app started, not the one the user currently has selected. If the user tapped a different companion tab, then triggered wake, they'd see the original companion (not the one they were looking at).

## Why
`App.tsx` loaded `companionId` from AsyncStorage once on mount and never updated. When the user tapped a different companion tab in HomeScreen, only `setActiveChatAgentId` was called — App.tsx's `companionId` was untouched. So when wake fired and `WakeModeScreen` rendered with `companionId` from App.tsx, it was stale.

## The fix
- `HomeScreen` now reports `activeChatAgentId` back to `App.tsx` via a new `onActiveCompanionChange` callback prop.
- `App.tsx` updates its `companionId` state whenever the callback fires.
- The wake/voice mode now shows the same companion the user is looking at in the chat tab.

The change is reactive — every time the user taps a different companion tab, App.tsx's `companionId` updates, and the next time wake mode is opened, it shows the new companion.

## Files changed
- `App.tsx` — pass `onActiveCompanionChange` callback to HomeScreen
- `src/screens/HomeScreen.tsx` — accept and fire the callback when `activeChatAgentId` changes
- `package.json` — 3.1.51 → 3.1.52
- `android/app/build.gradle` — versionCode 101 → 102, versionName "3.1.52"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.52
- `CHANGES_3.1.52.md` (new)

## What I deliberately did NOT change
- The wake mode visual (still black background, forest gone) — fixed in v3.1.50
- The setAgents idempotency (still no rebuild on refresh) — fixed in v3.1.51
- The state machine / direction bias — fixed in v3.1.51
- The Voice/Wake buttons in the home screen arena — fixed in v3.1.51 (inline display:none was a v3.1.50 mistake)