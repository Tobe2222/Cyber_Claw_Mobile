# v3.11.8 — seedFromPerAgent setMessages fallback was leaking the legacy DEFAULT bucket into active-quest views

Tobe (2026-09-25 15:43, Discord #cyber-dev):

> "@Clawsuu yes both the desktop and mobile has the
> database quest active now. and when i opened the
> app on mobile it started with the no active quest
> chat. I opened it again just now and this time it
> had the database chat. but for some reason some
> times it opens the no active even tho a quest is
> selected. sniff around and see what you find"

The "sniff around" gives a clear clue: intermittent.
Same APK, same code, sometimes right, sometimes
wrong. That's a timing race.

## Root cause

The `seedFromPerAgent` useEffect (and its
`seedFromLegacy` and old-key-migration counterparts)
runs on HomeScreen mount. It:

1. Reads `cyberclaw-chat-byagent-byquest` from
   AsyncStorage.
2. Calls `setMessagesByAgentAndQuest` (populates the
   per-(agent, quest) bucket map).
3. Calls `setMessages(prev => …)` to choose which
   bucket to show as the visible chat.

Step 3's logic (from v3.11.4) was:

```ts
const activeQid = mobileActiveQuestAnchor ?? null;
const activeKey = questKeyForStorage(activeQid);
if (parsed[aid][activeKey] && length > 0) return it;
// Fall back to the active agent's DEFAULT bucket.
if (parsed[aid][DEFAULT_QUEST_KEY] && length > 0)
  return that;
// Last resort: any bucket of any agent with content.
```

The "fall back to DEFAULT" was meant to handle the
case where the active quest's bucket has no on-disk
data yet. But the legacy DEFAULT bucket holds
pre-v3.11.0 messages — content that was never
attributed to any quest. Surfacing that bucket
when the user has a quest active is exactly the
chat-flash bug.

### Why intermittent

The race is between three events firing on HomeScreen
mount:

- **T0** (mount): state init = `{messages: [], activeChatAgentId: null, activeChatQuestId: undefined}`. Module-scope anchor = whatever the bootstrap read.
- **T1**: agents_list arrives → `setActiveChatAgentId('companion')` → projection effect runs → reads `anchor='database'` → `setMessages(messagesByAgent['companion']['database'] || [])`. Database bucket is empty because the seed hasn't run yet → `[]`.
- **T2** (AsyncStorage read resolves): `seedFromPerAgent`'s `setMessages` runs. Reads `activeChatAgentIdRef.current` (= 'companion' since T1). Computes the active quest bucket key. If that bucket has no on-disk content (because the user just installed v3.11.0+ and this is their first run with quest attribution, or because they never chatted in this quest), it falls back to the legacy DEFAULT bucket → `setMessages(DEFAULT_content)`. **Wrong bucket.**

The intermittent nature depends on whether T2
resolves before or after T1. AsyncStorage.getItem on
Hermes is fast but variable; sometimes it beats the
agents_list round-trip, sometimes it loses. When
T2 wins, the projection effect already set `[]`
(which would have been correct as an empty render)
but the seed overwrites with DEFAULT content.
When T1 wins, the projection effect sets `[]` and
the seed's `prev.length > 0` guard returns prev
unchanged — correct.

Tobe's "sniff around" symptom maps precisely: the
racy path produces the wrong bucket ~half the time.

The projection effect doesn't re-fire to fix the
seed's clobber because its deps are
`[activeChatAgentId, activeChatQuestId, anchorHydrateTick]`
— none of those change when the seed runs.

## Fix

Two changes inside `seedFromPerAgent` /
`seedFromLegacy` / old-key-migration's `setMessages`:

### 1. Don't fall back to the legacy DEFAULT bucket
###    when the user has an active quest

If `activeQid !== null` (the user has a specific
quest active), the legacy DEFAULT bucket is NOT
relevant to their active-quest view. The previous
fallback was a leak — the legacy content came from
a time before quest attribution existed; it's
strictly "no quest" content and shouldn't appear
under a quest pill.

If the active quest's bucket has no on-disk data,
return `prev` (don't clobber). The projection effect
already set the right (empty) state; let it stand.

If the user has NO active quest (`anchor === null`),
the DEFAULT bucket is what they want. Keep that
fallback.

### 2. Bump anchorHydrateTick so the projection
###    effect re-runs after the bucket map is
###    populated

Even when we don't setMessages ourselves, we still
populated `messagesByAgentAndQuest` via
`setMessagesByAgentAndQuest`. The projection effect
doesn't have that in its deps (correctly — adding it
would cause loops). To make sure the projection
re-runs with the now-populated data, we bump
`anchorHydrateTick`, which IS in its deps.

```ts
setAnchorHydrateTick(t => t + 1);
```

This is the same trigger the bootstrap uses
(v3.11.7) — proven safe, doesn't cause loops.

## Files changed

- `src/screens/HomeScreen.tsx`
  - `seedFromPerAgent`'s `setMessages`: removed the
    silent fallback to DEFAULT when `activeQid !== null`;
    also removed the "any bucket of any agent"
    last-resort fallback (same leak). When we'd
    previously fall back, we now return prev and
    bump `anchorHydrateTick`.
  - `seedFromLegacy`'s `setMessages`: same fix —
    legacy content only surfaces when the user has
    no active quest.
  - Old-key-migration's `setMessages` (the
    `cyberclaw-chat-byagent` → per-quest migration):
    same fix.
  - Bumps: `package.json` 3.11.7 → 3.11.8.
  - `versionCode` 403 → 404, `versionName` "3.11.7"
    → "3.11.8".

