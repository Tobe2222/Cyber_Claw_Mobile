# v3.11.4 — Projection + history-seed use the module-scoped active-quest anchor

Tobe (2026-09-24 ~16:40, Discord #cyber-dev), retest
feedback on v3.11.3:

> "there is still some bug. I had a conversation in the
> website chat about connection it to the cyber database.
> I then minimized the app and opened it up a little
> later. Then it gave be the hive control chat it seems.
> This chat in the picture is from a few days ago for
> hive_control."

Screenshot shows the chat displaying pre-v3.3.11 legacy
Hive Control messages (Bitmain FW, PSU probe, dinner
joke) even though the active quest on the desktop was
CYBERHIVE_WEBSITE V3.

## Root cause

Two separate code paths fall back to the DEFAULT bucket
when the user's actual quest bucket has content
elsewhere:

### 1. Projection effect (HomeScreen.tsx ~line 1410)

```ts
const qid = activeQuestRef.current === undefined
  ? null
  : (activeQuestRef.current?.id ?? null);
const bucketKey = questKeyForStorage(qid);
const bucket = agentBuckets[bucketKey] || [];
setMessages(bucket);
```

On a HomeScreen remount (app foreground after
minimize), `useRef` re-initializes the ref to
`undefined`. So `qid` falls to `null`, `bucketKey`
becomes `DEFAULT_QUEST_KEY = '***'`, and `setMessages`
shows the DEFAULT bucket.

The DEFAULT bucket on Tobe's mobile contains
pre-v3.3.11 legacy messages — including the Bitmain
FW / PSU probe conversation from much older sessions.
The user's actual website bucket is also there
(because Tobe chatted on website about installing
the database), but the projection effect never gets to
it because the ref is undefined at remount.

### 2. `seedFromPerAgent` history-load (HomeScreen.tsx ~line 2604)

```ts
setMessages(prev => {
  if (prev.length > 0) return prev;
  const aid = activeChatAgentIdRef.current;
  if (aid && parsed[aid]) {
    for (const [, msgs] of Object.entries(parsed[aid])) {
      if (Array.isArray(msgs) && msgs.length > 0) return msgs;
    }
  }
  // …
});
```

On initial mount, the seed iterates `Object.entries(
parsed[aid])` and returns the FIRST non-empty bucket by
insertion order. JavaScript's `Object.entries` returns
keys in insertion order. The legacy DEFAULT bucket (from
the v3.11.0 per-agent-only migration) was inserted
first, so it wins — regardless of which quest the user
actually had active.

## Fix

Use the module-scoped `mobileActiveQuestAnchor` (added
in v3.11.2, survives HomeScreen remounts because it's
module-scope, not component-scope) as the fallback
when `activeQuestRef.current` is undefined.

### Projection effect

```ts
let qid: string | null;
if (activeQuestRef.current !== undefined) {
  qid = activeQuestRef.current?.id ?? null;
} else if (mobileActiveQuestAnchor !== null &&
           mobileActiveQuestAnchor !== undefined) {
  // Anchor was set on a prior session and survives
  // the remount. Use it.
  qid = mobileActiveQuestAnchor;
} else {
  qid = null;
}
```

### History seed

```ts
const activeQid = mobileActiveQuestAnchor ?? null;
const activeKey = questKeyForStorage(
  activeQid === undefined ? null : activeQid
);
if (parsed[aid][activeKey] && parsed[aid][activeKey].length > 0) {
  return parsed[aid][activeKey];
}
// Fall back to the active agent's default bucket.
const defaultKey = DEFAULT_QUEST_KEY;
if (parsed[aid][defaultKey] && parsed[aid][defaultKey].length > 0) {
  return parsed[aid][defaultKey];
}
// Last resort: any bucket of any agent with content.
```

The history seed now prefers (in order):

1. **Active companion × active quest's bucket** (the
   user's actual last-viewed chat).
2. Active companion's DEFAULT bucket (legacy fallback
   for when there's no quest-attributed history).
3. Any agent's bucket with content (initial-load
   fallback).

## Files changed

- `src/screens/HomeScreen.tsx`
  - Projection effect (~line 1410): falls back to
    `mobileActiveQuestAnchor` when `activeQuestRef.current`
    is undefined.
  - `seedFromPerAgent` history-load (~line 2604):
    prefers the active quest's bucket over the DEFAULT
    bucket by iteration order.
- `package.json` — bumped to `3.11.4`.

## Compatibility

- The anchor's lifecycle: it was set on a prior session
  via `handleSetActive` or by a fresh broadcast's Case 1
  seed. If the user has never picked a quest (anchor
  remains `null`), the projection effect still falls back
  to DEFAULT bucket. That's the existing pre-fix
  behavior for new users.
- For users who deactivated the active quest (anchor =
  `null`): the projection effect uses `qid = null` →
  DEFAULT bucket. Correct: a user with no active quest
  sees the default chat.
- For users who picked a quest on the mobile (anchor =
  quest id): the projection effect uses `qid = quest id`
  → that quest's bucket. Correct: user sees their last
  active chat.

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-trace Tobe's repro:
  1. Tobe chats on website (anchor seeds to website via
     handleSetActive or fresh broadcast).
  2. App minimized.
  3. App re-opened → HomeScreen remounts → `activeQuestRef`
     re-init to undefined.
  4. Projection effect fires (state change: `activeChatQuestId`
     re-init to undefined).
  5. New logic: `qid = mobileActiveQuestAnchor` (still
     website because module scope persists) → bucketKey
     = website id → bucket = website bucket content.
  6. Chat shows website's messages, not legacy Hive Control.

## This is the 4th fix in the same family

A retrospective of the cross-cutting rule "a broadcast is
a hint, not a directive":

- v3.11.1: reply doesn't render until next send.
  Projection-effect over-strict guard.
- v3.11.2 (revised): anchor seeds wrong from stale cache
  replay. Source-tag refinement.
- v3.11.3: cache replay overwrites freshly-seeded ref.
  Cache-replay data-only.
- **v3.11.4 (this): on HomeScreen remount, the ref is
  useRef-initialized to undefined and the DEFAULT bucket
  is shown. Module-scoped anchor fallback.**

The 4th fix closes a path that wasn't visible until the
first 3 closed: every time a layer of caching/state
gets removed, a new path surfaces that needs the same
treatment. The shared fix across all four is "module-
scope persistent state for the user's last-known
view-target, with every reader/writer consulting it."
