# 3.2.18 — Wake Mode killed. Voice Mode is the only screen.

## Reported by Tobe

After v3.2.17 (multi-turn voice-mode loop + silence/exit-phrase
exit), Tobe reported:

> "to be clear, there is only voice mode now with wake word
> trigger. Wake mode is or should be gone."

And separately the companion sprite was missing when voice mode
opened via wake word. Two problems, both addressed here.

## v3.2.18 changes

### Wake Mode removed

- App.tsx: no more `screen === 'wake-mode'` render block.
- App.tsx: the `handleWake` (app-level wake listener) now
  `setScreen('voice-mode')` directly, not `setScreen('wake-mode')`.
  The wake word opens voice mode with no intermediate screen.
- App.tsx: removed `onOpenWakeMode` prop from HomeScreen.
- App.tsx: type signature narrowed from
  `'home' | 'settings' | 'wake-mode' | 'voice-mode'` to
  `'home' | 'settings' | 'voice-mode'`.
- HomeScreen: removed the `Wake Mode` badge from the header.
- HomeScreen: removed the legacy `toggleWakeWordMode` fullscreen
  fallback path. The shim still routes to voice mode for any
  leftover callers (legacy arena `wakeword` message type).
- HomeScreen: handleWakeWord now calls `onOpenVoiceMode` instead
  of `onOpenWakeMode`. Same wake-pending AsyncStorage flag for
  the activity-torn-down recovery case.

### Voice Mode now handles wake + record in one flow

- WakeModeScreen's `voiceMode` prop is now always true (the
  `voiceMode=false` arm is dead code, kept as a guard).
- The voice-mode-mount useEffect (v3.2.17) starts a recording
  turn immediately. The wake listener inside the screen is
  short-circuited via `if (voiceMode) return;` (v3.2.17).
  Net effect: wake word fires → App swaps to voice-mode →
  recording starts. No second wake word needed.

### Companion-missing fix

- WakeModeScreen's `setAgents` inject useEffect now retries
  every 1s for up to 5s if `agents` is empty when the screen
  mounts. Previously it only injected once on mount and
  gave up if `agents` arrived later (which was the case
  for wake-from-background opens, since App.tsx loads agents
  from AsyncStorage after the first render).

### Multi-turn loop preserved

- The v3.2.17 multi-turn loop (recording → silence → countdown
  → send → response → next recording turn, exit on silence
  or exit phrase) is unchanged. With Wake Mode gone, voice
  mode is now the only screen, and the loop is the only
  way to have a multi-turn conversation.

## Files

- `App.tsx` — wake-mode render block removed, handleWake
  routes to voice-mode, screen type narrowed
- `src/screens/HomeScreen.tsx` — onOpenWakeMode prop removed,
  toggleWakeWordMode is now a voice-mode shim, wake-mode
  badge removed from header, handleWakeWord routes to voice-
  mode, BackHandler simplified (no wake-mode branch),
  arena `wakeword` message routes to voice-mode
- `src/screens/WakeModeScreen.tsx` — setAgents useEffect
  now retries for late-arriving agents (companion-missing
  fix)
- `package.json` 3.2.17 → 3.2.18
- `android/app/build.gradle` versionCode 163 → 164,
  versionName 3.2.17 → 3.2.18
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.18

## Lessons

- **"Two screens that look the same will diverge"**: Wake
  Mode and Voice Mode were functionally identical since
  v3.1.93, but they had separate render branches, separate
  prop callbacks (`onOpenWakeMode` vs `onOpenVoiceMode`),
  separate ref-based toggle functions, and separate state
  hooks. Every one of those was a place the two could drift.
  Collapsing to one screen removed ~115 lines of
  duplicated-or-dead code. The simpler architecture also
  prevents a whole class of bugs (the v3.2.17 bug was
  caused by the wake-mode path running its wake listener
  even when the user was past the wake stage).
- **WebView instances are independent**: every fresh mount
  has its own `companions` array. If the React parent owns
  the data, the WebView must be re-injected when a new
  instance mounts. The previous `setAgents` useEffect only
  fired when `agents` was non-empty on mount — late data
  arrival (AsyncStorage load) caused the companion to
  silently disappear. The fix is to retry until either
  data arrives or the retry budget is exhausted. Same
  lesson as the v3.1.59 home-screen-injects-setAgents
  story, but the retry pattern is the actual fix; one-shot
  on mount is too brittle for async data.