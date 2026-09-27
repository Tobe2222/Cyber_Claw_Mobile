# v3.11.15 — Discord-style scroll behaviour: one source of truth, animated

Tobe (2026-09-27 20:52, Discord #cyber-dev):

> "@Clawsuu the chat is jumping up and down like crazy
> now. I just want normal behaviour like discord has"

v3.11.14 made the chat less jumpy by stopping the
projection effect from snapping `chatAtBottom` to true
on same-bucket re-runs. But Tobe's report shows the chat
is still jumpy — different mechanism, same symptom.

## Root cause: redundant scroll-to-end paths

The chat had FOUR places that called `scrollToEnd` or
related scroll operations. Each fired on different
conditions, sometimes simultaneously, sometimes racing:

1. `onContentSizeChange` handler — fired whenever the
   FlatList measured new content size. Triggered on
   layout reflows (keyboard show/hide), data updates,
   AND new messages. Used `animated: false`.

2. New-message effect (line ~5568) — fired when
   `messages.length` changed. Used `setTimeout(50)` to
   schedule a `scrollToEnd({ animated: false })` if the
   user was at the bottom.

3. v3.8.6 first-paint effect (line ~5802) — fired 200ms
   after `messages.length > 0` became true (i.e. on the
   first non-empty render). Called `scrollToEnd({ animated:
   false })` unconditionally.

4. Restore effect (line ~1843) — one-shot per mount.
   `scrollToOffset(savedOffset)` for restored position.

When multiple paths fired in rapid succession (which
happens during the cold-start window AND on every
agent_history / chat_history hydrate), the chat would
jump-and-settle multiple times. Each `scrollToEnd` was
animated: false, so each was a visible jump. The user
perceived this as "jumps up and down like crazy."

Example timeline of a single cold-start hydrate burst:

- t=0ms: agent_history arrives. bucket populates.
- t=5ms: messages.length went 0 → N. New-message effect
  schedules `setTimeout(scrollToEnd, 50)`.
- t=8ms: messages.length > 0 flipped. v3.8.6 effect
  schedules `setTimeout(scrollToEnd, 200)`.
- t=10ms: FlatList re-measures. onContentSizeChange
  fires. `scrollToEnd({ animated: false })` immediately.
- t=55ms: New-message effect's timer fires.
  `scrollToEnd({ animated: false })` again.
- t=210ms: v3.8.6 effect's timer fires.
  `scrollToEnd({ animated: false })` a third time.

Three scrollToEnd calls within 200ms. If any of them
land at a different contentSize (because hydrate landed
mid-burst), the chat position visibly jumps three times.

## Fix: one source of truth, animated

Removed the redundant scroll paths. The
`onContentSizeChange` handler is now the single
auto-scroll trigger. It uses a `prevMessagesLengthRef`
to distinguish two cases:

- `messages.length` GREW → new message arrived.
  Auto-scroll to bottom if user is at the bottom.
- `messages.length` STAYED THE SAME → layout reflow
  (keyboard, font scale, hydrate re-render of same
  messages). Do nothing — preserve user's scroll
  position.

Plus `animated: true` so the scroll is smooth instead
of jumpy, matching Discord's behaviour.

```ts
onContentSizeChange={() => {
  if (!chatInitialDecisionRef.current) return;
  const grew = messages.length > prevMessagesLengthRef.current;
  prevMessagesLengthRef.current = messages.length;
  if (grew && chatAtBottomRef.current) {
    chatRef.current?.scrollToEnd({ animated: true });
  }
}}
```

Also removed:
- The new-message effect's `setTimeout(scrollToEnd, 50)`
  block (redundant with onContentSizeChange).
- The v3.8.6 first-paint effect entirely (redundant with
  onContentSizeChange for the grew=true path).

The restore effect (one-shot scrollToOffset for saved
position) stays as-is — it operates on a different axis
(user's saved scroll position vs new-message
auto-follow).

## What's NOT in this release

The "v3.10.181 restore decision" still has a polling
loop (`setTimeout(poll, 75)` up to 8 attempts) to wait
for the AsyncStorage hydrate. Tobe's flow:

1. Cold start. Restore polls for hydrate.
2. During the polling window, agent_history and
   chat_history can land and re-populate the bucket.
3. Hydrate finishes. Restore makes decision. Scrolls to
   saved offset.

If the saved offset was near the bottom (typical case),
scrollToOffset(bottom) → onScroll → setChatAtBottom(true).
Future onContentSizeChange → grew=true (a new message
arrived after) → scrollToEnd(animated:true). Smooth.

If the saved offset was mid-history, scrollToOffset(mid)
→ onScroll → setChatAtBottom(false). Future
onContentSizeChange → grew=true but chatAtBottom=false
→ no scroll. User stays where they want. ✓ Discord-like.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Added `prevMessagesLengthRef` to track previous
    `messages.length`.
  - `onContentSizeChange` now distinguishes new-message
    arrival (grew) from layout reflow (same length).
    Uses `animated: true` for the new-message case.
  - Removed the new-message effect's duplicate
    `scrollToEnd` (kept the task-card collapsing logic).
  - Removed the v3.8.6 first-paint effect entirely.
- Bumps: `package.json` 3.11.14 → 3.11.15.
- `versionCode` 410 → 411, `versionName` "3.11.14"
  → "3.11.15".

## Strong rule

**One scroll handler per chat panel. Distinguish
"new content" from "layout reflow" by tracking the
data-length delta.** Layout reflows preserve the
user's scroll position; only new content triggers
auto-follow. This is Discord's behaviour and what
mobile chat users expect.

The previous design had three different scroll paths
that fired on overlapping conditions, producing
visible jumps whenever any two of them raced. Removing
the duplicates and gating the surviving one on a
delta check eliminates the bounce.

## Lesson

When a FlatList (or any virtualised list) is asked to
"follow new content," the "new content" check must be
a DATA check (`messages.length` grew), not a LAYOUT
check (`onContentSizeChange` fired). The layout check
fires on:
- new messages arriving (correct — follow)
- agent_history / chat_history re-rendering same
  messages (incorrect — preserve)
- keyboard show/hide (incorrect — preserve)
- font scale change (incorrect — preserve)
- window rotation (incorrect — preserve)
- FlatList remount (depends — usually preserve)

Only the first case should auto-scroll. The
`prevLengthRef` delta check is the cheapest correct
filter. Anything that filters on `onContentSizeChange`
alone will over-trigger.
