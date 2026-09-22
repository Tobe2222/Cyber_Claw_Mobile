# v3.11.0 — Per-quest chat separation + auto-jump

Tobe (2026-09-22 08:05, Discord #cyber-dev):
"perfect perfect. I was thinking about separating the chats
in cyberclaw. Such that there is a chat for each quest. The
chat should just automatically jump to the current quest chat,
no need for tabs etc. That might make the logging easier also."

Follow-up (08:13): "And the chat still don't behave as discord
chat. When i Click quests for example, the chat does not stay
at the position it was last, it started further up and force
scrolls back down towards the current."

## What changed

### Per-quest chat buckets

Each (companion, quest) pair now has its own chat history.
Switching quests automatically swaps the visible chat to
that quest's bucket. The "no quest / default chat" bucket
exists as a special `__default__` sentinel — when no quest
is active, new messages go there.

Storage shape changed:
- **Before**: `cyberclaw-chat-byagent` = `Record<agentId, ChatMessage[]>`
- **After**: `cyberclaw-chat-byagent-byquest` = `Record<agentId, Record<questKey, ChatMessage[]>>`

Where `questKey` is the quest's id, or the sentinel
`__default__` for the default bucket. The migration is
idempotent — on first launch with v3.11.0+, the old key is
read once, upgraded to the new shape (everything into the
default bucket, since pre-v3.11.0 messages had no quest
attribution), written under the new key, and the old key is
deleted. Subsequent launches skip the migration path
entirely.

The same change applies to the scroll-offset map:
- **Before**: `cyberclaw-chat-scroll-byagent` = `Record<agentId, number>`
- **After**: `cyberclaw-chat-scroll-byagent-byquest` = `Record<agentId::questKey, number>`

### Auto-jump on quest change

A new state mirror `activeChatQuestId` is updated whenever
the desktop broadcasts a `quests_list` event with an active
quest. The view-sync effect (which keeps the visible chat
list in sync with the active companion's bucket) now also
depends on `activeChatQuestId`, so switching quests swaps
the chat panel to the new quest's history.

Switching to a quest that has no history yet shows an empty
chat — that's correct, the bucket just gets created
lazily when the first message lands.

### Per-quest scroll preservation

The existing v3.10.126 per-agent scroll-offset preservation
now layers quest on top of agent. Each (agent, quest) pair
remembers its own scroll position independently:
- Scrolling within "Clawsuu on Cyber_Accountant" saves to
  `clawsuu::cyber_accountant_id`.
- Scrolling within "Clawsuu on Cyber_Repair" saves to
  `clawsuu::cyber_repair_id`.
- Switching between them restores each to its last position.

The reactive capture effect (which sets the restore
offset on first layout) resets its latch on quest change,
so the restore path runs again for the new bucket — exactly
the same mechanism the v3.10.181 agent-switch path uses,
just with one more dimension in the key.

### Bonus scroll fix

Tobe also reported the chat "started further up and force
scrolls back down towards the current" when navigating away
and back. The per-quest + per-agent scroll restoration
above fixes it as a side effect: the FlatList now restores
the saved offset on remount instead of falling through to
"no offset, scroll to bottom".

## Migration safety

The migration runs in three places, all guarded:
1. `seedFromPerAgent` (chat history hydrate): prefers the
   new key, falls back to the old key only if missing.
2. Scroll-offset hydrate: same shape, same pattern.
3. Persist effects: write only to the new key; remove the
   old key after a successful write.

If any step fails, the next launch re-runs it. No data
loss possible — the old key is only removed AFTER the new
key is written successfully.

## Files changed

- `src/screens/HomeScreen.tsx` — chat state shape, hydrate,
  persist, view-sync, append helper, scroll preservation.
- `CHANGES_3.11.0.md` — this file.

## Compatibility

- Desktop app: must be running v3.3.11+ for the per-quest
  sync messages to round-trip cleanly. Older desktops still
  work for the mobile's local-only chat (which is the bulk
  of the UX), but quest-stamped messages on the desktop
  side won't be filtered by quest until the desktop is
  upgraded.
- Voice mode + wake mode: untouched. Same behavior as
  v3.10.193.
- Sync protocol: unchanged. The mobile stamps each message
  with `activeQuestId` (existing field, v3.10.85) and the
  desktop echoes it back the same way.
