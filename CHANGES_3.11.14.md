# v3.11.14 — scroll position is preserved across hydrate re-runs of the projection effect

Tobe (2026-09-27 18:29, Discord #cyber-dev):

> "Okey it might have been fixed now. But there is a
> new issue with the chat where it does not want to go
> to the bottom, it just skips up and its very, hmm,
> jumpy up and down. It should just be smooth and
> exactly like discord chat is."

The "— No quest" pill is gone in v3.11.13 + desktop
v3.3.19 (constructor fix). New symptom: scroll
oscillation.

## Root cause

The projection effect — which renders the visible
chat panel from `messagesByAgentAndQuest[aid][bucketKey]`
based on the active quest anchor — runs whenever
`[activeChatAgentId, activeChatQuestId, anchorHydrateTick]`
changes. Many things bump `anchorHydrateTick`: every
agent_history response, every chat_history response, the
AsyncStorage hydrate of the scroll-offset map, etc.

Pre-v3.11.14, every projection-effect run did:

```ts
setMessages(bucket);
setChatAtBottom(true);   // ← problem
```

The unconditional `setChatAtBottom(true)` snapped the
user back to the bottom on EVERY projection-effect run.
If the user had scrolled up to read history:

1. User scrolls up. `onScroll` fires.
   `distanceFromEnd > 50` → `setChatAtBottom(false)`.
   `chatAtBottomRef.current = false`.
2. AsyncStorage hydrate completes (or agent_history
   lands, or chat_history lands) → projection effect
   re-runs. `setChatAtBottom(true)` snaps user back to
   bottom mid-read.
3. Next content size change → `onContentSizeChange` →
   `chatAtBottomRef.current === true` → `scrollToEnd`.
   User yanked away from where they were reading.

Multiple hydrate events in succession (which is normal
during the cold-start window: chat_history + agent_history
× N agents + first broadcast) produced the "skips up
and down" oscillation Tobe saw.

## Fix

Track the last-projected `(aid, bucketKey)` in a
component-scope ref. Only setChatAtBottom(true) when
the key actually CHANGED — i.e. the user is looking at
a different conversation (different agent or different
quest bucket). When the projection re-runs for the same
bucket (just refilling with newer data), leave
chatAtBottom alone, letting the onScroll handler remain
the source of truth for "is the user at the bottom?"

```ts
const projectedKey = `${aid}::${bucketKey}`;
if (lastProjectedKeyRef.current !== null &&
    lastProjectedKeyRef.current !== projectedKey) {
  // Bucket changed — jump to bottom of new bucket.
  setChatAtBottom(true);
}
lastProjectedKeyRef.current = projectedKey;
```

Component-scope ref (not module-scope) so the
HomeScreen unmount→remount cycle correctly treats the
first projection after remount as a "different bucket"
and snaps to bottom (matching Discord's behavior of
opening to the bottom of a chat).

This is Discord's behavior:
- New message arrives while at bottom → smooth scroll
  to bottom (onContentSizeChange → scrollToEnd when
  chatAtBottom === true).
- User scrolls up → stays put (onScroll updates
  chatAtBottom → next onContentSizeChange no-ops).
- User scrolls back to bottom → auto-follow resumes.

## Files changed

- `src/screens/HomeScreen.tsx`
  - Added `lastProjectedKeyRef` to track the
    last-projected `(aid, bucketKey)`.
  - Projection effect: only `setChatAtBottom(true)` on
    bucket change. Preserve on same-bucket re-runs.
- Bumps: `package.json` 3.11.13 → 3.11.14.
- `versionCode` 409 → 410, `versionName` "3.11.13"
  → "3.11.14".

## Strong rule

**State setters in a projection/derivation effect must
distinguish "projection switched to a different
derived value" from "projection re-ran for the same
derived value." Only the former should reset
user-facing position state.**

The original code conflated the two cases and
unconditionally reset chatAtBottom. The reset is only
correct on a genuine projection change; on a same-value
re-run (re-hydrate, re-broadcast), resetting chatAtBottom
overwrites the user's current scroll-intent state and
snaps them to the bottom mid-read.

Pattern:

```ts
// ❌ Reset position state on every projection-effect run:
useEffect(() => {
  setMessages(bucket);
  setChatAtBottom(true);  // always — wrong
}, [deps]);

// ✓ Only reset on a genuine projection change:
useEffect(() => {
  setMessages(bucket);
  const projectedKey = computeKey(bucket);
  if (lastKey.current !== null && lastKey.current !== projectedKey) {
    setChatAtBottom(true);  // user is in a different bucket
  }
  lastKey.current = projectedKey;
}, [deps]);
```

The "is this a different value?" check belongs on the
DERIVED value (the bucket key), not the dependency
inputs (which include things like `anchorHydrateTick`
that bump for unrelated reasons).

## Lesson

When a state setter has user-facing side effects
(snap-to-bottom, scroll-restore, animation-trigger),
guard it behind a "did the projection actually
change?" check. The "always reset on re-run" pattern
is a footgun for any state that has both
derivation-time and user-intent semantics.
