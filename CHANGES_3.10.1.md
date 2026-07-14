# v3.10.1 — wake set display name + BG service sync + OWW init path

Tobe tested v3.10.0 and reported three issues:

1. **Settings still says "no wake word yet"** for a companion
   even though the Wake Manager (separate code path, same data
   source) shows the wake set as active. The companion list
   row's `wake: "..."` line never appears.

2. **Newly-trained wake phrase should be the set's name**. Tobe
   expected the typed phrase to be the displayed name in the
   manager card. The current setId is a slug+timestamp
   (e.g. `hey-clawsuu-1784025212000`), so the top-line of the
   card reads as a filesystem identifier, not a human name.
   Tobe worked around it by renaming each set via the Rename
   button to make the display look right.

3. **App-open false wake triggers**. With "Background
   listening" on and the app open, Tobe gets repeated false
   wake openings. The newly-trained phrase is supposed to
   silence this (it's a unique phrase) but the false triggers
   kept happening.

## Root causes

### #1 — Stale savedWakeModels hydration

`SettingsScreen` and `CompanionSettingsScreen` both
hydrated `savedWakeModels` via a `useEffect` with
`[availableCompanions.length, activeWakeCompanionId]`. On a
warm launch (AsyncStorage agents cache already populated),
neither dep changes between mounts, so the effect doesn't
re-fire after the user returns from the wake trainer route.
Result: the cache stays empty and the UI says
"no wake word yet" even though the manager (which uses
`getActiveWakeSet` + a separate `listWakeSets` call) sees
the active set.

`WakePhrasePicker` had a defensive refetch with
`[Object.keys(savedModels).length]` dep, which fires only
when the count of trained companions changes — same blind
spot.

### #2 — Slugified setId as the card title

`setWakeModelFromBase64` builds setId as
`<slugified-phrase>-<timestamp>` for filesystem safety
(e.g. `hey-clawsuu-1784025212000`). The manager card's
top-line displays `entry.setId` as the title and
`entry.phrase` as a secondary line below. The slug is
correct as a filesystem identifier but is ugly as a UI
title. Tobe wanted the typed phrase (with its original
spelling and capitalization) to be the primary name.

### #3 — BG service kept listening for the old phrase

`setWakeModelFromBase64` hot-swaps the .tflite into the
**foreground** OWW detector (the one used by WakeModeScreen
and the wake-mode listening thread). It does NOT update
`cyberclaw-audio-settings.wakeWord` or
`cyberclaw-active-wake-companion`, which are the AsyncStorage
keys that the **background** `CyberClawService` (Vosk +
PhoneticMatcher) reads on start. After training, the BG
service kept listening for whatever phrase was in
audio-settings — usually the old "hey clawsuu" default
from a previous test. PhoneticMatcher's
`avgScore = 0.55` threshold fuzzy-matches "hey" + anything
vaguely similar to the second word, so natural speech
containing "hey" + any similar-sounding second syllable
fired the wake. Tobe trained a unique phrase but the BG
service still ran against the old one, producing the false
wakes.

A related v3.9.0 issue (documented in MEMORY.md but
unfixed) made this worse: the trainer's unmount cleanup
calls `initOww(currentTrainedPhrase)`, which closes and
re-creates the OWW detector. `OpenWakeWordDetector.loadModels`
looks for the model file at:

- `assets/openwakeword/<wakeword>_v0.1.tflite` (bundled)
- `filesDir/wake_models/<wakeword>.tflite` (legacy flat)

The v3.9.0 trainer writes to
`filesDir/wake_models/<setId>/model.tflite` (directory
registry, slug+timestamp setId). So `loadModels` can't
find the file, returns `false`, the new detector is
half-initialized (melspec + embedding only, no wake
classifier), and `predictScore` returns null wake scores.
The foreground OWW thread stops firing wake events, so
the only thing actually firing wakes is the BG service
— with the OLD phrase. Every false trigger was a BG-
service false trigger, not a model false trigger.

## Fixes

### Fix #1 — AppState 'active' refetch

Both screens' `getSavedWakeModels` refetch now also fires
on `AppState` `change → 'active'`. The screens mount +
unmount as the user navigates between Settings →
Companion → WakeTrainer route. The trainer route doesn't
unmount the underlying screen tree in a way that changes
the parent's deps, so the previous effect didn't see
the new data. AppState fires when the screen comes back
to focus from a pushed route, so the refetch happens.

`WakePhrasePicker`'s defensive refetch also picks up
`AppState` for the same reason.

### Fix #2 — `displayName` field on WakeSetMeta

Added a new optional `displayName` field to
`WakeSetMeta` (Kotlin) and to the JS-side entry types.
`setWakeModelFromBase64` writes
`displayName = <typed phrase>` at set creation time
(captured as the user's literal input — capitalization,
spaces, all). `migrateWakeSetsSync` also writes
`displayName = phrase` for legacy migrated sets so the
display is consistent.

`getSavedWakeModels` and `listWakeSets` return the new
field. JS falls back to `phrase` on legacy meta.json
files that don't have `displayName` set (backward
compatible — no migration step required).

`WakeSetManagerScreen` card layout:
- Big title: `displayName` (the typed phrase)
- Small monospace line below: `setId` (the slug+timestamp)
- Size + date below that
- Active badge / action row at the bottom

`SettingsScreen` companion list row uses
`displayName || phrase` in the `wake: "..."` line.
`WakePhrasePicker` rows use `displayName` for the
phrase subtitle.

