# v3.3.0

## Settings UI refactor: Wake + Exit as parallel groups

The "Wake Word" section was a grab bag: background listening,
match thresholds, a single "train with AI" button, a single
"train exit phrase" button, wake greeting, exit reply, voice
mode loop controls (silence timeout + active exit phrase), and
audio buffer settings. Tobe asked for a parallel structure —
Wake as one group, Exit as another, each with the same internal
shape.

After v3.3.0:

```
🎤 Wake settings
   Background listening (existing toggle)
   Wake greeting     [TextInput — at top, per user request: "in top since this will just be 1 of"]
   Wake phrases
     [list of per-companion rows + active selector + 🎙 retrain + 🗑 delete]
     [+ Train wake phrase for new companion]
   Match thresholds (foreground/background)
   Audio buffer

🚪 Exit settings    [NEW SECTION]
   Exit reply       [TextInput — mirrors wake greeting]
   Exit phrases
     [list of trained phrases + active selector + 🎙 retrain + 🗑 delete]
     [+ Train new exit phrase]
   Silence to end turn (existing Voice mode loop control)
```

Each group has **the same shape**: response (top) → list of
trained phrases with active selector + per-row actions → train
button → advanced controls (bottom).

## What's new in this release

### Per-row actions on trained-phrase lists

Both the **Wake phrases** and **Exit phrases** lists now have
`🎙` (retrain) and `🗑` (delete) buttons on each row, in
addition to the existing tap-to-select behavior.

- Retrain: opens the trainer modal pre-loaded with the
  existing phrase for that row, so the user can re-record
  samples without re-typing.
- Delete: confirms via Alert, then removes the AsyncStorage
  key (`cyberclaw-wake-samples-<companionId>` for wake,
  `cyberclaw-exit-samples-<phrase>` for exit). For wake,
  the active selection moves to null if the deleted
  companion was active.

### Active wake companion is now user-routable

There's a new `cyberclaw-active-wake-companion` AsyncStorage
key that records which companion's wake model is currently
feeding the OWW detector. Tapping a row in the Wake phrases
list makes it active and writes its phrase to
`cyberclaw-audio-settings.wakeWord` (which HomeScreen already
reads). This was implicit before (whatever was last trained
became active); now it's explicit and routable from the UI
without retraining.

### Trainer modals accept presetPhrase

Both `OpenWakeWordTrainer.tsx` and `ExitPhraseTrainer.tsx`
now accept a `presetPhrase?: string` prop. When set, the
trainer's TextInput initializes with this string instead of
the default (previously `hey ${companionName}` for wake,
`'thanks'` for exit). Used by per-row Retrain.

### Exit settings: new section, parallel structure

The exit-related controls (exit reply TextInput, exit
phrase picker, train-new button, silence-to-end picker)
moved out of "Wake Word" and into their own "🚪 Exit
settings" section, parallel to "🎤 Wake settings". No
behavior change to exit detection or storage keys.

## What's removed from this release

The pre-v3.3.0 inline "Wake greeting" + "Exit reply"
TextInputs that were mixed into the Wake Word section are
re-placed inside their respective parallel sections. The
"Voice mode loop" section header is gone — its content
moved to "🚪 Exit settings" (silence-to-end picker) or to
the inline "Active exit phrase" picker that is now part
of the Exit phrases list.

## Files

**Modified:**
- `src/screens/SettingsScreen.tsx`:
  - Replaced the single "🎤 Wake Word" section with two
    parallel sections ("Wake settings" / "Exit settings").
  - File-top comment updated to reflect new section list.
  - New `WakePhrasePicker` function: lists trained
    companions with per-row retrain + delete actions,
    active selector, empty-state hint.
  - `TrainedPhrasePicker` extended (not replaced) with
    optional `onRetrain` / `onDelete` props. Behavior
    unchanged when these are omitted (preserves the
    v3.2.27 row shape).
  - New state: `activeWakeCompanionId`, `editingWakePhrase`,
    `editingExitPhrase`.
  - New AsyncStorage keys: `cyberclaw-active-wake-companion`.
  - New styles: `trainedPickerActions`,
    `trainedPickerActionBtn`, `trainedPickerActionIcon`,
    `trainedPickerCompanionEmoji`, `trainedPickerPhrase`.
- `src/components/OpenWakeWordTrainer.tsx`:
  - `Props` adds optional `presetPhrase?: string`.
  - Initial state for `wakePhrase` uses
    `presetPhrase ?? \`hey ${companionName}\``.
- `src/components/ExitPhraseTrainer.tsx`:
  - `Props` adds optional `presetPhrase?: string`.
  - Initial state for `phrase` uses
    `presetPhrase ?? DEFAULT_PHRASE`.
- `package.json` — version 3.2.30 → 3.3.0.
- `android/app/build.gradle` — versionCode 176 → 177,
  versionName "3.2.30" → "3.3.0".

**Unchanged:**
- All wake detection logic (`WakeWordModule.kt` and
  JavaScript wrapper).
- All exit detection logic (`VoiceSettings.ts`,
  `ExitPhraseTrainer.tsx` body, `WakeModeScreen.tsx`).
- All storage keys (only ADDED
  `cyberclaw-active-wake-companion`).
- Desktop `sync-server.js` — no desktop-side changes
  for this release.
- All v3.1/v3.2 features (greeting, exit reply audio
  cache, etc.) continue to work as before.

## Behavior preserved

- Wake detection still uses the OWW native detector with
  the threshold from settings, the 2s cooldown, and the
  per-companion .tflite model. The only thing v3.3.0
  changes is which .tflite is active — the user can now
  pick one explicitly in Settings instead of having
  whatever was last trained be active by default.
- Exit detection still uses the text-match fallback
  (`ExitPhraseMatcher`) on `cyberclaw-voice-exit-phrase`
  + the trained samples for in-audio-stream matching
  (when the runtime detector is wired). No change.
- Wake greeting / exit reply audio caching via the
  desktop piper TTS still works (v3.2.29 + v3.1.48
  combo). The TextInputs are in new locations but the
  storage keys + flow are unchanged.

## Out of scope (deferred)

- Per-companion wake greeting (one greeting per
  trained wake phrase). Today the greeting is global;
  v3.3.0 doesn't change that.
- Per-companion exit reply. Same logic — global for now.
- Search/filter for long lists of trained phrases.
- Animation for active-row state transitions.
- A native-side `WakeWordModule.deleteSavedModel` API to
  clean up `.tflite` files when JS removes the
  per-companion wake samples key. Today the .tflite
  file is left in place on `filesDir/wake_models/`;
  harmless but accumulating. Future cleanup pass.
- The pre-existing TypeScript parse warning at
  `HomeScreen.tsx` line 2524 (pre-edit number) —
  unrelated to this release.
