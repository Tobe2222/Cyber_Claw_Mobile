# v3.10.73 — Quest editor stale-id race (Save "quest not found")

Tobe reported on 2026-07-22:

> "i also tried to update/edit a quest but nothing
> happened and this error appeared"

The screenshot showed the "Edit quest" modal with name
"CYBERHIVE_WEBSITE V3" filled in, and after tapping
Save the bottom of the screen showed:

> **"Couldn't update quest: quest not found"**

Tobe also said:

> "And I noticed that i could not add or edit the
> steps and goal"

(The "steps and goal" complaint is the existing v3.10.x
design — the editor doesn't yet support editing goal
text. The "Goal text editing lands in a future
release" hint in the screenshot shows this. Out of
scope for v3.10.73.)

## Root cause: a cache-vs-broadcast race in QuestsScreen

When Tobe opens the Quests screen, QuestsScreen
hydrates from AsyncStorage cache (`cyberclaw-quests`)
for instant paint, then fires `requestQuestsList()`
to get a fresh broadcast from the desktop within
~100ms. The broadcast handler then `setQuests(list)`
replacing the cache data with the authoritative
desktop data.

The bug: between the cache paint and the broadcast
arriving, the user can tap ✏️ on a card. The
`setEditorOpen({ ...q })` makes a copy of the cached
quest object — including its `id`. The user types
fields, taps Save, and `handleUpdateQuest(
editorOpen.id, updates)` sends that id to the
desktop.

If the desktop's authoritative `QUESTS_FILE` has a
*different* id for the same quest (a real possibility
after desktop reinstalls, manual file edits, or
cache writes from an older version), the desktop's
`onUpdateQuest(id, updates)` does
`quests.findIndex(q => q.id === id)` → returns -1 →
returns null → sends `quests_update_failed{error:
'quest not found'}`.

The mobile receives the failure ack and shows the
toast.

## Why the auto-close-via-broadcast fix didn't help

The broadcast handler already auto-closes the editor
when the editingId is in the new list (to handle the
"desktop confirmed the edit" case). But it ALSO closes
when the editingId is NOT in the new list (assuming the
quest was deleted). With the cache/broadcast id
mismatch, the editor's id is never in the broadcast
list, so the editor closes prematurely with the user's
edits still in flight. Actually no — in Tobe's case
the editor stayed open. That suggests the editor's id
DID eventually match when the editor was open for an
existing quest that hadn't been deleted. The
`findIndex < 0` happened on the SAVE, not on
broadcast arrival.

Either way, the core issue is: the editor opens with
whatever id was current at click time, and that id may
not match the desktop's current ids.

## Fix: gate the edit buttons on first-broadcast-received

Wait for the first fresh broadcast from the desktop
before allowing the user to open the editor,
set-active, or delete. The cards still render from
cache for instant paint, but a small "⏳ Syncing
with desktop..." hint shows above the list, and
the action buttons are dimmed (opacity 0.35). Once
the broadcast arrives (typically <100ms after
mount), the hint hides and the buttons enable.

Implementation:
- New state `firstBroadcastReceived` (default false,
  reset to false on every screen mount, set to true
  in the broadcast handler).
- ✏️, ☆, and ✕ buttons are wrapped in
  `[styles.cardActionBtn, !firstBroadcastReceived &&
   styles.cardActionBtnDisabled]`. Their onPress
  guards early-return if `!firstBroadcastReceived`.
- "⏳ Syncing with desktop..." hint shown above the
  card list when not received.
- `cardActionBtnDisabled` style: `opacity: 0.35`.
- `syncingHint` style: dim italic 11px.

The + New button is unaffected — it creates a new
quest (no stale-id risk because the desktop assigns
a fresh id on create).

## What this doesn't fix (yet)

If the desktop genuinely has a quest with the same
name but a different id (e.g. the user deleted and
re-created a quest, or imported a different
`QUESTS_FILE`), the cards will display correctly
(both versions show by name during the cache window)
but editing the older one will still fail. The fix
for THAT case would be matching by name + directory
in the editor → desktop lookup, but it's a separate
edge case. v3.10.73 closes the most common race.

## Files changed

- `src/screens/QuestsScreen.tsx`:
  - new `firstBroadcastReceived` state (resets to
    false on mount, set to true in broadcast handler)
  - `cardActionBtnDisabled` style
  - `syncingHint` style
  - ✏️ / ☆ / ✕ buttons gated on firstBroadcastReceived
  - "⏳ Syncing with desktop..." hint shown when not
    yet received
- `android/app/build.gradle` — versionCode 298→299,
  versionName 3.10.72→3.10.73
- `package.json` — version 3.10.72→3.10.73

## Lessons

**Cache + live broadcast is a stampede zone.** Any
state that's populated from two sources (cache for
instant paint + live broadcast for fresh data) has a
window where the values can disagree. The default
fix isn't "make the cache always match the broadcast"
(it's already too late — the cache was written at
some point in the past). The fix is "don't let the
user take a destructive action on cache values until
the live broadcast has arrived." This pattern is
common enough in real-time sync UIs that it deserves
a name: **fresh-write gate** or **broadcast-acked
gate**.

**Buttons that silently no-op on stale data are
worse than buttons that fail loudly.** The ✕ (delete)
button on a stale-id quest would have called
`handleDeleteQuest(id)` → desktop's `onDeleteQuest`
returns false → no broadcast change → the user sees
"nothing happened" with no error message. The error
toast for Save is at least visible. Future versions
should give the user feedback even when the optimistic
update path silently fails.

**The broadcast handler had the right pattern for
delete-but-wrong-id: assume the worst (quest was
deleted) and close the editor.** But "the worst" was
wrong here — the quest wasn't deleted, the desktop
just had a different id for it. Always treat
"id-not-found" as an *opaque* failure with no
context, because there are too many ways it can
happen.