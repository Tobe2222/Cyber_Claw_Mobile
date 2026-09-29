# v3.11.20 — Mobile: preserve attachments in onAgentHistory (companion to desktop v3.3.21)

## The bug

Tobe (2026-09-29 16:10, Discord #cyber-dev):

> "@Clawsuu Okey. But i am on 3.11.19 and as you see here
> there is no image so please fix what is needed"

The v3.11.19 fix (one-line passthrough of `msg.attachments`
in the realtime `onChat` handler) was deployed and the
mobile was on v3.11.19. But screenshot bubbles from the
desktop still didn't appear in Tobe's mobile chat.

## Root cause

The realtime broadcast was racing against a mobile WS
reconnect. The desktop log showed the broadcast went out
(line 547 of /tmp/cyberclaw-desktop.log), but the mobile
either didn't have a stable socket at that moment or the
frame was dropped during the reconnect storm. The bubble
was lost.

The desktop's `chatHistoryByAgentAndQuest` doesn't persist
`agent-image` bubbles — it only persists `agent` and
`user` types (since v3.2.83 when `agent-image` was added).
So even on the next `agent_history` request from the
mobile, the bubble wouldn't be there.

Two missing things:

1. **Desktop: agent-image bubbles weren't persisted** in
   `chatHistoryByAgentAndQuest` (fixed in v3.3.21).

2. **Mobile: `onAgentHistory` was stripping `attachments`**
   when mapping the desktop's bucket history to
   ChatMessage objects. The desktop's
   `chatHistoryByAgentAndQuest` does carry `attachments`
   for `agent` / `user` messages with attachments (since
   v3.10.20), but the mobile's `onAgentHistory` mapping
   at line ~4749 and the legacy `messages` fallback path
   at line ~4803 were both missing the `attachments`
   field.

## The fix

Two changes:

1. **Mobile `onAgentHistory` per-quest buckets path**
   (HomeScreen.tsx ~4749): add `attachments` to the
   ChatMessage constructor when present on the history
   response.

2. **Mobile `onAgentHistory` legacy flat-messages
   fallback** (HomeScreen.tsx ~4803): same fix. Also
   preserve `agentName` correctly (had a typo in a
   draft edit, corrected).

## Why this is the right fix

The desktop v3.3.21 changes persist agent-image bubbles
in `chatHistoryByAgentAndQuest` with their attachments.
The desktop's `sendAgentHistory` forwards the buckets
verbatim. The mobile's `onAgentHistory` receives the
buckets. With this fix, the mapping preserves
attachments, and the bubble shows in his chat history.

This is durable state. Whether the realtime broadcast
arrives or not, the bubble is now in the bucket and
will be sent on every `agent_history` response. The
mobile receives it on its next cold start, reconnect,
or tab switch — no longer dependent on a single
best-effort WS frame.

## Lessons

1. **Every ChatMessage field needs preservation in
   every deserialization path.** Three ChatMessage
   constructors on the mobile:
   - `onChat` (realtime chat_message) — fixed in
     v3.11.19
   - `onChatHistory` (legacy chat_history) — fixed
     already (v3.10.107)
   - `onAgentHistory` (per-quest buckets + flat
     fallback) — fixed in v3.11.20

   Each one is its own deserializer with its own
   field-mapping. When we add a new ChatMessage field
   (attachments), we have to thread it through all
   three. The same audit pattern as the v3.3.20 / 21
   audit on the desktop side.

2. **History sync is the durable path; realtime is
   the immediate path.** Same broadcast can fail in
   transit (network, reconnect storm, etc.); history
   sync rides the next reconnect. Both paths need
   the same data. Today we close that gap for
   agent-image bubbles.

3. **Audit comments at field-declaration sites catch
   this.** When we add a field to ChatMessage, every
   deserialization site should have a comment listing
   which fields it preserves. Currently the chat
   constructor at line ~250 has such an audit
   pattern; the deserialization sites should mirror
   it.

## Audit table

Layer | Field | Preserves | This fix
---|---|---|---
mobile onChat (realtime) | attachments | n/a | ✅ v3.11.19
mobile onChatHistory | attachments | n/a | ✅ already
mobile onAgentHistory buckets | attachments | n/a | ✅ v3.11.20
mobile onAgentHistory legacy | attachments | n/a | ✅ v3.11.20
mobile bubble renderer | attachments | yes | ✅ already