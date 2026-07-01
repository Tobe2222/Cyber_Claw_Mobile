# v3.4.0

## Settings restructure to 3-level hierarchy (per Tobe's feedback)

The v3.3.0 layout had two parallel sections (Wake settings /
Exit settings), each containing unrelated controls (audio
buffer, match thresholds, silence timeout). Tobe found that
felt like "grab-bags" and asked for a clean hierarchy:

```
(top)  🎤 Voice mode
         - Background listening
         - Audio buffer
         - Companions list  ← NEW: each row is one companion
         - Train-new companion's wake button
         - Silence timeout
         - Match thresholds
              ↓ tap a companion
(mid)  <Companion emoji+name> settings
         - Wake greeting TextInput
         - Exit reply TextInput
         - Wake phrases for THIS companion (with retrain/delete)
         - Train-new wake phrase for THIS companion
         - Exit phrases for THIS companion (with retrain/delete)
         - Train-new exit phrase for THIS companion
              ↓ back button
(top)  Back to companion list

(below)  🔊 Voice & Speech / 🤖 Agent Reach (unchanged)
```

Wake and Exit are no longer top-level sections — they're
features of each companion, reachable via the list.

## What changed in this release

### Storage model: per-companion exit phrases

The biggest non-UI change is the storage key namespace for
exit phrases:

| | v3.3.0 (legacy) | v3.4.0 |
|--|--|--|
| Active exit phrase | `cyberclaw-voice-exit-phrase` (global) | `cyberclaw-exit-phrase-<companionId>` |
| Trained samples | `cyberclaw-exit-samples-<phrase>` | `cyberclaw-exit-samples-<companionId>-<phrase>` |

**Migration:** on first launch of v3.4.0, a one-time
`migrateLegacyExitSamples(companionId)` runs and copies any
legacy keys under the active companion's namespace. Legacy
keys are NOT deleted (so a downgrade to v3.3.0 doesn't lose
training). Future v3.5.0+ can clean up the legacy keys once
we're confident users have migrated.

### New `PerCompanionExitPicker` component

Sibling of `TrainedPhrasePicker` but reads from the new
per-companion namespace. Same row shape (radio + label +
🎙 retrain + 🗑 delete), just scoped to one companion.

### New `selectedCompanionId` state + `renderCompanionDetail`

When the user taps a companion in the top-level list,
`selectedCompanionId` is set and the entire Voice mode
section is replaced by the per-companion detail view. A
back button at the top of the detail view returns to the
list. Implementation: local state, no navigation stack
involved — keeps the change scope contained to SettingsScreen.

### `ExitPhraseTrainer` now takes `companionId` (required)

The trainer modal receives `companionId` as a prop and
writes its samples to the per-companion keys. Caller in
SettingsScreen resolves `companionId` to: active wake
companion → first available companion → 'default' (last
resort, first-time launch).

### `loadVoiceSettings(companionId?)` now takes companionId

`WakeModeScreen` (which runs the voice-mode close logic)
passes the active companionId when loading voice settings
so the runtime detector matches against THIS companion's
exit phrase, not a global one.

### `WakeModeScreen` exit matcher updated

The runtime exit-phrase match (`matchExitPhrase(text, [phrase])`)
now uses the active companion's stored exit phrase.

## What's removed from this release

The pre-v3.4.0 inline exit-phrase picker (in v3.3.0's
"Exit settings" section) is gone. Exit phrase picker is
now reachable only via the per-companion detail view.

The "Voice mode loop" silence picker is now visible on
the top-level Voice mode section (since it's global
behavior, not per-companion).

## What's unchanged

- Wake detection logic (OWW native + threshold-passing
  fix from v3.2.30 + 2s cooldown).
- Exit detection logic (text-match fallback against the
  active phrase; runtime DTW detector still deferred).
- Wake greeting / exit reply TextInputs: same storage keys,
  same data shape. Just moved into the per-companion
  detail view. **They are still global** — typing in any
  companion's detail view changes the same single field.
  Per-companion greetings/replies are future work (v3.5.0+).
- All v3.1/v3.2 features (audio cache, exit reply
  synthesis, etc.) continue to work.
- Desktop `sync-server.js` — no desktop-side changes for
  this release.

## Files

