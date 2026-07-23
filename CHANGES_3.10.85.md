# v3.10.85 — chat history shows which quest was active per message

Tobe reported on v3.10.84 (2026-07-23, ~13:00):

> "@Clawsuu good good. I was pondering about adding
> which quest each text in the chat is related to.
> Like it says yesterday it could also say which
> quests was/active when a text is sent in the chat.
> So when one switches it creates a new headline
> like yesterday is added above a text. Makes sense?"

Screenshot shows the chat history for "Clawsuu" with
the test conversation (active quest is Cyber_School,
but the chat goes back to messages from before the
quest was active). Right now there's no way to tell
which messages were sent while which quest was
active — you'd have to look at the Quests screen
timeline to figure it out.

## The change

Two pieces:

**1. Stamp each chat message with the active quest
at append time.**

Added two optional fields to `ChatMessage`:
- `activeQuestId?: string | null` — id of the active
  quest (null = no active quest, undefined = legacy
  message from before v3.10.85)
- `activeQuestName?: string | null` — display name
  for the separator label

All three ChatMessage creation sites stamp these
fields by snapshotting `activeQuestRef.current` at
append time:
- Desktop chat echo (sync-server round-trip)
- Local voice-mode user message
- Local typed-chat user message

**2. Track the active quest in HomeScreen.**

The chat doesn't have direct access to the QuestsScreen
state, so I added a `quests_list` listener in HomeScreen
that maintains `activeQuestRef.current`. The ref
holds `{ id, name } | null | undefined` (null = no
active quest, undefined = not loaded yet from desktop).

This is a ref (not state) because it's read at
message-append time inside syncClient listeners
that were registered with empty deps — using state
would cause stale reads.

**3. Render a separator above the message when its
quest differs from the previous one.**

In `renderMessage`, compare `messages[index - 1].activeQuestId`
to `item.activeQuestId`. If different, show a thin
gold-bordered pill above the current message with
`🎯 <QuestName>` (or `No active quest` if null).

The separator is centered, with a thin top + bottom
border (rgba(247,147,26,0.25)), small font (11pt),
semi-transparent gold text. Lighter than the date
separator so the date remains the primary
chronological landmark.

## Comparison logic (the tricky part)

| prev | curr | separator? | reason |
|------|------|------------|--------|
| undefined | undefined | no | both legacy, no data |
| undefined | null | no | legacy → default, no boundary |
| null | undefined | no | default → legacy, no boundary |
| undefined | id | yes | legacy → new quest |
| id | undefined | yes | quest → legacy |
| null | null | no | both default |
| id | id (same) | no | same quest |
| id1 | id2 | yes | quest switch |
| null | id | yes | entering a quest |
| id | null | yes | leaving to default |

The undefined↔null non-equivalence is deliberate:
legacy messages (before v3.10.85) shouldn't break
the no-quest label continuity in the existing chat
history. They'll just flow through without showing a
boundary, and new messages with explicit null will
silently continue from them.

## Legacy messages

Messages loaded from AsyncStorage cache (when the
app reopens) don't have `activeQuestId` set. The
comparison logic handles this gracefully — legacy
messages render without separators, and the first
new message after a broadcast lands will show its
quest label (or "No active quest") as a separator.

This means: scroll back in your chat history, old
messages have no quest labels (you can't tell what
quest was active at send time), new messages have
labels. Acceptable for v3.10.85; a future v3.10.x
could backfill by reading the quest-edit history
timestamp and matching against message timestamps,
but that's a separate feature.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `ChatMessage` interface: added `activeQuestId?` and
    `activeQuestName?` fields
  - New `activeQuestRef` ref + `quests_list` listener
    that updates it from desktop broadcasts
  - All three message-creation sites stamp the fields
  - `renderMessage` shows a separator when the quest
    changes from the previous message
  - New styles: `questSeparator`, `questSeparatorText`
- `android/app/build.gradle` — versionCode 308→309,
  versionName 3.10.84→3.10.85
- `package.json` — version 3.10.84→3.10.85

## Lessons

**Snapshot at append, not at render.** When you
want to record "what state was the world in when
this event happened", capture it at the moment the
event is recorded, not when it's displayed. If
you render-time-derive the value, the chat will
say "this message was about the currently-active
quest" — which lies when the user scrolls back
through history. The user's instinct was right:
the chat should be self-documenting, not retrofitted.

**Ref, not state, for syncClient listener context.**
The syncClient listeners are registered once with
empty deps (so they don't churn on every render).
Reading state inside them would give stale values.
A ref that's mutated by an independent listener
keeps the read consistent with the latest broadcast
without re-triggering the listener's effect. Pattern
to remember for any "current state of X needed by an
event handler that's registered once" use case.

**Legacy-data compatibility is its own dimension.**
The `undefined` vs `null` distinction in the
comparison logic isn't just type-theoretic
pedantry — it directly maps to "did this message
exist before the feature was added". Future-proof
your new fields by using `undefined` for "we don't
know" and `null` for "we know it's the empty state",
and handle both gracefully. Saves you from breaking
the existing chat history on rollout.

**One source of truth, two consumers.** Both
QuestsScreen and HomeScreen now subscribe to the
same `quests_list` broadcast from the desktop and
maintain their own copy of the data they need. The
duplication is intentional: each screen can be
unmounted independently (HomeScreen might be off-
screen while QuestsScreen is open, and vice versa),
and refactoring to a shared context/store would
couple them unnecessarily. The desktop is the
canonical source; each screen takes what it needs
and discards the rest.