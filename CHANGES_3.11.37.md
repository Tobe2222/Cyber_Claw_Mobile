# v3.11.37 — Chat scroll: stop the "berzerk" multiple-scroll on cold open

## Summary

v3.11.33's scroll-to-bottom useEffect was firing on every
`anchorHydrateTick` increment, which means once per
`chat_history` batch during cold-start hydration. Three
batches in two seconds meant three animated `scrollToEnd`
calls back-to-back — visible as the chat "going berzerk up
and down to the same positions" (Tobe 2026-10-07).

The fix: moved the scroll-to-bottom scheduling INTO the
projection effect itself, gated on TWO conditions (bucket
switch OR messages-went-from-empty-to-populated) that fire
exactly once each per chat-switch.

## What changed

### 1. Removed v3.11.33's dedicated scroll-to-bottom useEffect

Deleted. It watched `[activeChatAgentId, activeChatQuestId,
anchorHydrateTick]`. The third dep was the problem — every
chat_history batch that lands during cold-start hydration
increments `anchorHydrateTick` (chat-history merge handler
at line ~4303), which retriggered the effect, which fired
`scrollToEnd` again. Animated:true meant the user saw the
chat visibly snap to the bottom multiple times.

### 2. Scroll-to-bottom moved into the projection effect

The projection effect (already runs on every chat_history
batch) now schedules the scroll itself, but only when one
of these is true:
- **chatChanged**: the (aid, bucket) we're projecting to is
 different from last time (`lastProjectedKeyRef.current`).
- **messagesArrived**: the new bucket's length went from
 zero to non-zero (`lastProjectedMessagesLenRef.current`
 was 0, `bucket.length > 0`).

Both refs are updated after the scroll is scheduled, so
subsequent chat_history batches on the same bucket
(length 5 → 8 → 12) do NOT retrigger.

### 3. Re-added `lastProjectedKeyRef` (and new `lastProjectedMessagesLenRef`)

These were removed in v3.11.33 as part of the scroll-restore
deletion. Brought them back as the latch mechanism for the new
in-projection scroll.

### 4. Single rAF instead of rAF + 250ms double-fire

The previous design scheduled two passes — a rAF (one
frame) and a 250ms timer — to catch slow hydration. The
projection effect's new `messagesArrived` branch handles
late-arriving chat_history on its own (the hydration
increment re-runs the projection effect with the latch
reset). So a single rAF is enough.

### 5. Refs for in-flight scroll cancellation

`pendingScrollRafRef` tracks the rAF handle so the next
projection-effect call (caused by a fresh
`anchorHydrateTick` or a chat-switch in flight) can cancel
a stale pending scroll. Without this, two projections in
quick succession could both schedule scrolls, and the first
one might land the chat at the wrong position.

## What did NOT change

- The ↓ jump-to-bottom button is still rendered when
 `!chatAtBottom`.
- New messages still do NOT auto-scroll the chat.
- Scroll-restore-on-revisit is still removed.

## Files touched

- `package.json` — version bump 3.11.36 → 3.11.37
- `android/app/build.gradle` — versionCode 430 → 431,
 versionName 3.11.36 → 3.11.37
- `src/screens/HomeScreen.tsx`:
  - Deleted v3.11.33's dedicated scroll-to-bottom useEffect
 (~80 lines, lines ~1772–1829).
  - Added 2 refs (`lastProjectedKeyRef`,
 `lastProjectedMessagesLenRef`, `pendingScrollRafRef`) near
 the other draft refs at line ~1149.
  - Projection effect (~line 1616): added scroll-to-bottom
 scheduling at the end of the effect, gated on
 `chatChanged || messagesArrived`.

## Manual QA
- [ ] Force-stop the app, reopen. ONE smooth scroll to the
 bottom on open. No multiple scrolls.
- [ ] Switch companion tabs (Clawsuu → Lamasuu → Clawsuu).
 ONE scroll per tab switch, never on intermediate
 re-renders.
- [ ] Switch quests (Quest A → Quest B → back to A). ONE
 scroll per switch.
- [ ] Cold open the app with 5 chat_history batches
 landing in <2 seconds. ONE scroll total (when the first
 batch populates the bucket), then the chat sits still.
- [ ] Scroll up to read history. New agent reply arrives.
 Chat does NOT yank to bottom. ↓ badge appears.
- [ ] Tap ↓ badge. Chat scrolls to bottom.

## Risk

Low. The projection effect already had scroll-related
latching logic (the v3.11.14 "setChatAtBottom(true) on
bucket switch" hack which v3.11.33 removed). The new code
is a more carefully-latched version of the same idea, with
explicit scrollToEnd calls added.

## Rollback

`git revert v3.11.37` restores v3.11.36's dedicated
useEffect (with `anchorHydrateTick` in deps). The
multiple-scroll symptom returns immediately on cold open.