**Modified:**
- `src/screens/SettingsScreen.tsx`:
  - File-top comment updated to v3.4.0 hierarchy.
  - Replaced "Wake settings" + "Exit settings" sections
    with a single conditional render: if
    `selectedCompanionId` is set, render
    `renderCompanionDetail()`; else render the new
    "Voice mode" top-level section with the companion
    list.
  - New `selectedCompanionId` state (and auto-back-out
    if the active companion is removed from the cache).
  - New `renderCompanionDetail()` function (returns the
    per-companion detail view).
  - New `PerCompanionExitPicker` function component.
  - New `useEffect` for `migrateLegacyExitSamples()` —
    runs once on first launch after agent cache is
    hydrated.
  - Trainer invocation passes `companionId={activeWakeCompanionId || first || 'default'}`.
  - New styles: `companionList`, `companionListRow`,
    `companionListRowActive`, `companionListEmoji`,
    `companionListName`, `companionListDetail`,
    `companionListActive`, `companionListArrow`,
    `detailHeaderRow`, `detailBackBtn`,
    `detailBackBtnText`, `detailHeader`.

- `src/services/VoiceSettings.ts`:
  - Storage keys per-companion:
    `getExitPhraseKey(companionId)`,
    `getExitSamplesKey(companionId, phrase)`.
  - All `loadVoiceSettings(companionId?)`,
    `saveExitPhrase(companionId, phrase)`,
    `loadExitSamples(companionId, phrase)`,
    `saveExitSamples(companionId, phrase, features)`,
    `clearExitSamples(companionId, phrase)` now take
    companionId.
  - New `migrateLegacyExitSamples(companionId)` for
    one-time upgrade from v3.3.0 storage.
  - Legacy keys (`cyberclaw-voice-exit-phrase`,
    `cyberclaw-exit-samples-<phrase>`) are exported as
    `LEGACY_EXIT_PHRASE_KEY` / `getLegacyExitSamplesKey`
    for the migration to read from. They are NOT
    deleted — a downgrade to v3.3.0 still finds the
    training.
  - File-top comment updated with v3.4.0 storage
    layout.

- `src/components/ExitPhraseTrainer.tsx`:
  - `companionId` is now a REQUIRED prop.
  - `saveExitSamples` and `clearExitSamples` calls
    updated to pass `companionId`.

- `src/screens/WakeModeScreen.tsx`:
  - Three `loadVoiceSettings()` call sites updated to
    pass `companionId` (the prop already exists;
    voice-mode knows which companion it's running for).

- `package.json` — version 3.3.0 → 3.4.0.
- `android/app/build.gradle` — versionCode 177 → 178,
  versionName "3.3.0" → "3.4.0".

**Unchanged:**
- `src/components/OpenWakeWordTrainer.tsx` — still
  per-companion via existing prop.
- `src/services/WakeTrainingModel.ts` — wake storage is
  already per-companion (no change needed).
- All wake-detection native code (`WakeWordModule.kt`).

## Behavior preserved

- Wake detection (v3.2.30 fix is intact): OWW with
  threshold from settings, 2s cooldown.
- Voice mode close paths (silence timeout + exit phrase
  match + gibberish detection + X button) — all still
  fire `playExitReply()` on close.
- Wake greeting + exit reply audio caching via desktop
  piper TTS (v3.2.29 + v3.1.48 combo) — unchanged.
- Active wake companion routing (`cyberclaw-active-wake-companion`)
  — still the source of truth for which .tflite the
  detector uses.

## Data model impact

For users upgrading from v3.3.0:
- Legacy `cyberclaw-exit-samples-<phrase>` keys still
  work on a downgrade. v3.4.0 copies them to per-companion
  keys on first launch.
- The active exit phrase (was `cyberclaw-voice-exit-phrase`)
  is migrated to `cyberclaw-exit-phrase-<activeWakeCompanion>`
  on first launch.
- Per-companion greetings/replies are NOT migrated (they
  were never per-companion to begin with — global fields).

For new users (no legacy data):
- First-time training creates `cyberclaw-exit-samples-<activeCompanionId>-<phrase>`
  immediately. No migration needed.

## Out of scope (deferred)

- Per-companion wake greeting / exit reply (currently
  global, just visually scoped to one companion).
- Per-companion silence timeout / match thresholds
  (currently global — applies to all companions).
- Native-side `WakeWordModule.deleteSavedModel` for
  cleaning up orphan .tflite files (still deferred from
  v3.3.0).
- The pre-existing TypeScript parse warning at
  `HomeScreen.tsx` line 2524 (pre-edit number) —
  unrelated to this release.
- A native-side API to set the OWW active companion
  explicitly (today HomeScreen reads
  `cyberclaw-audio-settings.wakeWord` and passes it to
  `WakeWordModule?.initOww(phrase, threshold)`. The
  active-companionId is implicit — `activeWakeCompanionId`
  is only used in the JS picker, not in the native OWW
  init. Multiple-companion detection in parallel is not
  supported).
- Delete of the legacy exit-phrase storage keys
  (deferred to v3.5.0+ once migration is confirmed
  working for all users).