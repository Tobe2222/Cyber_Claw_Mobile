# v3.4.2

## Move training entirely into companion detail view

Tobe's feedback on the v3.4.1 build:

> "In the settings here, clicking the companion should
> open a new page for the settings of that companion, and
> the training button should be within that."

The v3.4.1 top-level Voice mode screen had a dashed-blue
"🧠 Train wake phrase for new companion" button sitting
below the Companions list. Tobe's point is that the
top-level screen should be a clean navigation surface:

```
🎤 Voice mode (top-level)
  🎧 Background listening        [master toggle]
  🎧 Background listening — details
    Audio buffer, Silence, Match thresholds
  Companions                      [list]
  (no global actions here)
       ↓ tap companion
<Companion> settings              [detail view]
  ← Back
  Wake greeting
  Wake phrases
  🎤 Train new wake phrase for X  ← training lives here
  Exit reply
  Exit phrases
  🚪 Train new exit phrase for X
```

Every action on a companion (training, retraining,
deleting, configuring) lives inside its detail view. The
top-level screen does navigation only — no per-companion
actions on it.

This means the "pick which companion to train" step
becomes redundant: tap the companion → detail → Train
button. So the companion picker modal is removed too.

## What changed in this release

### Removed: top-level "Train wake phrase for new companion" button

Was: dashed-blue `<TouchableOpacity>` at line ~1330 of
`SettingsScreen.tsx`, below the Companions list. Opened a
companion picker modal that let you select which
companion to train.

Gone. Tap a companion row in the list → detail view →
Train button there.

### Removed: companion picker modal + `showCompanionPicker` state

The `<Modal>` that wrapped the "Train wake word for…"
sheet + the `showCompanionPicker` state + the picker
backHandler guard are all removed. The modal had only one
caller (the now-removed top-level button).

The `useEffect` that previously re-ran on
`[showCompanionPicker]` to refresh `savedWakeModels`
from Kotlin SharedPreferences is re-keyed to
`[availableCompanions.length]` instead. Refreshes fire
when the companion list grows (when sync delivers new
agents), which is functionally equivalent — the picker
opening and the list growing were both proxy events for
"the user is interacting with wake training".

### Unchanged

Every per-companion feature in the detail view:

- Back button at top-left → returns to companion list.
- Wake greeting `<TextInput>` (auto-save).
- Wake phrases list (with retrain + delete per row).
- 🎤 Train new wake phrase for X (this companion's training launch).
- Exit reply `<TextInput>` (auto-save).
- Exit phrases list (with retrain + delete per row).
- 🚪 Train new exit phrase for X.

## Files

**Modified:**
- `src/screens/SettingsScreen.tsx`:
  - Removed the top-level "🧠 Train wake phrase for new
    companion" `<TouchableOpacity>` (was lines 1330-1355
    in v3.4.1).
  - Removed the entire companion picker `<Modal>` block
    (was at the bottom of the render).
  - Removed `const [showCompanionPicker, ...]` state.
  - Re-keyed the saved-wake-models refresh `useEffect`
    from `[showCompanionPicker]` to
    `[availableCompanions.length]`.
  - Kept `trainingCompanionId`, `trainingCompanionName`,
    `editingWakePhrase`, `showOwwTrainer` — the trainer
    modal is unchanged, still opens from the per-companion
    detail view.

- `package.json` — version 3.4.1 → 3.4.2.
- `android/app/build.gradle` — versionCode 179 → 180,
  versionName "3.4.1" → "3.4.2".

**Unchanged:**
- All `src/services/*`.
- All native code (`WakeWordModule.kt`,
  `OpenWakeWordTrainer.tsx`, `ExitPhraseTrainer.tsx`).
- All storage keys.
- All other SettingsScreen sections (Connection,
  Permissions, Voice & Speech, Agent Reach).
- v3.4.1 layout (Background listening grouping + wake-top
  / exit-bottom companion detail order) — preserved.

## Behavior preserved

- Wake detection (v3.2.30 fix + 2s cooldown).
- Voice mode close paths (silence timeout + exit phrase
  match + gibberish detection + X button).
- Wake greeting / exit reply TextInputs.
- Active wake companion routing
  (`cyberclaw-active-wake-companion`).
- Per-companion exit phrase storage (the v3.4.0 storage
  model — no v3.4.2 migration needed).

## Lesson

When you have a list + a per-item detail view, **don't
duplicate per-item actions at the list level.** A "Train
new X for any item" affordance on the list level adds an
extra click (pick which item) and competes with the
detail view's own affordance. Trust the detail view to
own the per-item actions; let the list be a router only.

Concretely: the v3.4.1 "Train wake phrase for new
companion" button at the list level opened a picker, but
a user could already tap a specific companion → "Train
new wake phrase for THAT companion" in one tap. The list-
level button saved you nothing; just added a UI surface
that needed its own state, modal, backHandler guard, and
fresh-effect gating.

## Out of scope (deferred, same as v3.4.0 + v3.4.1)

- Per-companion wake greeting / exit reply (still global).
- Per-companion silence timeout / match thresholds (still
  global).
- Native-side `WakeWordModule.deleteSavedModel` for
  cleanup.
- Delete of legacy v3.3.0 exit-phrase storage keys.