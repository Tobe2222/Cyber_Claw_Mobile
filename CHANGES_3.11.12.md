# v3.11.12 — Mobile: consume per-quest history from desktop v3.3.19

Companion to desktop v3.3.19.

Tobe (2026-09-27 13:47, Discord #cyber-dev):

> "hmm. Its still happening. It spams up and down at
> this position. After i reopen after a while, still on
> the same quest."

After installing v3.11.11, the "— No quest" pill on each
bubble is still appearing, AND the chat panel is now
bouncing up/down in a loop. The v3.11.11 anchor-persistence
fix didn't help.

## Root cause: not what v3.11.11 was fixing

v3.11.11 patched the case where the anchor itself was
wrong (desktop-driven anchor not persisted → bootstrap on
cold start had no key → anchor stayed null → user saw
DEFAULT bucket content). After v3.11.11 the **anchor**
should be correct, but the **buckets** are still empty
for the active quest.

The actual data-loss chain is:

1. Desktop v3.3.18's `chatHistory` (flat mirror) push
   (around line 4169 of app.js) does NOT stamp
   `activeQuestId`. It only stamps `text / isUser /
   agentId / ts`.

2. Desktop v3.3.18's `mobile-request-agent-history`
   handler (around line 7247) reads ONLY the
   `DEFAULT_QUEST_KEY` bucket and serializes with no
   `activeQuestId` field. Active-quest buckets never
   reach the mobile.

3. Desktop v3.3.18's `sync-server.sendAgentHistory` WS
   payload shape is `{type, agentId, messages, ts}` —
   no per-quest structure, no `activeQuestId`.

Combined effect: every message the mobile receives in
`agent_history` lands in `messagesByAgentAndQuest[aid][DEFAULT_QUEST_KEY]`
with `activeQuestId === undefined`. The active-quest
bucket stays empty. After cold start, the projection
effect looks up the active-quest bucket, finds `[]`,
and either:
- (user has anchor set) shows DEFAULT-bucket content
  under "— No quest" pills, OR
- (user has no anchor) shows DEFAULT-bucket content
  under default-no-quest state.

Either way the active-quest content is invisible.

The scroll-jump loop is the cold-start window racing
between:
- `chat_history` flat response fills DEFAULT bucket.
- `agent_history` flat response for active companion
  fills DEFAULT bucket.
- Projection effect's layer-4 guard (`bootstrap
  pending → setMessages([])`) fires.
- Bootstrap resolves, projection effect re-runs, looks
  up active-quest bucket → empty → setMessages([]).
- Realtime `chat_message` events arrive (the desktop's
  pipeline stamps `activeQuestId` correctly via
  `sync-broadcast-chat`), routed to active-quest
  bucket. Projection effect re-runs, still empty.

Each `setMessages(content)` ↔ `setMessages([])` flip
fires FlatList's `onContentSizeChange → scrollToEnd`.
Three or four such flips in close succession = the user
sees a "bouncing" chat panel.

## Fix (mobile side)

Two consumers to update, both already gated on
desktop-shape detection for backwards compat:

### `onAgentHistory`: consume new `buckets` shape (v3.3.19+)

```ts
if (msg.buckets && typeof msg.buckets === 'object' && !Array.isArray(msg.buckets)) {
  // v3.3.19+ shape: { [questKey]: ChatMessage[] }.
  setMessagesByAgentAndQuest(prev => {
    const next = { ...prev };
    const existingBuckets = next[aid] || {};
    const mergedForAgent: Record<string, ChatMessage[]> = { ...existingBuckets };
    for (const [bucketKey, msgs] of Object.entries(bucketsMsg)) {
      if (!Array.isArray(msgs) || msgs.length === 0) continue;
      const loadedBucket: ChatMessage[] = msgs.map((m: any) => ({
        id: `hist-${m.ts}-${Math.random()}`,
        text: m.text,
        isUser: typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user'),
        agentId: m.agentId || m.name || aid,
        agentName: m.agentName || m.name || null,
        ts: m.ts,
        activeQuestId: m.activeQuestId ?? (bucketKey === DEFAULT_QUEST_KEY ? null : bucketKey),
        activeQuestName: m.activeQuestName ?? null,
      }));
      mergedForAgent[bucketKey] = loadedBucket;
    }
    next[aid] = mergedForAgent;
    return next;
  });
  setAnchorHydrateTick(t => t + 1);
  return;
}
// Legacy flat `messages` array fallback below.
```

The new path groups incoming messages by their bucket
key (the desktop side encoded `qid` in the key via
`questKeyForStorage(qid)`, and reverses it back on the
mobile side via `m.activeQuestId ?? (bucketKey ===
DEFAULT_QUEST_KEY ? null : bucketKey)` so the bucket
attribution is preserved even if the per-message stamp
is null in edge cases).

### `onChatHistory`: per-quest attribution check

Old (v3.11.0..v3.11.11) behavior: every message in
`chat_history` landed in `DEFAULT_QUEST_KEY` because the
desktop didn't stamp quests.

New: if EVERY message in `chat_history` has an
`activeQuestId` field (the v3.3.19+ desktop
serialization), route per-bucket:

```ts
if (msg.messages.every((m: any) => 'activeQuestId' in m)) {
  setMessagesByAgentAndQuest(prev => {
    const next = { ...prev };
    for (const m of msg.messages) {
      const mAid = m.agentId || aid;
      const mQid = (typeof m.activeQuestId === 'string') ? m.activeQuestId : null;
      const mKey = questKeyForStorage(mQid);
      if (!next[mAid]) next[mAid] = {};
      if (!next[mAid][mKey]) next[mAid][mKey] = [];
      next[mAid][mKey].push({...});
    }
    return next;
  });
  setAnchorHydrateTick(t => t + 1);
  return;
}
// Fall through to legacy DEFAULT-bucket routing.
```

Old desktops (pre-v3.3.19) send messages without an
`activeQuestId` field, so `every` returns false and we
fall through to the existing legacy path. New desktops
(v3.3.19+) stamp every message, so the new path runs.

### Bump `anchorHydrateTick` instead of `setMessages`

The new paths DON'T directly call `setMessages`. They
update `messagesByAgentAndQuest` (the source-of-truth
map) and bump `anchorHydrateTick` to retrigger the
projection effect. This is intentional: the projection
effect is the single source of truth for "what should
the visible chat show right now?" — bumping the trigger
keeps the projection logic in charge, instead of having
two callers race on `setMessages`.

This also avoids the scroll-jump loop. The bug was
multiple code paths directly setting `messages` to
conflicting states in rapid succession. Now there's
exactly one path: the projection effect. Everything
else updates the bucket map and lets the projection
effect decide.

## Files changed

- `src/screens/HomeScreen.tsx`
  - `onAgentHistory`: consume new `msg.buckets` shape
    (v3.3.19+). Legacy fallback to flat `msg.messages`
    for older desktops.
  - `onChatHistory`: per-quest attribution check.
    Routes messages with `activeQuestId` field to
    per-quest buckets; falls through to legacy
    DEFAULT-bucket path otherwise.
- Bumps: `package.json` 3.11.11 → 3.11.12.
- `versionCode` 407 → 408, `versionName` "3.11.11"
  → "3.11.12".

## Requires desktop v3.3.19 to fully fix

Old desktops (≤ v3.3.18) don't have the new stamping
and don't send `buckets`. Old mobile falls back to the
legacy flat `messages` path → still gets only DEFAULT
content → still "— No quest". **Desktop v3.3.19 must
also be installed** on the same machine for this fix
to do anything.

The desktop's `sendAgentHistory` synthesizes a flat
`messages` fallback (from the DEFAULT bucket) for old
mobile builds, so installing desktop v3.3.19 with old
mobile ≤ v3.11.11 doesn't regress — the user simply
gets the same behavior as before (DEFAULT bucket only,
"— No quest" pills).

## What about the scroll-jump loop?

This release's structure changes (one source of truth
for `messages`, the projection effect driven by a
single bumped tick counter) makes the flip-flop in the
cold-start window deterministic: there's exactly one
"messages" update per projection-effect run. The loop
symptom should disappear with this release.

If it doesn't (e.g. some other code path still
calls `setMessages` with conflicting content in rapid
succession), the next release will audit each
remaining `setMessages` call site and route them
through the projection effect instead.

## This is the 12th fix in the chat-flash family

Plus an extra layer — the **data pipeline** audit. The
previous 11 fixes tackled the projection-effect path
(anchor, bootstrap, remount-fallback). This release
goes one level deeper and fixes the **data-source**
path (the per-quest attribution wasn't being preserved
through the desktop's serialization layers).

**Strong rule (new, applied to both desktop and
mobile):**

**When adding a field to a structured record, every
serialization layer in the pipeline must preserve
that field.** A single layer that drops the field is
enough to lose it for every consumer that uses that
layer's path.

The audit matrix for a new field on a chat message:

| Layer | Drops activeQuestId? |
| --- | --- |
| app.js addChatMsg → per-(agent, quest) bucket push | ✓ (line 4234) |
| app.js addChatMsg → flat chatHistory mirror push | ✗ BEFORE v3.3.19; ✓ AFTER |
| app.js sync-broadcast-chat IPC invoke | ✓ (line 4316) |
| app.js mobile-request-agent-history handler | ✗ BEFORE v3.3.19 (only DEFAULT bucket); ✓ AFTER |
| main.js sync-send-agent-history IPC forward | ✓ AFTER (passes both buckets and messages) |
| sync-server sendAgentHistory payload | ✗ BEFORE v3.3.19 (no per-bucket); ✓ AFTER |
| mobile-side onChatHistory receive | ✗ BEFORE v3.11.12 (all to DEFAULT); ✓ AFTER |
| mobile-side onAgentHistory receive | ✗ BEFORE v3.11.12 (all to DEFAULT); ✓ AFTER |
| mobile-side appendAgentMessage (realtime path) | ✓ (already preserves questId param) |

This kind of audit-table is worth producing for any
new structured field. Three of nine layers were
silently dropping `activeQuestId`. Any one of them
would have caused this bug; the fix was to drop all
three drops at once.

**Lesson for future data pipelines:** the
"per-bucket" data shape (Record<key, T>) is more
fragile than the "per-record with key" shape
(Record<id, T & { bucketKey: string }>) because
bucket splitting happens at serialization time. The
bug-rate per layer is higher. When in doubt, keep the
key on the record (the `activeQuestId` on the message),
not just on the outer map key. The per-record stamp is
what survives serialization layers; the bucket key is
just an index.
