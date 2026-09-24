# v3.11.2 — Active-quest chat flash fix (broadcast churn in `onQuestsList`)

> **Revision (2026-09-24 ~10:20):** Tobe clarified the
> chat didn't flash — it STAYED on the wrong quest until
> he navigated Quests and back. That meant the listener
> permanently adopted the wrong active, not just briefly.
> Root cause: under the original v3.11.2 design, the
> first broadcast to seed the anchor could be a stale
> cached replay (`source: 'cache_replay'`). The fix:
> the desktop now tags fresh broadcasts vs cache replays,
> and the mobile only seeds the anchor on fresh
> broadcasts. See "Fix (revised)" below.

Tobe (2026-09-24 ~09:39, Discord #cyber-dev), reported against v3.11.1:

> "im planning to use a new computer for my agents and work
> projects. Anyway. I tested cyberclaw on my mobile just
> now. I opened the website quest and it was 1 message in
> that chat. I then said a greeting to clawsuu and he
> started working. After some seconds the chat suddenly
> changed to a much longer conversation, i think It was the
> hive control chat. I then opened the quests to see if i
> had been moved to that quest but it still said the
> website, then i returned to home screen and the chat was
> back to normal or how it was when i started out, with
> just the one text. So it changed chat for some reason in
> the middle of the task."

## Root cause

The mobile's `onQuestsList` listener (HomeScreen.tsx, line
~4283) blindly trusted the desktop's `q.active` flag in every
`quests_list` broadcast:

```ts
const active = quests.find((q: any) => q && q.active);
const next = active && active.id
  ? { id: active.id, name: active.name || '(unnamed quest)' }
  : null;
activeQuestRef.current = next;
const nextQid: string | null | undefined = next ? next.id : null;
setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
```

That fires the projection effect (line ~1330, deps
`[activeChatAgentId, activeChatQuestId]`) which calls
`setMessages(activeBucket)` to mirror the per-(agent,quest)
bucket into the visible FlatList. So whenever the broadcast's
`q.active` changed, the visible chat snapped to that quest's
bucket.

The desktop re-broadcasts `quests_list` on **every**
`saveQuests`. The chat pipeline appends per-quest
`conversationLog` entries to `quests.json` on every agent
reply (line ~1904 in desktop `main.js`), and `quests.json`
saves also fire on mobile WS reconnects and explicit quest
metadata edits. So during a 5-10 second LLM turn the desktop
emits multiple broadcasts.

The broadcast itself isn't the problem — the problem is the
**content** of the broadcast. Two sources produce the wrong
`q.active` in the broadcast:

1. **Stale `_lastQuestsList` cache replay.** The desktop's
   `SyncServer._sendFullState` (sync-server.js:2147) replays
   the cached last broadcast on every `request_state` from
   the mobile. If at any earlier moment the cache was
   written with a non-website active quest (e.g. Tobe was
   testing Hive Control yesterday, or briefly tapped a
   different quest in the mobile Quests panel), every
   subsequent replay carries that active flag, even though
   the on-disk `quests.json` has been updated since.
2. **saveQuests race during active-flag tweak.** Although
   `loadQuests()` enforces the single-active invariant on
   read (line ~357), there's a brief window between
   `setQuestActive` IPC handler finishing its in-memory
   mutation and `saveQuests` writing to disk. Broadcasts
   fired during that window can briefly carry the previous
   active state. Mid-LLM, this can manifest as a brief
   swap.

The chat-flash Tobe saw (website bucket → Hive Control
bucket → revert to website) is consistent with broadcast 1
above: a stale replay hit during the LLM, the listener
flipped state to Hive Control, the projection swapped
`messages` to Hive Control's bucket, then a later
broadcast replayed the canonical ("website") state, the
listener flipped back, the projection re-swapped.

## Fix (revised, 2026-09-24 ~10:20)

The desktop tags each `quests_list` broadcast with a
`source` field:

- `'broadcast'` — fresh, just-saved state. Set by
  `broadcastQuestsList()` in sync-server.js.
