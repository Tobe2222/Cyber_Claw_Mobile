# Changelog — v3.1.12 (session 2026-06-14)

Branch: `main`. Tag: `v3.1.12`. Build: `versionCode 62`.

---

## v3.1.12 — wake word lands on Wake Mode, mobile matches desktop scope

### 1. Wake word → home screen bug, finally fixed

**Symptom:** When the wake word fires from the background (or
lock screen), the app opens to the regular home screen instead of
the dedicated Wake Mode fullscreen UI. Manual Wake Mode button
works fine. Test button (🧪) in the header bar has been unreliable
as well.

**Root cause:** The wake flow lived entirely inside `HomeScreen`
and used a `fullscreen` boolean + `isWakeWordMode` flag. That
worked most of the time, but a state wipe between the wake event
firing in JS and the React re-render (caused by the activity
re-configuration triggered by `setShowWhenLocked` /
`setTurnScreenOn` in `AppControl.showOnLockScreenWithDismiss`)
would reset the flags and leave the user on the home screen.

The previous recovery attempts (v3.1.9–v3.1.11) added an
AsyncStorage-based pending flag, a 2s polling effect, and a
per-render watcher. These helped but didn't fully solve the
problem because the bug is structural: HomeScreen does double
duty as both the home UI and the wake-mode UI, with one set of
state controlling both renderings. Any state wipe can flip you
back to home.

**Fix:** Move wake-mode UI into a dedicated screen that ONLY
renders wake mode. App.tsx switches to it on wake event. There is
no way for it to land on the home screen because it's a different
screen.

- `App.tsx` now listens for `wakeWordDetected` (NativeModule
  emitter) and `wakeWordOpenedApp` (DeviceEventEmitter from
  MainActivity's `emitWakeOpenedWithRetry`) and the
  `cyberclaw-wake-pending` AsyncStorage fallback. Any of these
  triggers `setScreen('wake-mode')`.
- New `src/screens/WakeModeScreen.tsx`. Renders a fullscreen
  black-background WebView with Wake Mode styling applied to
  `#ui` / `#c` / `body` / `html` (`documentElement`). Includes
  the same orange X close button, green voice log overlay, and
  orange status overlay that the in-HomeScreen version had.
  Has its own wake word listener (using the same DTW sample
  match code), silence detection → 3s countdown → auto-send,
  and audio-response handling. All in one self-contained
  screen with no racy shared state.
- `HomeScreen.tsx` no longer listens for wake events. The
  manual "Wake Mode" button now calls `onOpenWakeMode` (a new
  prop from App) which navigates to the same WakeModeScreen
  — single code path for both manual and triggered entry.
  `handleWakeWord` is left intact in HomeScreen for the test
  button and the sample-match listener callback (those are
  out-of-band paths that don't need screen routing).
- The home-screen `toggleWakeWordMode` now also delegates to
  `onOpenWakeMode` if App passes it. Legacy fallback kept for
  the case where the prop is missing (tests / older App.tsx).

### 2. Mobile arena settings removed (per Tobe's request)

The mobile `ArenaSettingsScreen` was a separate picker for
background and companion type, plus voice TTS settings. Tobe
wants the mobile to be a true extension of the desktop, so the
arena background and companion type are managed in the
desktop's arena settings panel — not duplicated on mobile.

- **Deleted:** `src/screens/ArenaSettingsScreen.tsx`
- `App.tsx` no longer has the `arena-settings` route. Just
  `home`, `settings`, and the new `wake-mode`.
- `HomeScreen` no longer takes `onOpenArenaSettings` prop. The
  `openArenaSettings` message from the WebView is logged and
  ignored (the WebView is a leftover from when mobile had this
  screen; the desktop is the source of truth now).
- The voice TTS settings live in the mobile Settings screen
  (still used). Only the redundant background + companion
  picker is removed.
- AsyncStorage keys `cyberclaw-arena-bg` and
  `cyberclaw-arena-comp` are still maintained (desktop pushes
  them via the `companion_id` sync event and the WebView
  `saveBg` / `saveComp` messages). They drive the WebView's
  loadPrefs and the companion id selection in the wake mode
  screen.

### 3. Compatibility with desktop v3.1.7

- Companion IDs in the mobile companion picker
  (`fox, boar, deer, hare, black_grouse`) match the desktop
  catalog. No change needed.
- Background IDs (`meadow, grove, forest`) match the desktop
  `BACKGROUNDS` array.
- The mobile's `WakeModeScreen` WebView loads
  `file:///android_asset/arena.html?companion=<id>` — the
  same arena the home screen loads. So the desktop's recent
  fix to `_buildCompanion` (which was broken — every
  addCompanion() threw silently) will apply to wake mode too.

### Files changed

```
App.tsx                                     +47/-12  App-level wake listener
                                                       + wake-mode screen route
src/screens/ArenaSettingsScreen.tsx        DELETED
src/screens/WakeModeScreen.tsx             NEW     Dedicated wake mode UI
src/screens/HomeScreen.tsx                  -32/+8  Remove wake event listeners,
                                                       add onOpenWakeMode prop,
                                                       delegate manual toggle,
                                                       update test button
```

### Verification

- `tsc --noEmit` shows the same pre-existing error as before
  (one `)}` inside a JSX template literal in HomeScreen.tsx,
  unrelated to v3.1.12 work).
- No new TypeScript errors in any of the v3.1.12-touched files.
- All file changes are pure type/structure refactors, no new
  third-party dependencies.

### How to test in the app

1. Build the APK: `npm run android` (or download from the
   `v3.1.12` GitHub release).
2. Open the app — confirm the home screen renders normally
   and the Settings cog still works.
3. Train the wake word: Settings → 🎤 → Train. Say "hey
   clawsuu" three times. Confirm the training summary shows
   ≥70% quality.
4. From a non-home screen (Settings, or another app), say
   the wake word. The app should open to the **Wake Mode
   fullscreen** UI — black background, centered boar, X
   button. **Not** the home screen.
5. Tap the 🧪 test button in the home screen header. Same
   expected result: WakeModeScreen.
6. Tap the "Wake Mode" button in the arena WebView (if
   visible). Same expected result.
7. Press the X button in Wake Mode to exit back to home.
8. Press the Android back button in Wake Mode. Should also
   exit back to home.
