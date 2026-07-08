# v3.8.1 — Quests: hide ⭐ on active card, add "+ New Quest" button

Tobe's v3.8.0 feedback:
- "We dont need the star do we? It says active in the top
  of the quest." — the ⭐ button on the already-active card
  is redundant; the gold border + ACTIVE banner already make
  it obvious.
- "And we need a add quest button there also." — needs a
  "+ New Quest" affordance somewhere on the screen.

This release fixes both. Small UI-only change, no wire
protocol additions (the `create_quest` message and the
`createQuest` SyncClient method were already shipped in
v3.8.0 / desktop v3.1.51; the UI was just missing the
button to invoke them).

## What changed

### 1. Hide ⭐ on the active card

The ⭐ button is now hidden on quests that are already
`active: true`. The gold border + ACTIVE banner already
convey "this is the working quest" — the star button
would be a no-op (tapping it would just re-set the same
quest as active).

The empty star `☆` is still shown on inactive cards so
the user can promote them to active. Once a quest is
active, the star disappears; the only way to deactivate
is to star a different quest.

(Future v3.8.x: a "☆" on the active card that toggles it
off would be a nice deactivation shortcut. Deferred for
now — the user said "we dont need the star" which I read
as "the star is redundant on the active card," not "I
want a way to deactivate.")

### 2. "+ New Quest" button in the header

A small orange-outlined button in the top-right of the
Quests screen header, next to the "← Back" / "📜 Quests"
title. Tapping it opens the editor modal in "new" mode
(empty fields).

The editor handles the new-quest flow:
- Title changes to "➕ New quest"
- Delete button is hidden (nothing to delete yet)
- Save sends `create_quest` to the desktop with the form
  values
- The next `quests_list` broadcast replaces the state
  with the new quest (desktop assigns the id); the editor
  auto-closes

The auto-close logic uses a new `creatingNewRef` so the
broadcast handler can detect "I was creating a new quest"
and close the editor on the next broadcast. The existing
logic that matches an id still works for edits and
deletes.

### 3. Updated text in the sectionDesc and About footer

The text under the "Quests" heading still said
"Edit / add / delete on the desktop; the phone updates
automatically" and the "About quests on mobile" footer
still said "Editing / creating / deleting happens on the
desktop for now." Both are now wrong (v3.8.0 lets you
do all three on the phone). Updated to:

- sectionDesc: "Synced from the desktop's Quests panel.
  The active quest (the one the companion is working on)
  is marked with a ⚡ ACTIVE badge and a gold border. Tap
  the actions below a card to set it active, edit it, or
  delete it. The phone edits round-trip to the desktop
  in real-time."

- About: "Phone edits (name, description, status, set
  active, delete, mark goal done) round-trip to the
  desktop in real-time."

### 4. Stale "Goal text editing lands in v3.8.1" hint

The editor's hint text said "Goal text editing lands in
v3.8.1. For now, tap a goal in the detail modal to mark
it done." Now that we're in v3.8.1, the hint is even more
out of date. Updated to: "Goal text editing lands in a
future release. For now, tap a goal in the detail modal
to mark it done." (Goal text editing — add/remove/rename
goals — is still on the v3.8.x roadmap but not in v3.8.1.)

## Files touched

- `src/screens/QuestsScreen.tsx` (header button, hidden
  star, conditional delete in editor, creatingNewRef,
  updated text)
- `package.json` (3.8.0 → 3.8.1)
- `android/app/build.gradle` (versionCode 215 → 216)

## Not touched

- Desktop code — no changes. v3.1.51 already supports
  `create_quest`; the v3.8.0 mobile added the SyncClient
  method; v3.8.1 just adds the button that calls it.
- Wire protocol — no new messages. `create_quest` is the
  existing v3.8.0 / v3.1.51 message.
- Desktop UI — no changes.

## Deferred

- **Deactivate via star** — the ⭐ on the active card is
  hidden for now. Future v3.8.x: a star on the active card
  that toggles it off.
- **Goal text editor** — add/remove/rename goal rows in
  the editor modal. Currently the only way to edit goals
  is on the desktop.
- **Android directory picker** — picking a project
  directory when creating a quest from the phone. The
  `createQuest` SyncClient method accepts a `directory`
  field but the editor doesn't expose a picker yet (you
  can paste a path string in the description if you
  really want to).
