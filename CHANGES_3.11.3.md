# v3.11.3 — Cache-replay path is data-only (no `activeQuestRef` mutation)

> **Revision (2026-09-24 ~12:20):** Tobe retested with
> v3.11.2 (revised) + desktop v3.3.16 and the chat still
> flashed to a different quest's content. The `source`
> tag was correct but the cache-replay path was still
> writing to `activeQuestRef.current` — and on rapid
> WS frame ordering, the cache's stale value could land
> AFTER the fresh broadcast had already seeded the ref.
> v3.11.3 makes the cache-replay path strict data-only:
> it never touches `activeQuestRef` or `activeChatQuestId`.

Tobe (2026-09-24 ~12:15, Discord #cyber-dev), retest
feedback on v3.11.2 (revised):

> "hmm. It still jumped to another chat at some point but
> now its back again so lets test further. ... The next 3
> images shows that I tried to ask if the task was done
> and he did not answer, i then tried again saying hellooo.
> Then i did something else on the phone and opened the
> app again a bit later and it was suddenly in the middle
> of another chat even tho i have the same quest active
> (last image)."

The last image (12:11) shows the chat rendering
pre-v3.3.11 legacy chat history (Antminer / PSU
content from much older sessions, not the website quest's
current chat). Active quest on the desktop was
CYBERHIVE_WEBSITE V3.

## Root cause

The v3.11.2 (revised) `onQuestsList` cache-replay path
updated `activeQuestRef.current = next` unconditionally:

```ts
if (!isFreshBroadcast) {
  // Cache replay. Populate data, keep ref in sync.
  activeQuestRef.current = next;   // <-- this was the bug
  return;
}
```

On mobile reconnect cycles (very frequent — every
foreground/background transition triggers a `_sendFullState`
or `request_state`), two messages arrive in quick
succession:

1. **Cache replay** (`source: 'cache_replay'`) — instant,
   reflects the last cached `_lastQuestsList` payload.
2. **Fresh broadcast** (`source: 'broadcast'`) — a tick
   later, re-read from disk by `onRequestQuestsList()`.

The listener processes both. Under v3.11.2 (revised):

- Cache replay: `activeQuestRef.current = <cache value>`.
  (Wrong if cache is stale.)
- Fresh broadcast: Case 1 (anchor === null) seeds the
  anchor AND `activeQuestRef.current = <fresh value>`.

If the WS frame order puts the cache replay AFTER the
fresh broadcast (or if the fresh broadcast's `setState`
triggers a render that re-evaluates the listener and the
cache replay lands in the same tick), the cache's stale
value overwrites the freshly-seeded ref. The projection
effect then reads the wrong ref, the bucket lookup
returns the wrong bucket, and the chat flashes to that
bucket's content.

Tobe's case: cache replay carried Hive Control active
(from a much earlier testing session — the `_lastQuestsList`
cache can hold values from before disk was modified, see
v3.3.16 changelog). Fresh broadcast seeded the ref to
website. Cache replay's stale Hive Control value then
overwrote the ref. Projection effect's bucket lookup
returned Hive Control's bucket, which happened to have
pre-v3.3.11 legacy messages in the `DEFAULT_QUEST_KEY`
fallback (since the per-quest buckets for Hive Control
were empty under the v3.3.11 per-quest model).

## Fix

The cache-replay path is now strict data-only. It does
NOT touch `activeQuestRef.current` or
`activeChatQuestId`. The ref/state are mutated ONLY by
fresh broadcasts (Case 1 / 2 / 3).

```ts
if (!isFreshBroadcast) {
  // Cache replay. Data-only — do NOT touch activeQuestRef
  // or activeChatQuestId. See the comment below for why.
  return;
}
```

Cache replays still populate the QuestsScreen card list
(handled by the QuestsScreen's separate `quests_list`
listener, which doesn't touch the chat projection).
HomeScreen's projection effect only sees ref/state
changes from fresh broadcasts.

The fresh broadcast is now the single source of truth for
the mobile's view state. Even if a cache replay arrives
after a fresh broadcast, the ref/state stay anchored to
the fresh value.

## Files changed

- `src/screens/HomeScreen.tsx`
  - `onQuestsList` cache-replay branch (~line 4356): no
    longer writes `activeQuestRef.current`. Returns
    immediately after the `if (!isFreshBroadcast)` check.
- `package.json` — bumped to `3.11.3`.

## Compatibility

- QuestsScreen: still receives cache replays via its
  separate listener. The card list populates as before.
- Chat projection effect: now driven strictly by fresh
  broadcasts. The ref/state can only be mutated by fresh
  broadcasts; cache replays are invisible to it.
- Sync protocol: unchanged from v3.3.16. The desktop
  still tags every fresh broadcast with `source: 'broadcast'`
  and every cache replay with `source: 'cache_replay'`.
  The mobile just chooses to ignore cache replays for
  state purposes.

## Verified

- `npx tsc --noEmit` — no new errors (the pre-existing
  node_modules / globals.d.ts conflicts are unrelated).
- Hand-trace Tobe's repro: mobile reconnects → cache
  replay arrives (ignored for state) → fresh broadcast
  arrives → Case 1 seeds anchor to website, ref tracks
  website. Projection effect uses website bucket. Even
  if a SECOND cache replay arrives later in the session,
  it's ignored; ref stays at website.
- Tag on origin verified with `git ls-remote --tags
  origin | grep v3.11.3` → annotated at `9d12609`.
