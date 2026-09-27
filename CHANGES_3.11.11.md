# v3.11.11 — anchor persistence on first broadcast + parity fix for seed paths

Tobe (2026-09-27 12:31, Discord #cyber-dev):

> "@Clawsuu there is still some bug where it goes
> no no active quest chat when i reopen the app
> after a while. And then it tries to force scroll
> to the bottom but stops and this time, this area
> where it jumps up and down quickly in a loop"

Screenshot (v3.11.10): active companion is Clawsuu,
pill says "— No quest", chat shows the legacy DEFAULT
bucket content (database-related messages, latest one
"Live proof just now..." at the bottom). Tobe has the
Cyber_Database quest active on desktop.

## Root cause

Two bugs that both produce the same chat-flash symptom
but for different reasons. v3.11.10 fixed one
(`onChatHistory`) but missed the other (anchor
persistence on first broadcast).

### Bug A: Case 1 in `onQuestsList` didn't persist the anchor

```ts
// v3.11.0..v3.11.10
if (mobileActiveQuestAnchor === null) {
  // Case 1: no anchor yet. Fresh broadcast —
  // adopt.
  mobileActiveQuestAnchor = nextQid;   // ← direct assignment
  activeQuestRef.current = next;
  setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
  return;
}
```

The anchor is set in memory (the module-scope variable
+ the React state mirror) but **never persisted to
AsyncStorage**. So on the next cold start, the
bootstrap IIFE reads AsyncStorage, finds no
`cyberclaw-mobile-active-quest-anchor` key, and
leaves the anchor at module-init `null`.

**When does this hit?** When the user has NEVER
opened QuestsScreen on mobile and tapped a quest.
The desktop-driven anchor is the only way the mobile
knows which quest is active — and the desktop-driven
anchor wasn't being persisted. Common case: users who
do all their quest management on the desktop (the
typical desktop-first workflow) and only use the
mobile for chat. Tobe fits this profile.

**The "after a while" framing.** Android kills the
JS process after the app has been backgrounded for
a while (5–30 min depending on memory pressure and
device). On reopen, JS reinitializes from scratch:
module-scope state is gone, AsyncStorage is read
fresh. If the anchor was only in module-scope
memory, it's lost. If the anchor was in AsyncStorage,
it survives.

### Bug B: `seedFromLegacy` and `seedFromPerAgent` migration paths didn't check `_anchorBootstrapResolved`

This is the same pattern as v3.11.10's `onChatHistory`
fix — the `activeQid === null` check conflates two
states:
- Bootstrap pending (anchor will become something
  soon, like `'database'`).
- Bootstrap resolved with `null` (user explicitly
  deactivated, or never persisted anything).

v3.11.10 fixed this for `onChatHistory`. But it
missed `seedFromLegacy` (line ~2761) and the legacy
migration path in `seedFromPerAgent` (line ~2942).

**When does this hit?** On a slow first start
(AsyncStorage.getItem takes >300ms on Hermes with
cold JSI bridge). The seed paths run before the
bootstrap IIFE resolves. With v3.11.10's patch
applied to `onChatHistory`, the legacy DEFAULT bucket
content would NOT leak through chat_history. But it
could still leak through `seedFromLegacy` (which
reads the `cyberclaw-chat-history` key) — if the
legacy key has data and the agent is known (from a
cached `cyberclaw-agents-cache` hydrate), the seed
path sets messages to the legacy DEFAULT bucket
content. The projection effect's layer 4 guard
(`_anchorBootstrapResolved=false → skipBucketLookup`)
runs but uses `messagesByAgentRef.current` which
hasn't been updated by the seed path's `prev`-based
updater yet, so the projection effect sees an empty
bucket. Result: messages flip from [legacy_content]
→ [] once the projection effect catches up.

This is a one-flip, not a loop. But it's the same
chat-flash symptom that v3.11.10 was supposed to
eliminate.

## Fix

### Bug A: anchor persistence on Case 1

```ts
// v3.11.11
if (mobileActiveQuestAnchor === null) {
  // Case 1: no anchor yet. Fresh broadcast —
  // adopt.
  //
  // v3.11.11: persist via setMobileActiveQuestAnchor
  // instead of direct assignment. The desktop-driven
  // anchor (set here when the user never tapped a
  // quest on mobile) needs to survive the JS process
  // being killed by Android.
  setMobileActiveQuestAnchor(nextQid);
  activeQuestRef.current = next;
  setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
  return;
}
```

`setMobileActiveQuestAnchor` writes the module-scope
variable AND fires a fire-and-forget AsyncStorage
write. `null` → `'__null__'` sentinel, string → the
qid. Safe to call here because:
- This branch only fires when the anchor is `null`
  AND a fresh broadcast confirms the desktop's current
  active.
- Once the anchor is set, subsequent broadcasts hit
  Case 2 (matches) or Case 3 (differs) and don't
  trigger another AsyncStorage write.
- The bootstrap IIFE reads AsyncStorage before setting
  `_anchorBootstrapResolved = true`, so even if the
  write races the bootstrap read, both paths
  converge on the same in-memory anchor.

### Bug B: parity fix for seed paths

Both `seedFromLegacy` and the legacy migration path
in `seedFromPerAgent` now gate the `activeQid ===
null` fall-through on `_anchorBootstrapResolved`:

```ts
// v3.11.11 (seedFromLegacy)
setMessages(prev => {
  if (prev.length > 0) return prev;
  const activeQid = mobileActiveQuestAnchor ?? null;
  if (activeQid !== null) {
    setAnchorHydrateTick(t => t + 1);
    return prev;
  }
  // activeQid === null — same (a)/(b) distinction as
  // v3.11.10's onChatHistory.
  if (!_anchorBootstrapResolved) {
    // (a) Bootstrap pending. Show empty; bootstrap
    // will resolve and bump tick.
    setAnchorHydrateTick(t => t + 1);
    return prev;
  }
  // (b) Bootstrap resolved with null — surface
  // legacy DEFAULT bucket content.
  // ...existing fall-through logic...
});
```

Same shape in the legacy migration path inside
`seedFromPerAgent`.

## Files changed

- `src/screens/HomeScreen.tsx`
  - `onQuestsList` Case 1: switched from direct
    `mobileActiveQuestAnchor = nextQid` to
    `setMobileActiveQuestAnchor(nextQid)` so the
    desktop-driven anchor gets persisted to
    AsyncStorage. Survives Android killing the JS
    process after backgrounding.
  - `seedFromLegacy`: added `_anchorBootstrapResolved`
    check before falling through to legacy DEFAULT
    bucket content. Parity with v3.11.10's
    onChatHistory fix.
  - `seedFromPerAgent` legacy migration path: same
    parity check.
- Bumps: `package.json` 3.11.10 → 3.11.11.
- `versionCode` 406 → 407, `versionName` "3.11.10"
  → "3.11.11".

## What's NOT fixed by this release

The "jumps up and down quickly in a loop" symptom
in Tobe's report. My read on this:

- Likely **keyboard insets resizing the chat panel**
  rapidly (Android can fire `keyboardDidShow` /
  `keyboardDidChange` events with slightly different
  heights during the open animation). Each resize
  shrinks the FlatList's visible area, which fires
  `onContentSizeChange`, which calls `scrollToEnd`
  if `chatAtBottomRef.current === true`. If the
  heights keep changing for a few frames, the
  FlatList scrolls to bottom, content shifts up,
  visible area shrinks more, scrolls again, etc.

- Could also be the **projection effect re-running
  with new bucket references** that have the same
  content. Each re-run calls `setMessages(bucket)`;
  if the bucket is a new array reference (e.g.
  because `seedFromLegacy` rebuilt it), `setMessages`
  doesn't bail out (different reference). FlatList
  re-measures. `onContentSizeChange` fires.
  `scrollToEnd`. If this happens multiple times in
  quick succession (e.g. projection effect re-runs
  twice during the cold-start window), the user sees
  a brief scroll-jump loop.

These are both **layout/render loops**, not the
chat-flash bug. The fix for them is a follow-up
(likely: gate `setChatAtBottom(true)` in the
projection effect behind `chatInitialDecisionRef`,
and skip the v3.8.6 belt-and-suspenders effect if
the initial decision has already been made).

Will investigate separately. Tobe should test this
v3.11.11 build for the "— No quest" pill first;
if that's gone, the chat-flash part of the report
is fixed and the scroll-jump is a separate bug.

## Diagnostic tell-tale for "anchor not persisted"

- User has a quest active on desktop.
- Mobile's chat pill says "— No quest".
- Chat shows the legacy DEFAULT bucket content (the
  bubble pill says "— No quest" on every message).
- The active quest's bucket IS populated on disk
  (`cyberclaw-chat-byagent-byquest[aid][questKey]`
  has messages).
- Cold start triggers "go into Quests and back" —
  which forces a `handleSetActive` call that DOES
  persist via `setMobileActiveQuestAnchor`. After
  this, the chat shows the correct bucket.

The "go into Quests and back fixes it" pattern is
the smoking gun. `handleSetActive` is the only
write path that was going through
`setMobileActiveQuestAnchor`. If that fixes it, the
diagnosis is confirmed.

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-traced all four timing windows for the
  seed-path parity fix (same matrix as v3.11.10):
  - **Cold start, bootstrap slow (>300ms), active
    quest persisted**: seed paths now return prev
    (don't leak DEFAULT). Projection effect picks
    up after bootstrap. ✓
  - **Cold start, bootstrap fast (<300ms)**: seed
    paths see resolved anchor and either return
    prev (active quest) or surface DEFAULT
    (resolved null). ✓
  - **Cold start, first run (no persisted anchor)**:
    seed paths surface DEFAULT (user has no quest
    anywhere). ✓
  - **Cold start, persisted `'__null__'` (user
    explicitly deactivated)**: bootstrap resolves
    with null, seed paths surface DEFAULT. ✓
- Hand-traced Case 1 persistence race:
  - **Fresh broadcast before bootstrap completes**:
    Case 1 sets anchor in memory. AsyncStorage write
    initiated. Bootstrap completes later, reads
    AsyncStorage — either sees the write (if
    completed) or sees no key (if write is still
    pending). Both paths leave the in-memory
    anchor correct. ✓
  - **Bootstrap completes before Case 1 fires**:
    Bootstrap reads persisted value (if any) or
    leaves anchor at module init null. Case 1 then
    fires, sets anchor in memory, persists. ✓
  - **Anchor is `'__null__'` persisted, then desktop
    later broadcasts fresh with a real active**: On
    next cold start, bootstrap reads `'__null__'`,
    sets anchor to null. Fresh broadcast arrives,
    Case 1 fires with real qid, overwrites anchor
    AND persists the real qid. Subsequent cold
    starts load the real qid. ✓

## This is the 11th fix in the chat-flash family

The cross-cutting rule is now:

> "Every reader/writer of `messages` and every
> bucket-key lookup must distinguish 'anchor is
> null because bootstrap pending' from 'anchor is
> null because user deactivated' — AND the anchor
> must be persisted whenever a fresh broadcast
> confirms a new active, not just when the user
> explicitly picks one on the mobile."

Full family:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. Cold-start persistence (v3.11.6)
7. Replay-on-subscribe (v3.11.7)
8. Seed-fallback data-only (v3.11.8)
9. onChatHistory reads the anchor (v3.11.9)
10. Bootstrap-pending is distinct from
    user-deactivated (v3.11.10)
11. **Anchor persistence on Case 1 + parity fix
    for seed paths** (v3.11.11 — this)

**Lesson (added to MEMORY.md):**

When the source of truth lives on a different
device and is mirrored via broadcasts, **every
write path that adopts the mirrored value must
also persist it locally**. Otherwise the mirror
is lost when the local process restarts, and the
user sees the bootstrap-time fallback state.

This is true even when the broadcast has a
freshness tag — the freshness tag only tells you
"trust this for state mutation right now." It
doesn't tell you "this is the value you should
remember when I go away."

The pattern from this fix:

```ts
// ❌ Direct assignment (lost on process restart)
mobileActiveQuestAnchor = nextQid;

// ✅ Persisted assignment (survives process restart)
setMobileActiveQuestAnchor(nextQid);
```

The performance cost of the extra AsyncStorage
write is negligible (it's fire-and-forget, doesn't
block the broadcast handler). The benefit is that
a user who relies entirely on the other device's
state (the common case for desktop-driven
mirrors) doesn't lose their state on every
process restart.
