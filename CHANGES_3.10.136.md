# v3.10.136 — Settings polish + CYBERCLAW.md editor + quest directory editing

Five changes from Tobe's 2026-08-04 17:31 Discord round:
1. Save button feedback ("✓ Saved")
2. Example moved above the input
3. Generic placeholder (not Tobe's real path)
4. CYBERCLAW.md editor in Settings (new section)
5. Quest editor: directory always shown + editable + re-suggests on existing quests
6. Quest detail modal: directory row added

## Settings: visible save feedback

The Save button next to "Default quest directory" now
flashes `✓ Saved` for 2 seconds after a successful save.
Driven by a `Date.now()` timestamp in state — no
setTimeout, just a derived `Date.now() - savedAt < 2000`
in the render. Tobe 2026-08-04 17:31: 'no indication
that it saved or not.'

## Settings: example ABOVE the input

The path-example block (`💡 /path/to/your/projects/ ↳
seed-signer/ ↳ cyber-music-v2/`) moved from below the
Save button to directly above the TextInput. Per
Tobe 2026-08-04 17:31: 'it should be better, suggestions
and example right above.'

The concrete path was also genericised: the previous
example showed `/media/humpsuu/CYBERDRIVE/2B/work/projects/`
(Tobe's actual disk layout). Now it's the abstract
`/path/to/your/projects/` so we don't leak Tobe's
real home-dir layout into other users' builds. Per
Tobe 2026-08-04 17:31: 'dont use my directory as text
example.'

The placeholder for the input itself also changed from
`/media/humpsuu/CYBERDRIVE/2B/work/projects` to the
generic `/path/to/your/projects`.

## Settings: CYBERCLAW.md editor (new section)

A new "CYBERCLAW.md" Section in Settings, between
"Quests" and "About footer", gives the user read + write
access to the overarching system prompt
(`~/.openclaw/cyberclaw/CYBERCLAW.md` on the desktop).

The editor ships with:
- A red-bordered warning box at the top:
  "⚠️ Editing this changes how every companion thinks"
  + an explanation that mistuned prompts can break
  companion behaviour + a Reset button to recover.
- The desktop file path (selectable text) so the user
  can verify where the file lives.
- A multi-line monospace TextInput pre-loaded with the
  current content.
- `💾 Save` (pushes back to the desktop) and
  `↺ Reset to default` (unlinks the user's file so the
  shipped default takes over; the "reset" button
  requires a second tap within 5s as a double-confirm).
- A `✓ Saved` badge that flashes for 2 seconds after a
  successful save.
- Tobe's suggested bullet list as a hint ("Here are the
  topics the cyberclaw.md should cover..."):
  - How to create a quest (mkdir + INSTRUCTIONS.md +
    CONVERSATION.md)
  - How pictures are seen (data URI, attached file)
  - Check the quest directory files (INSTRUCTIONS.md,
    CONVERSATION.md, memory) before replying
  - Always reply on CyberClaw if spoken to

The mobile is editor-only — the desktop's
`~/.openclaw/cyberclaw/CYBERCLAW.md` is the canonical
file. Every change round-trips through the WS:
`request_cyberclaw_system` → desktop reads +
shipped-default + path → reply → mobile displays.
`save_cyberclaw_system` → desktop writes →
`cyberclaw_system_saved` ack → mobile flashes ✓.
`reset_cyberclaw_system` → desktop unlinks → fresh
`cyberclaw_system` event with the default content.

Tobe 2026-08-04 17:31:
> "did we have a cyberclaw md also, outside of
> companions? If not we should have it in the
> settings (editable with a warning that this might
> break the companions behaviour), this tells the
> agent that we are talking within cyberclaw, what
> cyberclaw is and how to behave/response/do things,
> like, - we create a quest like this: create a
> directory with quest instructions etc. - Pictures
> are seen like this, - check quest directory
> conversation file, memory, before reply - always
> reply on cyberclaw if spoken to here."

### Behaviour notes
- Saving does NOT restart the desktop. The new content
  takes effect on the NEXT chat send because
  `assembleContext()` reads the file every time (it has
  no in-memory cache).
- Reset to default removes the user's file and re-fetches
  the shipped default into the textbox. The user can
  then save (writes the default in place of nothing) or
  just close (the default sticks because the FS has no
  override file).
- Re-fetch on WS reconnect — if the user opens Settings
  while the phone is reconnecting, the listener fires when
  the WS comes back. Fires once on mount too
  (`fireFetch()` inside the useEffect).

## Quest editor: directory always visible + editable

The 📁 Project directory input is now visible AND
editable for BOTH new and existing quests. Previously
(`v3.10.134`):

- New quests: showed a directory input. ✓
- Existing quests without a directory: hidden entirely.
- Existing quests with a directory: read-only hint.

Now (`v3.10.136`):

- New quests: blank input + "← Use" suggestion chip.
- Existing quests: pre-filled with current
  `quest.directory` so the user sees what's currently
  in use. Editing the value + Save triggers a `mq`
  side-effect on the desktop: `quests:update` detects
  the directory CHANGE and re-scaffolds the new
  directory (mkdir + write INSTRUCTIONS.md placeholder
  + CONVERSATION.md placeholder). Files do NOT migrate
  — moving the directory is the right user signal that
  the quest is now about a different folder.
- Suggestion chip is visible whenever the suggestion
  differs from the current value. Fires for new AND
  existing (a one-tap way to "swap to the auto-default
  from Settings" without re-typing).

The wire format: `updates.directory` is now always
present in the save payload (new + existing). For new
quests, `undefined` means "no directory" (the desktop's
existing default). For existing quests, sending the
current value triggers the desktop's no-op branch; a
different value triggers the re-scaffold.

Tobe 2026-08-04 17:31:
> "Tried to edit a quest, its directory is not shown
> and should be editable. Here we potentially need to
> move and/or create new directories for the user."

## Quest detail modal: directory row

Tapping a quest card opens the detail modal, which now
shows a "📁 Project directory" section between
Description and Quest instructions. Three cases:

- Quest has a directory → monospace path, "(tap to edit)"
  inline hint. Tap → opens the editor for the same quest.
- Quest has NO directory → italic "(no directory — tap to
  set)" + tap → editor. Useful for migrating legacy
  quests that never had a directory.

Tobe 2026-08-04 17:31:
> "And in the inspect or Click on the quest the
> directory should be shown there too."

Three new styles: `modalDirectoryText` (monospace),
`modalDirectoryEditHint` (italic muted), and
`modalDirectoryEmpty` (italic muted for the missing
case).

## Files

### Mobile

- `src/screens/SettingsScreen.tsx`:
  - New state: `defaultQuestDirSavedAt`,
    `cyberclawContent`, `cyberclawDefaultContent`,
    `cyberclawPath`, `cyberclawLoading`,
    `cyberclawSaving`, `cyberclawSavedAt`,
    `cyberclawResetConfirming`.
  - New handlers: `loadCyberclawSystem`,
    `saveCyberclawSystem`, `resetCyberclawSystem`.
  - New WS listener for `cyberclaw_system` event
    (with cleanup in `useEffect`'s return).
  - Quests section reordered: example above input,
    generic placeholder, ✓ Saved badge after a
    successful save.
  - NEW section "CYBERCLAW.md" with warning box,
    file path, TextInput (multi-line monospace),
    Save + Reset buttons, ✓ Saved badge, Tobe's
    suggested-topic hints.

- `src/screens/QuestsScreen.tsx`:
  - QuestEditorBody directory block: now always
    visible + editable (was new-quest-only). Three
    JSX variants share one block, with isNew-aware
    help text.
  - `useState` for `directory`: pre-fills with
    `quest.directory` for existing quests (was blank
    for all).
  - `useEffect` that computes the suggestion: now
    runs for both new AND existing (no early-return
    for `!isNew`).
  - `onSave`'s `updates` payload: `directory` is now
    always sent (trimmed, or undefined if blank).
  - QuestDetailBody: new "📁 Project directory"
    section between Description and Quest instructions.
    Tap → opens editor (uses existing `onEdit`
    callback). Three new styles.
  - Removed the legacy read-only "📁 {quest.directory}"
    block that only showed for existing-with-directory.

- `src/services/SyncClient.ts`:
  - Three new methods: `requestCyberclawSystem`,
    `saveCyberclawSystem(content)`,
    `resetCyberclawSystem`. Wire-only — no UI.

- `package.json`: 3.10.135 → 3.10.136.
- `android/app/build.gradle`: versionName 3.10.136,
  versionCode 360.
- `CHANGES_3.10.136.md`.

### Desktop (companion to this release)

- `src/main.js`:
  - `quests:update` IPC: detects a `directory` change
    and re-scaffolds the new directory. No-op when the
    new directory equals the existing one. Empty
    string clears the directory (falls back to the
    v3.2.30 id-based path on next read).
  - Three new SyncServer callbacks for the CYBERCLAW.md
    round-trip:
    `onGetCyberclawSystem`,
    `onSaveCyberclawSystem`,
    `onResetCyberclawSystem`. Each wraps the existing
    `system:*` IPC handlers and returns the same shape.
- `src/sync-server.js`:
  - Three new SyncServer callbacks (`onGet/Save/Reset
    CyberclawSystem`) wired onto `this`.
  - Three new WS cases:
    `request_cyberclaw_system`,
    `save_cyberclaw_system`,
    `reset_cyberclaw_system`. The reset case also
    pushes a fresh `cyberclaw_system` event after the
    ack so the mobile can update its textbox.
  - `system:get/cyberclaw`, `save-cyberclaw`,
    `reset-cyberclaw` IPCs were already there since
    v3.2.32 — this release wires mobile access to
    them.
- `package.json`: 3.2.61 → 3.2.62.
- `CHANGES_3.2.62.md` (separate file).

## Verification

- TypeScript: 0 new errors introduced. Pre-existing
  errors in CompanionSettingsScreen / SettingsScreen
  (`RemotePermissions`, `setVoiceLocalId`, `insets`)
  are unchanged.
- ESLint: pre-existing 33 errors unchanged. 8 new
  inline-style warnings on the new CYBERCLAW.md
  section (intentional — inline styles are easier to
  read next to the JSX than via a StyleSheet.create
  lookup three hundred lines away).
- `node -c` on desktop main.js + sync-server.js: clean.
- Manual flow (post-push):
  1. Settings → Quests → "Default quest directory"
     Save button now shows "✓ Saved" for 2s.
  2. Settings → CYBERCLAW.md section → "↺ Reset to
     default" → tap-tap-confirm → textbox fills with
     the default content (the shipped one).
  3. Type a custom line. "💾 Save" → file updates.
  4. Quests → tap a card → detail modal now shows
     "📁 Project directory /path/foo" with a tap-to-
     edit hint.
  5. Tap → editor opens, directory field pre-filled
     with the current value, editable.
  6. Save a different path → desktop mkdir's the new
     dir + writes INSTRUCTIONS.md + CONVERSATION.md.
  7. `ls /new-path/` shows the two new files. Old
     dir untouched.

## What didn't change

- Quest `directory` field stays optional on the quest
  model. Empty string = unset; `undefined` = unset
  (the desktop's existing default for new quests
  stays the same).
- Quest status toggle: still on the card list, not
  in the editor.
- Quest instructions file (`QUEST_QUEST_INSTRUCTIONS.md`
  legacy / `INSTRUCTIONS.md` v2): unchanged. The mobile
  gain a directory INPUT for editing; the file itself
  still lives at `<quest.directory>/INSTRUCTIONS.md`
  (or the id-based fallback).
- Soul / per-companion memory editing flow: unchanged.
  CYBERCLAW.md is a SEPARATE file above the per-companion
  layer. Reading order on every chat: CYBERCLAW.md →
  soul.md → memory.md → quest instructions + quest
  conversation log.