## Diagnostic tell-tale for "seed clobber"

Same diagnostic pattern as the chat-flash family:

- User has a quest active on desktop.
- Mobile opens, sometimes shows the right chat,
  sometimes the DEFAULT bucket.
- The DEFAULT bucket content is pre-v3.11.0 chat
  history with no quest attribution.

If Tobe's chat shows pre-v3.11.0 messages and the
desktop says another quest is active, that's this bug
(see layer history in MEMORY.md for the cross-cutting
rule).

## Compatibility

- Wire format: unchanged.
- AsyncStorage key: same as v3.11.7. No data
  migration needed.
- The legacy DEFAULT bucket is preserved exactly
  as before — we just don't surface it when the
  user has a quest active. Users who have explicitly
  deactivated (anchor === null) still see the
  DEFAULT bucket as before.

## Verified

- `npx tsc --noEmit` — no new errors (pre-existing
  errors in unrelated files only).
- Hand-traced the four timing windows:

  | Timing | Before v3.11.8 | After v3.11.8 |
  | --- | --- | --- |
  | T2 before T1, T1 sets [], T2 falls back to DEFAULT | User sees DEFAULT bucket. Bug. | T2 sees `activeQid='database'`, returns prev (which is `[]` from T1's projection effect run, or it returns `[]` if projection hadn't yet run and prev was also `[]`). Bumps tick. Projection re-runs with the populated bucket map. User sees the active quest's bucket (could be empty `[]` if no data, or content). |
  | T2 before T1, T1 sets [], T2 finds active quest bucket on disk | User sees active quest bucket. ✓ | Same. ✓ |
  | T1 before T2, T1 sets [], T2's guard `prev.length > 0` returns prev | User sees `[]`. ✓ | Same. ✓ |
  | T2 finds no on-disk buckets at all (e.g. fresh storage with no chats yet) | T2 falls back to "any bucket of any agent" or "any quest buckets" — could leak legacy content. | T2 returns prev. Bumps tick. Projection re-runs. Empty chat. |

  The "active quest bucket has data on disk" path is
  unchanged. The "active quest bucket empty / no
  quest active" paths are now consistent instead of
  racing.

- The intermittent nature should be eliminated
  because the seed no longer fires an unconditional
  setMessages(DEFAULT) when the projection effect's
  correct render is in flight.

## This is the 8th fix in the same family

The chat-flash family playbook now has:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. Cold-start persistence (v3.11.6)
7. Replay-on-subscribe (v3.11.7)
8. **Seed-fallback data-only** (v3.11.8 — this)

The shared pattern: **every reader/writer of
`messages` consults the anchor.** Layer 8 extends
"every reader/writer" to the AsyncStorage hydration
path — `seedFromPerAgent`, `seedFromLegacy`, and the
old-key migration. These were falling back to legacy
content when the active quest's bucket was empty,
which is the same bug as the cache-replay path:
treating legacy un-attributed content as if it
belonged in an active-quest view.

**Diagnostic tell-tale for layer 8 specifically:**
"user has quest active on desktop; mobile sometimes
shows correct chat, sometimes shows pre-v3.11.0
legacy content with no quest attribution; the wrong
view shows the same messages regardless of which
quest is actually active." The "same messages
regardless of quest" is the smoking gun — that's
the pre-attribution DEFAULT bucket.