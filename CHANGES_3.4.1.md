# v3.4.1

## Settings UI polish (per Tobe's feedback on v3.4.0)

Two layout tweaks:

1. **Top-level Voice mode:** group the "details" controls
   (audio buffer, silence timeout, match thresholds) under
   one "Background listening" sub-heading. The master toggle
   stays as-is at the top — it decides **whether** the
   microphone listens in the background, the grouped
   controls below decide **how**.

2. **Per-companion detail view:** reorder so all
   wake-related controls (greeting, phrases, train) are
   on top and all exit-related controls (reply, phrases,
   train) are on the bottom. The previous layout
   interleaved them (greeting → reply → wake phrases →
   exit phrases), which read as disorderly.

## What changed in this release

### Top-level Voice mode

```
🎤 Voice mode
  🎧 Background listening                       [master toggle]
  🎧 Background listening — details            [new SubTitle]
    Audio buffer (lookback + conversation timeout + retention)
    [Save audio settings]
    Silence to end turn: 3s
    Match thresholds (foreground / background)
  Companions                                    [list]
  🧠 Train wake phrase for new companion
```

Two things happened in v3.4.1:

1. **Physical re-order.** The three "details" sub-sections
   (Audio buffer, Silence to end turn, Match thresholds)
   used to live AFTER the Companions list + train-new
   wake button, making the Voice mode screen a tall
   mish-mash. They were physically moved up to sit
   immediately after the master toggle, so they form
   one grouped block under the new "Background listening
   — details" sub-heading.

2. **Visual demotion.** Within that block, the three
   sub-sections were demoted from `<SubTitle>` to
   `<Label>` so they read as nested under the new
   heading rather than competing with it for visual
   weight.

Mental model: master toggle above = **whether** the mic
listens in the background; the grouped details below =
**how** it listens when it is on.

### Per-companion detail view

```
<Companion> settings
  ← Back                              (header)
  Wake greeting                       [TextInput]
  Wake phrases                        [list with retrain/delete]
  🎤 Train new wake phrase for X      [train button]
  Exit reply                          [TextInput]
  Exit phrases                        [list with retrain/delete]
  🚪 Train new exit phrase for X      [train button]
```

Order rule: **wake-related on top, exit-related on the
bottom**. Each phase (wake / exit) has the same shape —
text input → list → train button — so they read as
parallel groups.

## What's unchanged

- All wake / exit detection logic.
- All storage keys (no data migration needed).
- All components (`WakePhrasePicker`, `PerCompanionExitPicker`,
  `OpenWakeWordTrainer`, `ExitPhraseTrainer`).
- Connection, Permissions, Voice & Speech, Agent Reach
  sections — unchanged.

## Files

**Modified:**
- `src/screens/SettingsScreen.tsx`:
  - File-top comment updated to v3.4.1 structure.
  - Top-level Voice mode:
    - Added "🎧 Background listening — details"
      `<SubTitle>` + `<Hint>` immediately after the
      master toggle.
    - **Moved** the entire Audio buffer + Silence to end
      turn + Match thresholds block up to sit under that
      new sub-heading (was: after the Companions list
      and train-new wake button). The block stays as
      one physical group.
    - Demoted the three inner sub-sections from
      `<SubTitle>` to `<Label>` so they read as nested
      under the new heading rather than competing with
      it.
  - `renderCompanionDetail()`: moved the Exit reply
    `<SubTitle>` + `<TextInput>` + save-hint block from
    between Wake greeting and Wake phrases to between
    Wake phrases and Exit phrases. No behavioral change,
    just order.

- `package.json` — version 3.4.0 → 3.4.1.
- `android/app/build.gradle` — versionCode 178 → 179,
  versionName "3.4.0" → "3.4.1".

**Unchanged:**
- All `src/services/*`, `src/components/*`,
  `src/screens/WakeModeScreen.tsx`.
- All native code.
- Desktop `sync-server.js`.

## Behavior preserved

- All storage keys: no migration.
- All wire-level state (`cyberclaw-bg-listening`,
  `cyberclaw-audio-settings`, `cyberclaw-voice-silence-ms`,
  `cyberclaw-wake-fg-threshold`, `cyberclaw-wake-bg-threshold`,
  `cyberclaw-ready-phrase`, `cyberclaw-exit-reply-phrase`,
  `cyberclaw-active-wake-companion`, `cyberclaw-exit-phrase-<cid>`,
  `cyberclaw-exit-samples-<cid>-<phrase>`,
  `cyberclaw-wake-samples-<cid>`) — unchanged.
- Wake / exit detection logic — unchanged.

## Out of scope (deferred, same as v3.4.0)

- Per-companion wake greeting / exit reply (currently
  global).
- Per-companion silence timeout / match thresholds
  (currently global).
- Native-side `WakeWordModule.deleteSavedModel` for
  cleaning up orphan .tflite files.
- Delete of legacy v3.3.0 exit-phrase storage keys.