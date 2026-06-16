# v3.1.26 — kill the OLD in-home fullscreen wake mode (it kept flashing on top of the new WakeModeScreen)

## The bug

Every time the wake word fired, the mobile briefly showed the
OLD in-home fullscreen overlay — the one with the Voice Mode /
Wake Mode buttons in the top-right corners, the "Responding..."
status text, and the green terminal-style log at the bottom —
even though v3.1.12+ is supposed to switch straight to the
dedicated, minimal WakeModeScreen (black background, large
centered sprite, "Listening for wake word..." at the top).

It happened fast on a fast device (a 50ms flash). On a slow
device or with the screen recording, it was unmistakable. The
user kept reporting "the old wake mode is back" and asking
for it to be removed.

## Root cause: leftover "robustness" code from a pre-v3.1.12 architecture

The wake flow in v3.1.12+ is supposed to be:

  wake event → App.tsx listener → setScreen('wake-mode')
  → HomeScreen unmounts → WakeModeScreen mounts and renders

But HomeScreen still had three leftover "state-wipe recovery"
hooks from the v3.1.11 era, when wake mode was an in-home
fullscreen overlay (`setFullscreen(true)`) and these hooks
were the safety net:

1. `handleWakeWord` (the sample-matcher callback) toggled
   `isWakeWordMode` and `setIsWakeWordMode(true)` BEFORE calling
   `enterVoiceMode('wakeword')`, which then reset those and
   called `onOpenWakeMode?.()`. So between the toggle-up and
   the reset, HomeScreen re-rendered with the in-home wake
   state visible.

2. A per-render watcher (no deps, runs on every render) checked
   the module-level `moduleLevelWakePending` flag and re-applied
   `setFullscreen(true)` + WebView `.fullscreen` class if the
   in-home state was "wiped". The check was
   `if (!fullscreen || !isWakeWordMode)`, which evaluated
   `(true || false)` = `true` for the entire window between
   `setIsWakeWordMode(true)` and the `enterVoiceMode` reset.
   So the watcher fired and re-opened the OLD overlay.

3. A 2-second polling effect read the
   `cyberclaw-wake-pending` AsyncStorage flag and re-ran
   `handleWakeWord` to replay the wake. Combined with #2, this
   caused the OLD overlay to come back multiple times after
   the initial wake event.

The trigger for the user's specific case was the **sample
matcher** (audio-fingerprinting) path: that's the one that
still calls `handleWakeWord` directly inside HomeScreen.
(The native Vosk listener was moved to App.tsx in v3.1.12, but
the sample matcher's callback was not.)

## The fix

Wake now has exactly one destination: the dedicated
WakeModeScreen. No in-home path to "restore".

- Removed the per-render watcher entirely.
- Simplified `handleWakeWord` to a thin wrapper: stop the
  in-home sample listener, show a toast, persist the
  AsyncStorage pending flag, call `onOpenWakeMode?.()`.
  No more `setIsWakeWordMode` toggle, no more
  `enterVoiceMode('wakeword')` call (it only existed to
  reset the in-home state).
- Updated the 2-second polling effect to route its replay
  through `onOpenWakeMode?.()` instead of re-running
  `handleWakeWord` (which had the in-home baggage).
- Removed the `moduleLevelWakePending` flag manipulation
  in `enterVoiceMode('wakeword')` (the variable is now
  dead but harmless; left in place for now to avoid
  touching too many lines).

The `cyberclaw-wake-pending` AsyncStorage flag is still the
recovery signal for the activity-torn-down case. App.tsx's
`checkPending` and HomeScreen's `wakePendingCheckCounter`
both still watch it, and both now route the recovery
through `onOpenWakeMode` (App-level screen switch). No more
in-home path.

## Bonus: tab click also swaps the arena sprite

The user reported: "if you click Lamasuu the chat changes
but the arena still shows Clawsuu's sprite." The arena's
active companion is driven by `companionId`, which the
WebView reads on initial load. The tab click handler
was updating `activeChatAgentId` and `messages` but not
`companionId`, so the WebView never re-rendered with the
new companion.

Now the tab click handler also:
- Calls `setCompanionId(a.sprite)` so the WebView reloads
  with the new companion
- Persists it to `AsyncStorage` (`cyberclaw-arena-comp`)
  so it survives an app restart

The `onAgentsList` handler does the same for the initial
default (the first agent in the list) so the arena matches
the active chat tab on first load.

## Files

- `src/screens/HomeScreen.tsx`
  - Removed per-render `moduleLevelWakePending` watcher
    (the source of the OLD overlay flash).
  - Simplified `handleWakeWord` — no more in-home state
    toggling, just persist + route to `onOpenWakeMode`.
  - Updated the 2s polling effect's replay to call
    `onOpenWakeMode?.()` instead of re-running
    `handleWakeWord`.
  - Removed the `moduleLevelWakePending = false` line in
    `enterVoiceMode('wakeword')` (dead state).
  - Tab click handler now updates `companionId` so the
    arena WebView swaps to the clicked companion's sprite.
  - `onAgentsList` handler now also sets `companionId`
    for the initial default companion.
- `package.json` — bumped to 3.1.26
- `android/app/build.gradle` — versionCode 76, versionName
  3.1.26
- `.github/workflows/android-build.yml` /
  `.github/workflows/build.yml` — bumped artifact names to
  `app-debug-3.1.26` and `CyberClaw-Android-3.1.26.apk`

## Verification

- The TS error at line ~1962 in HomeScreen.tsx is unchanged
  (pre-existing, metro bundler tolerates it).
- Bumped to v3.1.26 (versionCode 76) and pushed to `main`;
  debug + release builds will run on push.
- Manual reproduction after build: trigger the wake word.
  Expected: the minimal black WakeModeScreen with the large
  centered sprite shows, no OLD in-home overlay flashes
  before it.