### Fix #3 — Sync wake phrase to BG service on training

`OpenWakeWordTrainer._onModel` (the JS handler for
`wake_model_data` from the desktop) now performs
three writes after a successful training:

1. `AsyncStorage.setItem('cyberclaw-audio-settings', ...)`
   updates `wakeWord` to the typed phrase.
2. `AsyncStorage.setItem('cyberclaw-active-wake-companion', ...)`
   updates the active wake companion to the trained agent.
3. If `cyberclaw-bg-listening === 'true'` AND
   `BackgroundService.stop` / `BackgroundService.start` are
   available, stop the running BG service and restart it
   with the new phrase. The brief audio gap (~200ms) is
   acceptable — the user is between training completion
   and the first real turn, no audio is being recorded.

Same pattern applied to the Wake Set Manager's
`handleActivate` and the Pull-from-desktop import
flow. Activating a different wake set from the manager
now also pushes the new phrase to the BG service.
Importing a set from the desktop (Pull button) does
the same — the imported phrase becomes the active
BG-service phrase.

All three writes are best-effort. A failure is logged
but doesn't roll back the training — the .tflite is
already on disk + hot-swapped into the OWW detector.
The BG service will pick up the new phrase on the
next app restart or BG-listening toggle even if
the live restart failed.

### Bonus fix — `loadModels` finds v3.9.0 directory sets

`OpenWakeWordDetector.loadModels(wakeword)` couldn't
find files written by the v3.9.0 trainer because the
setId is a slug+timestamp, not the typed phrase. Added
`findWakeModelByPhrase(context, wakeword)` that scans
the directory registry and matches by `meta.json`'s
`phrase` field (case-insensitive, exact match preferred,
contains as fallback, newest wins ties). Also checks
SharedPreferences for an `active_<agentId>` binding whose
agentId matches the wakeword argument — this is the
common case for `initOww(companionName)` callers and
avoids matching a stale set.

Now `initOww("Hey Clawsuu", 0.5)` correctly loads the
trained model. The OWW detector is fully initialized
(including the wake classifier), and the foreground
listening thread can fire `owwWakeDetected` events
again.

## Files

- `android/app/src/main/java/com/cyberclawmobile/OpenWakeWordDetector.kt` (+~85/-3, the new `findWakeModelByPhrase` and the updated `loadModels` fallback)
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` (+~25/-5, the `displayName` field on `WakeSetMeta`, updates to `setWakeModelFromBase64` / `migrateWakeSetsSync` / `getSavedWakeModels` / `listWakeSets` / `readMeta` / `writeMeta`)
- `src/components/OpenWakeWordTrainer.tsx` (+~50, the BG service sync in `_onModel`)
- `src/components/WakeSetManagerScreen.tsx` (+~50, BG service sync in `handleActivate` and the Pull-from-desktop import, plus `displayName` rendering in the card title)
- `src/screens/CompanionSettingsScreen.tsx` (+~30, AppState refetch in both the parent's effect and the picker's defensive effect, plus `displayName` propagation)
- `src/screens/SettingsScreen.tsx` (+~25, AppState refetch, `displayName` propagation, type updates)
- `package.json` (3.10.0 → 3.10.1)
- `android/app/build.gradle` (versionName 3.9.4 → 3.10.1, versionCode 226 → 228)

## Lessons (general)

### Sync all listeners / services, not just the one you're testing

When a new "thing" is added (here: a wake set with a
custom .tflite), audit ALL the places that consume
the related state — not just the one you're testing.
The OWW detector got the hot-swap, but the BG service
(separate Android service, separate state path) didn't.
The fix pattern is: when you add a feature, grep the
codebase for OTHER places that read the same AsyncStorage
key / SharedPreferences key / file, and update them too.

### Direct paths vs. registry paths

The `loadModels(wakeword)` function took a `wakeword`
string and looked up the .tflite at a derived path. This
works as long as the file location is a function of the
wakeword string. But the v3.9.0 trainer uses a
directory registry (one folder per set, with a slug+
timestamp setId), where the file location is a function
of the SET ID, not the wakeword. The two storage
schemes can't both be derived from the same string
without an indirection — the registry needs to be
queried by metadata (the meta.json's phrase field),
not by filename.

General rule: when a function takes a "name" argument
and uses it to derive a filesystem path, the filesystem
layout should be keyed by that name. If the layout
changes to use a different key, the function needs an
indirection (registry lookup, indexed map, etc.) — it
can't just keep using the original derivation.

### Stale refetch deps in React

`useEffect` with a dep array fires on mount and on dep
change. It does NOT fire when a parent component
unmounts and remounts a child (e.g. via route
push/pop) UNLESS the dep actually changed. If the dep
comes from cached state (e.g. `availableCompanions`
from AsyncStorage that doesn't change between
mounts), the effect runs once with the warm cache and
never re-runs.

Two ways out:
1. **Use `[]` dep** for "fire once on mount" semantics
   and rely on the child to re-trigger via a different
   mechanism (a refetch function passed as a prop,
   for example).
2. **Listen to AppState 'active'** — fires whenever the
   app comes back to the foreground, including after
   the user returns from a pushed route. This catches
   the "data changed while I was unmounted" case.

For Settings screens that show server-driven state,
`AppState` 'active' is almost always the right
refetch trigger. The user comes back to the screen
expecting fresh data, even if the screen didn't
explicitly remount.
