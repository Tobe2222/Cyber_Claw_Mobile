# v3.10.173 — Skills Library: mobile mirror of the desktop sidebar

Pairs with desktop v3.3.0. The desktop got a Skills Library on the
left sidebar with creation, edit, delete, and per-companion toggle.
This mobile build mirrors the same library so Tobe can manage skills
from the phone, not just the desktop.

## What's new

- **New `SkillsScreen` (`src/screens/SkillsScreen.tsx`)** — a
  top-level screen, same pattern as `QuestsScreen`. Reachable from
  the home screen via the existing arena → settings → Skills
  route (or any future button) and via the `onOpenSkills` callback
  added to `App.tsx` and `HomeScreen`.

- **Per-companion enable/disable pills.** Top section of the
  Skills screen shows a row of pills, one per skill. Tap a pill to
  toggle that skill on/off for the active companion. Optimistic
  update on tap; the server response is just a confirmation.

- **Browse + create + edit + view.** List view shows skill cards
  (icon, name, description, trigger count). Tap a card → full
  markdown body view. Edit/Delete in the view modal. "+ New Skill"
  opens a form with name, icon, description, triggers, and body
  fields. Validation feedback (errors + warnings) is shown inline
  on save.

- **WebSocket protocol over the existing sync bridge.** All
  persistence is server-side — the mobile is a thin client. New
  request types: `request_skills_list`, `request_skill_read`,
  `create_skill`, `update_skill`, `delete_skill`,
  `seed_starter_skills`, `request_enabled_skills`,
  `set_enabled_skills`. Server replies with `skills_list`,
  `skills_list_broadcast`, `skill_read`, `skill_create_result`,
  etc. After every mutation the server broadcasts
  `skills_list_broadcast` to all clients so the desktop and any
  other connected phone refresh their list automatically.

- **Auto-seed on first connect.** The three desktop starter skills
  (`send-screenshots`, `deploy-via-pm2`,
  `manage-cybercomputer-services`) are seeded by the desktop
  server, not the mobile. If the mobile connects to a desktop
  with no skills yet, the user gets a "Seed Starter Skills"
  button in the empty state.

## Files touched

- `src/screens/SkillsScreen.tsx` — new (490 lines).
- `src/services/SyncClient.ts` — 8 new request methods +
  matching case-statements for server responses.
- `src/screens/HomeScreen.tsx` — added `onOpenSkills` prop +
  handler for arena `skills` message (mirror of the existing
  `quests` flow).
- `App.tsx` — added `skills` to the screen-state union, the
  `onOpenSkills={() => setScreen('skills')}` callback on
  `HomeScreen`, and the `<SkillsScreen>` route.
- `package.json` — version bump to 3.10.173.

## Out of scope

- Arena HTML still doesn't show a "Skills" button (only "Quests").
  The mobile can route via `onOpenSkills` from anywhere; the arena
  button is a follow-up.
- Skill images / attachments — skills are markdown-only. No image
  upload in the body yet.
