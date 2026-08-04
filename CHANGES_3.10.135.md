# v3.10.135 — SyncClient wire-up for the new conversation log IPCs (no UI yet)

## Background

The desktop shipped v3.2.61 with three new IPCs for
mobile-side access to the per-quest conversation
log file at `<quest.directory>/CONVERSATION.md`:

- `quests:get-conversation-log` (already existed in
  v3.2.59 — JSON entries; now also returns the
  file path so the mobile can show "open in editor")
- `quests:get-conversation-file` (NEW — raw markdown
  content + path)
- `quests:clear-conversation-log` (clears both JSON
  + file; pre-existing in v3.2.59)

Without a mobile-side wiring, these IPCs sit dark
on the desktop. v3.10.135 adds the matching
`SyncClient` methods on the mobile side so the WS
round-trip works when a future release adds the UI.

## What shipped

Three new methods on
`CyberClawMobile/src/services/SyncClient.ts`:

- `getConversationLog(questId)` — sends
  `request_quest_conversation_log`; awaits the
  `quest_conversation_log` event with `log` (JSON
  entries), `filePath`, `questName`, `ok`.
- `getConversationFile(questId)` — sends
  `request_quest_conversation_file`; awaits
  `quest_conversation_file` with raw `content` +
  `path`.
- `clearConversationLog(questId)` — sends
  `clear_quest_conversation_log`; awaits
  `quest_conversation_log_cleared`.

Each method follows the same pattern as the existing
`requestQuestInstructions` family: send the request WS
message, register a one-shot listener with a 5-second
timeout, return a Promise that resolves on the ack.

The methods are pure wire-up — no UI in this release.
A future v3.10.136+ will:
- Show "💬 N conversations" badge on each quest card
- Add a "View past conversations" button on the
  detail modal that opens a markdown viewer
- Add a "Clear conversation log" button (with
  confirmation) on the same detail modal

## Files

- `src/services/SyncClient.ts`: three new methods
  after `saveQuestInstructions`. Each is a thin
  wrapper around `this.send(...)` + a one-shot
  listener that resolves with the ack.
- `package.json`: 3.10.134 → 3.10.135.
- `android/app/build.gradle`: versionName 3.10.135,
  versionCode 359.

## Verification

- TypeScript: 0 new errors.
- ESLint: 0 new errors.
- Both confirmed by stash+diff baseline.

## Why wire-up without UI

The desktop IPCs + WS handlers were the load-bearing
change. The mobile UI (badge + viewer + clear button)
is pure presentation; it can ship whenever and the
desktop side keeps working. Shipping the wire-up
separately keeps each release reviewable and unblocks
the mobile UI work without coupling to it.

## What didn't change

- No UI for the conversation log on mobile.
- Desktop `buildActiveQuestContext` still reads from
  the JSON array for LLM context (unchanged from v3.2.59).
- Mobile Settings / Quests UI unchanged from v3.10.134.
