# 3.1.67 — Per-companion wake training + wake mode fix + additive samples

## What it fixes
Tobe: "i tried to add more samples to train wake word better but it replaced my old ones. Could we not just add even more for better accuracy? And i tried to test wake after that but that triggered the wake mode again and disrupted my check. Additionally the companion is missing from wake mode when it is triggered by the wake word actually. And i think my setup for wake to bring up the currently selected chat channel as the companion to trigger is the wrong approach. We should rather train other wake words for other companions. So, in the settings for wake training the user should select which companion to train for."

Four issues:

## Bug 1: Training replaces existing samples
The trainer's `saveSamples` was overwriting the storage entry on save. Now it reads existing samples, appends the new ones, and writes back. Capped at 12 samples max.

## Bug 2: Wake mode triggered by wake word shows no companion
The wake mode WebView needs the agents list. If the user is in Settings (HomeScreen unmounted) when the wake word fires, App.tsx's agents state is empty (only HomeScreen's WebSocket handler propagates them). Fixed by hydrating App.tsx's agents from `cyberclaw-agents-cache` on mount.

## Bug 3: Test wake triggers wake mode
The "Test wake detection" button in SettingsScreen opens WakeWordTester, but the native wake listener kept running. The user's voice during testing matched the wake word and triggered WakeModeScreen. Fixed by stopping the listener in WakeWordTester's mount effect, restarting on unmount. Same pattern as the trainer fix in v3.1.66.

## Bug 4: Per-companion wake words (the design change)
Tobe: "we should rather train other wake words for other companions. So, in the settings for wake training the user should select which companion to train for."

The current design has ONE wake phrase stored under one key. The trainer, listener, and wake mode all share that one phrase. Tobe wants per-companion: each companion has its own wake word.

This is a significant refactor. v3.1.67 ships the foundation:

### Storage change
- Old: `cyberclaw-wake-samples-${phrase-slug}` (e.g. `cyberclaw-wake-samples-hey-clawsuu`)
- New: `cyberclaw-wake-samples-${companionId}` (e.g. `cyberclaw-wake-samples-clawsuu`)

Each companion has its own wake word. The phrase is stored as metadata in the JSON, but the key uses the companion ID.

### Trainer
- Takes `companionId` and `companionName` props
- Storage key is per-companion
- SettingsScreen now hydrates the companion list from local cache and shows a companion picker (Alert) when the user taps "Wake training" — "Train wake word for which companion?" with one option per companion
- If only one companion, goes straight to the trainer
- Default wake phrase is "hey {companionName}", editable

### Matcher
- New `matchAgainstAllCompanions` function in `AudioSampleMatcher.ts`
- Takes `{companionId, features}[]` instead of a single `AudioFeatures[]`
- Returns `matchedCompanionId` along with the score
- The wake listener (in HomeScreen, WakeModeScreen, WakeWordTester) loads ALL companions' training data and matches against all of them
- When a match fires, the matched companionId is propagated to App.tsx

### Wake mode shows the matched companion
- WakeModeScreen calls `onWakeMatch(matchedCompanionId)` when a match fires
- App.tsx receives this and updates `companionId` state
- The wake mode WebView re-renders with the new active companion

### Test wake
- WakeWordTester now also uses the per-companion matcher (loads all companions' data)
- Stops the wake listener on mount, restarts on unmount (so testing doesn't trigger wake mode)

## Files changed
- `android/app/src/main/assets/arena.html` — (no change)
- `App.tsx` — hydrate agents from cache, accept onWakeMatch callback, pass to WakeModeScreen
- `src/components/WakeWordTrainerV2.tsx` — companionId prop, per-companion storage, append-not-overwrite save
- `src/components/WakeWordTester.tsx` — per-companion matcher, stop wake listener on mount
- `src/screens/HomeScreen.tsx` — per-companion matcher in 4 call sites, handleWakeWord accepts matched companionId
- `src/screens/SettingsScreen.tsx` — companion picker on wake training button, hydrate companion list from cache
- `src/screens/WakeModeScreen.tsx` — per-companion matcher, onWakeMatch callback, restart listener uses per-companion data
- `src/services/AudioSampleMatcher.ts` — new `matchAgainstAllCompanions` function
- `package.json` — 3.1.66 → 3.1.67
- `android/app/build.gradle` — versionCode 116 → 117, versionName "3.1.67"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.67
- `CHANGES_3.1.67.md` (new)

## Lesson: per-instance data needs per-instance storage
The trainer was designed for a single wake phrase shared across all companions. To support per-companion wake words, the storage key needs to be per-companion (not per-phrase), the matcher needs to be per-companion (return which companion matched), and the UI needs a per-companion picker. All three changes are coupled — fixing one without the others leaves the system in an inconsistent state.

The "right" way to do this would have been to design the wake training system with per-instance data from the start. The shortcut of a single shared phrase worked until the user wanted more.

## Lesson: the test button is part of the user's flow
Tobe reported the "Test wake detection" button disrupted their check. This is the same pattern as the trainer (v3.1.66) — any UI that captures audio needs to stop the wake listener. The pattern is now consistent: stop on mount, restart on unmount.

## Known issue: backward compatibility
Old training data (under `cyberclaw-wake-samples-${phrase-slug}` keys) is still in AsyncStorage. The new matcher uses `cyberclaw-wake-samples-${companionId}` keys. The old data is loaded by the matcher (it filters all keys starting with `cyberclaw-wake-samples-`), so it still works. But the new trainer writes to the per-companion key, so users re-training will get the new key. The old data can be cleared from settings or just left in storage.
