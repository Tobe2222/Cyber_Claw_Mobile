# v3.4.4 — Companion settings is its own full screen

## What changed

After v3.4.3 introduced the 3-level nav (Voice mode → companion → Wake/Exit sub-page),
Tobe flagged that the companion detail was still rendered **inline** within SettingsScreen's
scroll — so the page still felt like a single long list mixing Permissions / Voice &
Speech / Agent Reach / Connection / Companion / Wake / Exit all together.

This release extracts the companion view into its own route, so tapping a companion in
the Voice mode list swaps the entire app to a dedicated Companion settings screen.

## Architecture

- New file: `src/screens/CompanionSettingsScreen.tsx`
  - Owns the per-companion state (wake greeting, exit reply, savedWakeModels,
    activeWakeCompanionId, trainer modal state).
  - Owns the `companionViewPhase` (overview / wake / exit) state.
  - Renders the full screen with its own header, sections, trainers.
  - Hardware back handler chains: trainer modal → sub-page → overview → App.tsx back.
  - Auto-backs to SettingsScreen if the companionId can't be resolved from the cache
    (companion was deleted while we were in this view).

- `App.tsx`:
  - New route: `'companion'` alongside `'home' | 'settings' | 'voice-mode'`.
  - New state: `companionScreenId` (string | null) holds the active companion's id.
  - SettingsScreen receives an `onOpenCompanion(id)` callback that sets the route +
    the companionId. CompanionSettingsScreen receives an `onBack()` callback that
    sets the route back to `'settings'`.

- `SettingsScreen.tsx`:
  - Drops `selectedCompanionId`, `companionViewPhase`, the 4 `renderCompanion*()`
    functions (~290 lines removed).
  - Companion list rows now call `onOpenCompanion(c.id)` instead of mutating local state.
  - Hardware back handler no longer needs to pop companion detail states.

## Why not a Modal?

Tobe's complaint was specifically that the companion view "felt inline with Voice &
Speech / Agent Reach / Connection". A React Native `<Modal>` would have kept the
SettingsScreen mounted underneath, which is exactly what he doesn't want. Promoting
the companion view to its own route in App.tsx fully unmounts SettingsScreen while
the user is configuring a companion, and the standard back button returns them to
the settings they left.

## Files

- New: `src/screens/CompanionSettingsScreen.tsx`
- Edited: `App.tsx` (route + companionScreenId state + import)
- Edited: `src/screens/SettingsScreen.tsx` (removed companion detail rendering)
- Edited: `package.json` (3.4.3 → 3.4.4)
- Edited: `android/app/build.gradle` (versionCode 181 → 182, versionName 3.4.3 → 3.4.4)

## Notes

- Pre-existing tsc error in `HomeScreen.tsx(2560)` (stray `/>`) was NOT introduced by
  this release and is left for a separate cleanup.
- The companion view's auto-back logic uses a `hasAutoBackedRef` declared at the top
  of the component to satisfy Rules of Hooks (no `useRef` inside an early-return).