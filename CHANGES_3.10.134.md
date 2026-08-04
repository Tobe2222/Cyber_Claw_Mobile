# v3.10.134 — Quest editor cleanup: directory field, complete toggle, steps bug

Four fixes from Tobe's 2026-08-04 13:58 round of feedback,
all in the Quest editor / QuestsScreen / SettingsScreen:

## 1. Steps entered when creating a quest were silently dropped

**The bug.** When the user tapped "+ New" on the Quests
screen, the editor opened with `goals: []` (an empty
stub), then the user typed in steps, then tapped Save.
The save handler in QuestsScreen took the `editorOpen`
object as its source-of-truth for the create path
(loading `goals` from there, not from the editor's local
state). Result: the user's freshly-typed steps never made
it into the wire payload.

**Concrete repro:** Tobe created "Seed_Signer" with
description, typed several steps, tapped Save. The
quest landed with `name` and `description` but
`goals: []`. Confirmed by inspecting
`~/.openclaw/cyberclaw/quests.json` post-create:

```
- Seed_Signer  status=active  active=True  goals=0
```

vs. the four pre-existing quests whose steps count
shows correctly (CYBERHIVE_WEBSITE V3 has 4, HIVE_CONTROL
has 2, etc.).

**The fix.** Switched the create path to read `updates.goals`
(the editor's cleaned-and-trimmed array) instead of
`editorOpen.goals`. The two paths (`create` for new
quests, `update` for existing) now share the same source
of truth and both include the directory field (see #3
below).

**Lesson (general).** When a form has local state that
diverges from props, decide which is the "live" source
at save time and use ONLY that one. The pattern of
"props for initial values, state for live edits" is
fine; the bug here was that the create path reached
back to props for the save payload while the update
path used state. Mixed sources = mixed saves.

## 2. Status (Active/Completed) toggle removed from the editor

**Tobe:**
> "We dont need to have that status active or complete
> there, we can just add a complete sign in the quest
> overview right beside the delete Instead."

**The fix.** Dropped the Status row from the QuestEditor's
JSX (the row that had ⚔️ Active / 🏁 Completed
chips). The editor's local `status` state was already
removed (it's now read-only on the prop, used only for
display downstream). Status is now mutated exclusively
from the **card list** via the new complete toggle
(see #4 below).

**Lesson.** The editor was carrying UI for state that
made sense only on the card (active ≠ completed; a
quest is "active" when starred, "completed" when
finished). Mixing them in one place produced two
redundant controls and a confused UX (Tobe's
v3.10.74 screenshot had `status: 'active'` on the
editor AND the ACTIVE badge on the card, and they
meant different things). Each UI surface should
control only the state it visually represents.

## 3. Project directory field added to the create flow

**Tobe:**
> "Perhaps we should add a quest directory in the
> settings, and when a new quest is created the user
> creates a new directory within the specified quest
> directory, with the name of the quest, or the user
> can select an existing directory."

**The fix.** Three pieces:

1. **Settings → Quests section.** A new "Default quest
   directory" field (free-text, monospace, with a Save
   button) is added to SettingsScreen. Stored under the
   existing `cyberclaw-mobile-settings.defaultQuestDir`
   JSON key, alongside the other settings in that
   screen. Empty by default.

2. **Quest editor for new quests.** A "📁 Project
   directory" field below Description, with a
   placeholder ("optional path on this device or remote
   host") and a pre-fill suggestion row that appears
   when the Settings field is set. The suggestion is
   computed as:
   ```
   <defaultDir>/<sanitized-quest-name>
   ```
   where `sanitized-quest-name` lowercases the name and
   strips non-`[a-z0-9._-]` characters. A "← Use"
   button next to the suggestion copies it into the
   input — the input itself starts blank so the user
   has to opt in (auto-filling would silently mkdir on
   the desktop even if the user only meant to rename).

3. **Existing quests.** The editor shows the current
   `quest.directory` as a read-only `📁 /path/to/dir`
   hint at the same spot, but does NOT let it be edited.
   Moving a quest's directory mid-flight would require
   relocating `QUEST_INSTRUCTIONS.md` and the per-quest
   conversation log file — out of scope for this
   release. Users wanting to relocate should
   delete-and-recreate.

4. **Wire-up.** `syncClient.createQuest({...})` now
   includes `directory` (trimmed; empty → undefined so
   the desktop doesn't store a stray empty string). The
   desktop's `onCreateQuest` handler was already wired
   to accept an optional `directory` field (v3.2.30 era
   work), so this is purely a mobile wire change.

**Tobe's picker ask.** "The user can select an
existing directory." A full mobile-native folder picker
would require either Android SAF (DocumentPicker native
module — adds a dependency) or having the desktop open
a native dialog and round-trip the path back through
the WS (extra IPC plumbing, sync state). v3.10.134 ships
the simpler path: a free-text field that the user can
type or paste. Path suggestions cover the common case
(creating a new project under a known root); an
explicit picker can come in a future release if Tobe
hits it.

**Folder picker as a future v3.10.135+ item.** The hook
is in place: `quests:pick-directory` IPC already exists
on the desktop (`dialog.showOpenDialog` +
`'openDirectory'`), and `cyberclaw.quests.pickDirectory()`
is already exposed on the preload bridge. Wiring it to
mobile takes a small WS round-trip
(`request_directory_pick` → desktop opens dialog →
sends `directory_picked` event with the path). Defer
until Tobe asks.

## 4. Complete (🏁) toggle button in the card action row

**Tobe:**
> "...we can just add a complete sign in the quest
> overview right beside the delete Instead."

**The fix.** New `🏁` (or `◻️` when open) button in the
QuestsScreen card-list action row, sitting between the
Set Active (`☆`) and Delete (`✕`) controls. Tap to
toggle the quest's `status` between `'completed'` and
`'active'`. Reuses `handleUpdateQuest(id, {status})`
which delegates to `syncClient.updateQuest` → desktop
`quests:update` (a plain `Object.assign`, accepts
partials). Visual:

- Open quest: muted `◻️` glyph
- Completed quest: orange-tinted `🏁` glyph with the
  orange brand background, so finished work is
  visible at a glance when scanning the list

## Files

- `src/screens/QuestsScreen.tsx`:
  - QuestEditorBody: removed `status` state +
    Status row, added `directory` and
    `directorySuggestion` state + directory-suggestion
    JSX. `updates` payload: dropped `status`, added
    `directory` for new quests (read-only display
    only for existing).
  - QuestsScreen main: fixed the create path to
    read `updates.goals` instead of `editorOpen.goals`
    (THE steps-vanish bug). Added `handleToggleComplete`.
    New `🏁` button in card action row, with new
    styles `cardCompleteBtnActive`,
    `cardCompleteBtnText`, `cardCompleteBtnTextActive`.
  - Six new style entries for the
    editor-suggestion-row / button / help-text.
- `src/screens/SettingsScreen.tsx`:
  - New `defaultQuestDir` state (hydrated from
    `cyberclaw-mobile-settings.defaultQuestDir` on
    mount).
  - New `saveDefaultQuestDir` helper (writes to the
    same JSON settings blob, atomic read-merge-write).
  - New "Quests" Section with the field, save button,
    and a hint box explaining the suggestion behavior.
- `package.json`: 3.10.133 → 3.10.134.
- `android/app/build.gradle`: versionName 3.10.134,
  versionCode 358.

## Verification

- TypeScript: 0 new errors introduced. The 6
  pre-existing errors in CompanionSettingsScreen /
  SettingsScreen are unrelated (imports for deleted
  exports, an `insets` narrowing issue, etc).
- ESLint: 0 new errors introduced. Pre-existing `_`
  catch-arg warnings untouched at the same line
  numbers post-shift (their line counts in the
  results shifted because I added lines above them,
  but the rule violations are unchanged from v3.10.133).
- Manual flow (post-push):
  1. Settings → Quests → set "Default quest
     directory" to `/tmp`
  2. Quests tab → + New → name: `Foo Bar Test`
  3. The suggestion should appear:
     "💡 Suggested: /tmp/foo-bar-test"
  4. Tap "← Use" → input becomes
     `/tmp/foo-bar-test`
  5. Add two steps: "Step one" + "Step two"
  6. Save → quest appears with both steps intact
     (the bug Tobe hit previously)
  7. Tap the new 🏁 button on the card → status
     flips to `completed`, the glyph turns orange
  8. Tap 🏁 again → un-completes

## What's intentionally NOT in this release

- **No folder picker.** "Select an existing directory"
  is genuinely useful but needs the WS round-trip
  plumbing (mobile → request → desktop opens dialog →
  response). Defer.
- **No existing-quest directory editor.** Mid-flight
  dir moves would need to relocate
  QUEST_INSTRUCTIONS.md and the conversation log file
  too. Defer to a future release if Tobe asks.
- **No reordering / grouping of completed quests.**
  Completed quests stay interleaved with active ones in
  the list — easiest mental model. A "Hide completed"
  toggle is a one-line addition if Tobe wants it.