- `'cache_replay'` — served from `_lastQuestsList` on
  mobile reconnect / `request_state` /
  `request_quests_list`. Set by `_sendFullState` and the
  `request_quests_list` cache-fallback path.

The mobile's `onQuestsList` listener (HomeScreen.tsx,
~line 4283) treats fresh broadcasts as authoritative for
the per-device anchor, and treats cache replays as
data-only (populates the quest list, but doesn't seed the
anchor):

```ts
const isFreshBroadcast = msg?.source !== 'cache_replay';
if (!isFreshBroadcast) {
  // Cache replay. Populate data; do NOT seed the anchor.
  activeQuestRef.current = next;
  return;
}
// Fresh broadcast: 3-case logic as below.
```

Cache replays can still reach the listener in two ways
during a single mobile connection:

1. `_sendFullState` on WS auth (the desktop's first
   message after the mobile connects).
2. `request_quests_list` cache fallback (rare; main.js's
   `onRequestQuestsList` always re-reads fresh, so this
   only fires when the desktop's main.js is unregistered
   or broken).

In both cases, the broadcast's `source: 'cache_replay'`
flags it as suspect.

### Server-side companion fix (desktop v3.3.16)

The desktop's `_sendFullState` and `request_quests_list`
cache fallback now always call `onRequestQuestsList()`
to re-broadcast fresh, in addition to (or instead of)
the cache replay. So in the common path, the mobile gets:

1. Cache replay (instant, tagged `source: 'cache_replay'`)
2. Fresh broadcast (a tick later, tagged
   `source: 'broadcast'`)

The mobile listener processes both; the fresh broadcast
seeds the anchor. The cache replay is harmlessly ignored
for state purposes but populates the quest list data
immediately so the user doesn't see an empty list.

## Fix (original v3.11.2 design, kept for context)

