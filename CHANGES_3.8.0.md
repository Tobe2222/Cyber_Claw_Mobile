# v3.8.0 — Phone-side quest edit (basics)

Tobe: "yes we need edit ability on Phone" — greenlit the
v3.8.x series. This release ships the **mobile UI** half
of the v3.8.0 feature. The wire protocol + desktop back-end
shipped in **desktop v3.1.51**.

## What changed

### 1. New SyncClient methods (5 outbound)

`src/services/SyncClient.ts` adds:

- `setQuestActive(id)` — toggle a quest as the active one
- `updateQuest(id, updates)` — update fields (name, description, status)
- `deleteQuest(id)` — remove a quest
- `markQuestGoalDone(id, goalIndex, completed)` — toggle a goal
- `createQuest(quest)` — create a new quest (UI not yet shipped; v3.8.1)

Each method sends the appropriate WebSocket message to the
desktop. The desktop performs the mutation and broadcasts
the updated list (existing path) within ~100ms; the
mobile's `quests_list` handler replaces the local state
with the canonical data.

New inbound handler for `quests_update_failed` — surfaces
the error to the UI as a toast so the user knows the edit
didn't take (e.g. quest not found).

### 2. QuestsScreen: action row on each card

Every quest card now has a row of quick actions at the
bottom:

- **⭐ / ☆** — set as the active quest (toggles). Filled
  gold when active.
- **✏️** — open the editor modal (slides up from the
  bottom).
- **✕** — delete with a confirm dialog ("Delete quest?
  This can't be undone."). Red ✕ on the right.

The buttons are wrapped in their own `TouchableOpacity`s
so the touch is absorbed and doesn't bubble to the card's
onPress (which would open the detail modal).

### 3. Detail modal: tappable goal checkboxes

The goals list in the detail modal now has
`TouchableOpacity` rows. Tap a goal to toggle its
completed flag — the change goes straight to the desktop
via `markQuestGoalDone`. The new state appears in the
list within ~100ms (after the broadcast).

A new "✏️  Edit" button in the detail-modal footer opens
the editor (same action as the card's ✏️ button). The
existing "Close" button moves to the left side of the
footer, the new "Edit" to the right.

### 4. Editor modal (slides up from the bottom)

A new modal that opens when the user taps ✏️ on a card
or in the detail modal. The form is a ScrollView with:

- **Name** — single-line text input
- **Description** — multi-line text input
- **Status** — two chip-style toggles (⚔️ Active / 🏁
  Completed)
- **Active** — toggle that says "⚡ This is the active
  quest" when on, "☆ Set as active quest" when off

Bottom buttons:
- **Delete** (left) — red, opens the confirm dialog
- **Cancel** (middle right) — closes without saving
- **Save** (right) — primary orange, sends the update

The modal auto-closes when the desktop confirms the
update via the next `quests_list` broadcast (the handler
in the useEffect watches for the edited quest to appear
in the broadcast and calls `setEditorOpen(null)`).

If the quest was deleted (not just edited), the handler
also closes the detail modal if it was open for the same
quest.

A transient hint inside the editor says "Goal text
editing lands in v3.8.1. For now, tap a goal in the
detail modal to mark it done." This is the explicit
scope cut from the basics-first split.

### 5. Confirm dialog + error toast

Two new mini-UI elements:

- **Confirm dialog** — used for delete. Title + message
  + Cancel / Delete buttons. Red border on the card to
  signal "destructive action."
- **Error toast** — bottom of the screen, shows
  `quests_update_failed` messages from the desktop.
  Auto-dismisses when the user makes another edit
  (success) or taps × to dismiss manually.

### 6. Auto-close on broadcast confirm

The detail modal + editor modal both watch for the next
`quests_list` broadcast to close themselves. The pattern
uses `useRef` for `editorOpen` / `detail` so the handler
inside the `useEffect` (empty deps) can read the current
state without going stale. The `useEffect` body itself
updates the refs whenever state changes.

This is the cleanest way to handle the "wait for
confirmation" pattern without storing a separate
"pending edit" map. The downside is that any broadcast
of the same quest closes the editor, but in practice
the only way to get a broadcast of a quest is via the
desktop confirming an edit, so this is fine.

## Files touched

- `src/services/SyncClient.ts` (5 new outbound methods,
  1 new `quests_update_failed` case)
- `src/screens/QuestsScreen.tsx` (3 new state vars,
  4 new action handlers, refs for stale-closure fix,
  3 new modals: editor / confirm / error-toast,
  tappable goal checkboxes, action row on each card,
  ~25 new styles)
- `package.json` (3.7.10 → 3.8.0)
- `android/app/build.gradle` (versionCode 214 → 215)

## Companion release

- **Desktop v3.1.51** — wire protocol + 5 SyncServer
  callbacks. Already shipped.

## Deferred to v3.8.1

- "+ New Quest" button on the Quests screen header
- Android directory picker (Storage Access Framework)
- Goal text editor (add / remove / rename goals)
- Quest status auto-archive (auto-mark completed after
  all goals done)

## Why no optimistic updates

The mobile could optimistically update local state
immediately on user action (before the broadcast
arrives), making the UI feel "instant." The trade-off
is having to roll back on failure (e.g. desktop rejects
the edit because the quest was deleted concurrently).

For v3.8.0 the broadcast is fast enough (~100ms) that
the user perceives an instant change without the
optimistic update. The `quests_update_failed` handler
shows a toast on rejection, which is enough to know
something went wrong. If the v3.8.x series ever needs
optimistic updates (e.g. for offline support), the
handler structure is ready to add a `pendingEdits` map
that tracks in-flight requests and reconciles on
broadcast.

## Why refs for editorOpen / detail

The `quests_list` handler in the `useEffect` (with empty
deps) needs to read the current `editorOpen` / `detail`
state to know whether to auto-close. Reading state
directly inside the handler would give the stale initial
value (`null` for both) because the handler was
registered once. Refs are the standard pattern for this
case: the state setter updates the ref via a paired
`useEffect` (or via a ref-mirror pattern), and the
handler reads from the ref to get the current value.
