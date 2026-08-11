# v3.10.156 — forward defaultQuestDir to desktop on quest create

## What

The mobile's "New quest" modal wasn't sending the user's
`defaultQuestDir` setting when creating a quest with no
explicit directory filled in. The desktop then auto-fell-
back to `~/quests/<sanitized-name>` instead of the user's
configured default, producing inconsistent behaviour
between the suggestion shown in the modal ("Suggested:
/projects/cyber-database") and where the file actually
landed ("/home/humpsuu/quests/cyber-database").

## Why

The mobile's `Settings → Default quest directory` lives in
`cyberclaw-mobile-settings` (AsyncStorage). The desktop
auto-derive logic in main.js (v3.2.89) reads a
`defaultQuestDir` field from the create_quest message
payload. The mobile was never forwarding it.

Tobe (2026-08-11) noticed the mismatch: a "Cyber_Database"
quest created from the mobile showed a "Suggested:
/media/humpsuu/CYBERDRIVE/2B/work/projects/CyberDatabase"
hint, but tapping Save with the input empty meant the
desktop's empty-input fallback kicked in and scaffolded
to `~/quests/cyber_database` instead.

## Files changed

### `src/screens/QuestsScreen.tsx`

- In the createQuest path (editor modal Save with
  `!editorOpen.id`), read `defaultQuestDir` from
  AsyncStorage.cyberclaw-mobile-settings and forward it
  on the `createQuest` call alongside `name`,
  `description`, `goals`, `directory`.

### `src/services/SyncClient.ts`

- `createQuest` signature extended to include the
  optional `defaultQuestDir` field. Wire-message shape
  unchanged from the desktop's POV (it just adds a
  previously-optional key).

## Desktop-side companion

This change is paired with cyberclaw v3.2.89, which:
- Added `resolveQuestDirectory()` helper in main.js.
- IPC handler `quests:create` and WS sync-server
  `onCreateQuest` both call the helper before scaffolding
  when no explicit directory is supplied.
- Renderer's `window.createQuest` forwards
  `defaultQuestDir` from `localStorage.cyberclaw-settings`.
- Mobile's `QuestsScreen` (this release) does the same
  with `cyberclaw-mobile-settings`.

Resolution order on the desktop:
1. Explicit `quest.directory` if provided
2. Caller-supplied `defaultQuestDir` + `/<sanitized-name>`
3. `~/quests/<sanitized-name>` fallback

## Pre-existing data

The stuck `Cyber_Database` quest from v3.10.155 testing
was manually repaired:
- quests.json updated to set `directory:
  /home/humpsuu/quests/cyber_database`
- INSTRUCTIONS.md + CONVERSATION.md scaffolded at that
  path
