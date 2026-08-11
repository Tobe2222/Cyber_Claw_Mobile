# v3.10.157 — seed defaultQuestDir with desktop's projects folder

## What

Seed `cyberclaw-mobile-settings.defaultQuestDir` with
`/media/humpsuu/CYBERDRIVE/2B/work/projects` on first
launch of v3.10.157 so empty-input "New quest" creates
land alongside the rest of the projects. Idempotent —
only seeds if the user hasn't already configured their
own value.

Paired with cyberclaw v3.2.90 which sets the same path
as the desktop's system-wide `DEFAULT_QUEST_DIR` constant.

## Why

Tobe (2026-08-11) after the v3.10.156 fix: 'no i wanted
the quest dir in the projects folder, with the rest'.
With the v3.10.156 auto-derive wired, an empty directory
input still fell back to `~/quests/<name>` because the
mobile's `defaultQuestDir` setting was empty. The user
wants new quests to live next to their existing repos.

## Migration

Runs once on App.tsx mount. Reads
`cyberclaw-mobile-settings`, checks if `defaultQuestDir`
is set, writes the default if not. Logs to console for
diagnostics. Safe to run on every launch (idempotent).

## Desktop companion

cyberclaw v3.2.90:
- Added `DEFAULT_QUEST_DIR` constant in main.js
  (`/media/humpsuu/CYBERDRIVE/2B/work/projects`).
- Override via `CYBERCLAW_DEFAULT_QUEST_DIR` env var.
- `resolveQuestDirectory` uses it as the system-wide
  fallback when neither explicit nor caller-default dir
  is supplied.
- Existing `Cyber_Database` quest moved from
  `~/quests/cyber_database` to the projects folder to
  match the new default. Scaffold files preserved.
