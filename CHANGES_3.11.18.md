# v3.11.18 — restore per-bubble quest pill (always); debounce scrollToEnd to fix chat-jump

Tobe (2026-09-28 12:37, Discord #cyber-dev):

> "I looked at cyberclaw on the mobile again and the chat
> does not bounce around anymore, which is good. But the
> text to show which quest chat it is, is gone. See image.
> The top right of the text bubble does not say which quest
> we are on anymore.
>
> And actually i tested some more, i was at the bottom of the
> chat and it suddenly moved upwards a bit, i dragged it down
> again, and it happened like 20 seconds after again."

Two distinct symptoms. This release addresses both.

## Symptom 1: quest pill gone from bubbles in active-quest chat

v3.11.17 suppressed the per-bubble quest pill when the user
was on an active quest AND the bubble matched that quest.
The intent was to reduce visual noise — every bubble in the
active quest's chat would have shown the same pill text
(e.g. `🎯 Cyber_Database`), which read as redundancy rather
than as confirmation.

Tobe's feedback after using v3.11.17 for a day: he actually
WANTED the pill on every bubble. The active-quest name in
the chat header was not a substitute — at-a-glance per-bubble
attribution is the affordance he was using to confirm
"this chat is showing me the right conversation". The
v3.11.17 visual-noise concern only mattered for the
`— No quest` case (legacy / pre-active-quest bubbles),
not for the matching-bubble case.

### Fix

Always render the per-bubble pill when the bubble carries
a quest stamp. For bubbles WITHOUT a quest stamp (legacy /
DEFAULT-bucket content, or messages that pre-date the
user's quest activation), render NO pill at all — no Text
node, no flexbox slot, no label string. This addresses
both v3.11.5's original complaint (visual noise from
`— No quest` on every legacy bubble) AND Tobe's
2026-09-28 feedback (no pill at all).

```tsx
// v3.11.18: always render the pill when there's a
// quest stamp; render nothing for legacy bubbles.
{(() => {
  if (item.activeQuestId == null) return null;
  const name = item.activeQuestName
    || questNameFromId(item.activeQuestId);
  if (!name) return null;
  return (
    <Text style={[styles.bubbleQuestLabel, ...]} numberOfLines={1}>
      {name}
    </Text>
  );
})()}
```

Notable design choices:

- **No `🎯` emoji.** v3.11.5's pill text was
  `🎯 <name>`. The emoji was ~14dp wide on small Android
  screens, eating into the pill's available width and
  truncating long quest names. The pill's background
  color (cyan-tinted for user bubbles, accent-tinted
  for agent bubbles) is already a strong visual cue
  that this is a quest chip — the emoji added nothing
  and cost real estate.
- **Fallback to `questNameByIdRef` if `activeQuestName`
  is missing.** The desktop v3.3.19+ stamps
  `activeQuestName` on every chat message, so this is
  belt-and-suspenders for old-desktop echoes. The map
  is populated by `onQuestsList` so it's always
  current.
- **No `(unnamed quest)` placeholder.** If we don't
  know the name, we suppress the pill entirely rather
  than render a placeholder. Empty is less confusing
  than `🎯 (unnamed quest)`.

## Symptom 2: chat "moves upwards" every ~20s

Tobe at the bottom, scrolls, the chat scrolls itself up a
bit (he sees blank space at the bottom), he drags back
down, ~20s later it happens again.

### Root cause

Two interacting bugs:

1. **`onContentSizeChange` fires scrollToEnd against
   a stale `contentSize`.** A single render that adds a
   bubble AND reflows existing bubble heights (e.g., a
   bubble's text rewrapped after a state update, or —
   less likely now that pill suppression is gone — a
   pill rendered/removed on a re-render) can fire
   `onContentSizeChange` 2–3 times in rapid succession.
   The first fire has the smallest `contentSize` (the
   FlatList is mid-measure), so `scrollToEnd({ animated: true })`
   targets a position that's already invalid. By the
   time the FlatList settles, the user's scroll
   position is short of the new bottom — visible as
   blank space at the bottom of the chat.

2. **`chatAtBottomRef` is stale after a reflow-only
   `onContentSizeChange`.** v3.11.17 gated the
   auto-scroll on `chatAtBottomRef.current && grew`.
   When a layout reflow happens WITHOUT a new bubble
   (`grew === false`), the auto-scroll is skipped
   entirely — even if the user WAS at the bottom
   before the reflow and the reflow shrunk
   `contentSize`. The user's scrollY is preserved but
   contentSize shrunk, leaving them above the new
   bottom.

### Fix

Three changes to the `onContentSizeChange` handler:

1. **New `lastDistanceFromEndRef`** updated on every
   `onScroll` event. Captures the user's last-known
   distance from the bottom (not just the boolean
   `chatAtBottomRef`). Used by the
   `onContentSizeChange` handler to decide whether to
   re-anchor, even when `onScroll` hasn't fired since
   the layout changed.

2. **Wider "near bottom" threshold (100px vs 50px).**
   The onScroll handler still uses 50px for its
   boolean `isAtBottom` (tight enough that a small
   user-scroll doesn't keep re-anchoring them). But
   the `onContentSizeChange` handler uses 100px
   (loose enough that the user's "near-bottom"
   intent survives contentSize drift between the
   last onScroll and the current contentSizeChange).

3. **Debounced `scrollToEnd`** — when the handler
   decides to scroll, it queues a `setTimeout(80ms)`
   instead of scrolling immediately. Each
   `onContentSizeChange` resets the timer, so 2–3
   rapid fires coalesce into a single `scrollToEnd`
   issued 80ms after the LAST fire. By that point
   the FlatList's multi-pass layout has settled and
   the target is stable.

4. **Re-anchor on reflow-only changes too** (not just
   `grew`). The previous logic only re-anchored when
   `messages.length` grew. Now we re-anchor on ANY
   `onContentSizeChange` while the user is near the
   bottom, including reflow-only changes. This
   catches the case where the FlatList shrinks
   `contentSize` (e.g., a bubble's text rewrapped
   after a state update) and leaves the user above
   the new bottom.

The pre-existing `grew` check is kept for the
`prevMessagesLengthRef` update (so future per-message
handlers can still rely on it) but no longer gates the
scroll.

```tsx
// v3.11.18
const wasNearBottom =
  chatAtBottomRef.current ||
  lastDistanceFromEndRef.current < 100;
if (wasNearBottom) {
  if (scrollSettleTimerRef.current) {
    clearTimeout(scrollSettleTimerRef.current);
  }
  scrollSettleTimerRef.current = setTimeout(() => {
    scrollSettleTimerRef.current = null;
    if (chatAtBottomRef.current) {
      chatRef.current?.scrollToEnd({ animated: true });
    }
  }, 80);
}
```

### Cleanup

The new `scrollSettleTimerRef` is cleared in the
HomeScreen unmount effect (alongside the existing
`thinkingEscalateTimerRef` cleanup at v3.10.133). An
unmount mid-settle no longer leaves a dangling
setTimeout that fires on a stale `chatRef`.

## Why this is one release and not two

Both fixes touch the same render path (the chat FlatList)
and both stem from the same architectural issue:
**mirror-based UI state that's not in lockstep with the
underlying content.** The pill bug is "which view
mirrors the source of truth"; the scroll bug is "when
does the mirror get re-anchored". Splitting them into two
releases would mean one bug fix at a time and twice the
chance of Tobe re-testing without the other fix
in place.

## Files

- `src/screens/HomeScreen.tsx`
  - `lastDistanceFromEndRef`, `scrollSettleTimerRef` —
    new module-scope refs.
  - `onScroll` handler — writes
    `lastDistanceFromEndRef.current`.
  - `onContentSizeChange` handler — uses
    `wasNearBottom` + debounced `scrollToEnd`.
  - `renderMessage` bubble header — conditional pill
    render with no `(unnamed quest)` fallback.
  - Unmount effect — clears `scrollSettleTimerRef`.

## Deploy notes

Mobile v3.11.18 only. No desktop changes required —
this is purely a UI-state correctness fix on the mobile.
Compatible with any desktop version ≥ v3.3.16 (which
introduced per-bubble quest stamping via the
`addChatMsg` `activeQuestId` / `activeQuestName`
fields).