A per-device anchor for the active quest. Once the mobile
has chosen an active quest (initial broadcast OR explicit
user pick via QuestsScreen.handleSetActive), it sticks —
subsequent broadcasts that carry a DIFFERENT active are
ignored. Broadcasts that AGREE with the anchor still adopt
(they're confirmations and may carry a renamed quest name).

### Module-scoped state (`HomeScreen.tsx`)

```ts
let mobileActiveQuestAnchor: string | null | undefined = null;
export function getMobileActiveQuestAnchor() {
  return mobileActiveQuestAnchor;
}
export function setMobileActiveQuestAnchor(qid) {
  mobileActiveQuestAnchor = qid;
}
```

Module-scoped (not component-scoped) so both HomeScreen's
`onQuestsList` and QuestsScreen's `handleSetActive` /
`handleRefresh` can read/write it without prop-drilling.
Survives HomeScreen unmounts (Settings / Quests / Wake
navigation). Reset to `null` on app cold start (process
restart) — that's "no anchor yet" and the initial broadcast
seeds it.

### `onQuestsList` (HomeScreen.tsx, line ~4283)

Three-case listener, replacing the existing 2-line
"always adopt" logic:

```ts
if (mobileActiveQuestAnchor === null) {
  // Case 1: no anchor yet. Adopt the broadcast (initial seed).
  mobileActiveQuestAnchor = nextQid;
  activeQuestRef.current = next;
  setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
  return;
}
if (mobileActiveQuestAnchor === nextQid) {
  // Case 2: broadcast confirms our anchor. No state swap;
  // keep the ref in sync (in case the quest was renamed).
  activeQuestRef.current = next;
  setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
  return;
}
// Case 3: broadcast carries a different active than our
// anchor. Don't swap state (the projection effect won't
// re-fire, so the visible chat stays anchored). DO update
// the ref so outgoing agent messages get stamped correctly.
activeQuestRef.current = next;
```

The `activeQuestRef` (used in `appendAgentMessage` to stamp
each incoming reply's `activeQuestId`) still tracks the
desktop's broadcast value. This means an incoming reply
during a window where desktop and mobile disagree gets
routed to the broadcast's bucket (which is what the desktop
expects). The visible chat stays anchored to the mobile
user's choice.

### `handleSetActive` (QuestsScreen.tsx, line ~435)

Optimistically update the anchor before the IPC goes out:

```ts
const handleSetActive = (id: string | null) => {
  setError(null);
  setMobileActiveQuestAnchor(id ?? null);
  syncClient.setQuestActive?.(id);
};
```

Without this update, an in-flight `quests_list` broadcast
(between the optimistic IPC send and the desktop's reply
broadcast) could seed the anchor at Case 1 with whatever
the broadcast happened to carry. Setting the anchor
optimistically guarantees the eventual reply broadcast
either matches (Case 2) or gets ignored (Case 3), both of
which leave the user's pick intact.

### `handleRefresh` (QuestsScreen.tsx, line ~510)

Reset the anchor so the next broadcast adopts:

```ts
const handleRefresh = () => {
  if (refreshing) return;
  setError(null);
  setRefreshing(true);
  setMobileActiveQuestAnchor(null);
  syncClient.requestQuestsList?.();
  // ...
};
```

This is the recovery path for users who actively switched
active on the desktop and want the mobile to follow.
Without the anchor reset, pull-to-refresh would lock
the mobile's active to its previous pick even after the
desktop said something different.

## Trade-offs

**Desktop-driven active switches don't auto-follow on
mobile.** If Tobe switches active to Hive Control from the
desktop GUI while his mobile is open, the mobile's anchor
stays at website. The visible chat stays on website, the
quest highlight on the Quests page may show stale state
until refresh. Pull-to-refresh on the Quests page resets
the anchor and re-syncs. This is acceptable: the mobile is
its own device and the user can intentionally re-tap on the
Quests panel if they want to follow a desktop switch.

**Cross-bucket reply routing during a disagreement window.**
If the desktop changes active (e.g. the agent's
`[QUEST_SET_ACTIVE: ...]` tag fires mid-task) and broadcasts
arrive while the mobile's anchor disagrees, incoming
replies are stamped with the broadcast's quest id and
routed to the broadcast's bucket. The user on the anchor's
chat doesn't see them until they navigate. This is rare and
self-heals the moment the anchor and broadcast agree
again.

**Initial boot seeding.** The first `quests_list` broadcast
seeds the anchor at whatever the desktop says is active.
If the user's prior desktop session had a non-default
active (e.g. they were mid-test on Hive Control), the
mobile boots into that. This is the existing pre-fix
behavior and matches the user's last-known desktop state.

## Files changed

- `src/screens/HomeScreen.tsx`
  - New module-scoped state `mobileActiveQuestAnchor` +
    `getMobileActiveQuestAnchor` / `setMobileActiveQuestAnchor`
    exports (line ~585, near `DEFAULT_QUEST_KEY`).
  - Removed the unused `userActiveOverrideRef` instance ref
    (the design landed module-scoped instead — narrower
    blast radius).
  - Rewrote `onQuestsList` (line ~4283) as a 3-case
    listener that consults the anchor before adopting the
    broadcast's `q.active`.
- `src/screens/QuestsScreen.tsx`
  - Imported `setMobileActiveQuestAnchor` from
    `./HomeScreen` (cross-screen, no prop-drilling).
  - `handleSetActive` (line ~435): optimistic
    `setMobileActiveQuestAnchor(id ?? null)` before the IPC.
  - `handleRefresh` (line ~510): `setMobileActiveQuestAnchor(null)`
    to re-seed on pull-to-refresh.
- `CHANGES_3.11.2.md` — this file.
- `package.json` — bumped to `3.11.2`.

## Verified

- `npx tsc --noEmit` produces no new errors
  (the pre-existing NodeJS / globals.d.ts conflicts are
  unrelated to this change).
- Hand-trace through Tobe's repro: open website quest →
  handleSetActive(website.id) → anchor = website.id → user
  sends greeting → bucket gets 2 messages → mid-LLM,
  broadcast arrives with Hive Control active → Case 3:
  ref updates to Hive Control, state (and projection)
  unchanged → chat shows website's 2 messages
  uninterrupted → broadcast later confirms website →
  Case 2: no-op.
