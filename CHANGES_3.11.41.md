# v3.11.41 — Pagination: "Load more ↑" button at the top of the chat

## Summary

The chat only renders the most recent N messages by default
(N = 50). A "Load more ↑" button appears at the top of the
chat when there are older messages to reveal. Clicking it
loads the next batch of 50. Matches Discord's
"scroll-up-to-load-history" affordance, but explicit-click
rather than infinite-scroll. Tobe 2026-10-07 16:03: "it
does not need to load all text, it can and should be like
it is in discord, at some point Click load more."

## Behavior

- **Initial state:** Chat shows the last 50 messages (the
 "visible window"). No "Load more" button if there are
 50 or fewer messages.
- **Click "Load more ↑":** visibleCount += 50, the next
 batch of older messages is revealed. The button stays
 visible if more history remains, hidden once all
 messages are loaded.
- **Switching chats:** visibleCount resets to 50 (so the
 user gets the most-recent 50 of the new chat, not the
 N they happened to have open in the previous chat).
- **Position preservation:** Clicking "Load more" does
 NOT yank the user to the bottom. The user stays at
 their current scroll position (now "deeper" into the
 content with older messages above). The ↓ button
 appears because the user is no longer at the bottom of
 the new contentSize.
- **Realtime chat during "load more":** The visible
 window auto-grows to include new messages. visibleCount
 stays the same; new messages are appended at the end
 (within the window if visibleCount > current length;
 outside the window if the bucket grew past it).

## Implementation

1. `visibleCount` state, default 50 (constant
 `VISIBLE_BATCH = 50`).
2. `<FlatList data={messages.slice(-visibleCount)} ...>` —
 renders only the last `visibleCount` messages.
3. `ListHeaderComponent` renders the "Load more ↑"
 button when `messages.length > visibleCount`.
4. `handleLoadMore` callback (defined near
 `removeAttachment`):
 - Increments `visibleCount` by `VISIBLE_BATCH`.
 - Clears the scroll latch (`pendingScrollKeyRef`) so
 the onContentSizeChange handler doesn't fire a
 scrollToEnd that would yank the user to the bottom.
 - Resets `lastProjectedMessagesLenRef.current = -1` so
 a subsequent bucket growth (e.g., a realtime message
 arrival) still fires the scroll-to-bottom latch
 correctly.
5. Projection effect resets `visibleCount` to
 `VISIBLE_BATCH` on `chatChanged` (user picked a
 different chat).

## Side-fix in the same release: stale at-bottom state

The v3.11.40 design had a UX gap: when contentSize grew
without a user scroll (realtime chat arrival, OR "Load
more" prepending), the `chatAtBottomRef` didn't update
(because only the onScroll handler updated it, and
onScroll didn't fire). The ↓ button's visibility went
stale.

Fixed in v3.11.41 by:
- `lastScrollYRef` / `lastViewportHeightRef` (new refs,
 updated by onScroll).
- The onContentSizeChange handler now also computes
 `distanceFromEnd` and updates `chatAtBottomRef` if
 the at-bottom state is stale.

## Files touched

- `package.json` — version bump 3.11.40 → 3.11.41
- `android/app/build.gradle` — versionCode 434 → 435,
 versionName 3.11.40 → 3.11.41
- `src/screens/HomeScreen.tsx`:
  - New `visibleCount` state + `VISIBLE_BATCH` constant.
  - `handleLoadMore` callback.
  - `<FlatList>` switched from `data={messages}` to
 `data={messages.slice(-visibleCount)}`.
  - New `ListHeaderComponent` for the "Load more" button.
  - `onContentSizeChange` updated to also re-derive
 at-bottom state when contentSize grows without a
 latch trigger.
  - `onScroll` updated to cache `lastScrollYRef` /
 `lastViewportHeightRef` for the at-bottom recompute.
  - `lastScrollYRef` / `lastViewportHeightRef` (new refs).
  - Projection effect resets `visibleCount` on
 `chatChanged`.
  - New styles `chatLoadMoreBtn` / `chatLoadMoreText`.

## What did NOT change

- Scroll-to-bottom latch (v3.11.40) is intact.
- Tab nav state preservation (v3.11.39) is intact.
- All other v3.11.33–v3.11.40 changes are kept.

## Manual QA
- [ ] **First load.** Open chat. Last 50 messages visible.
 "Load more ↑" button visible at the top if the chat
 has more than 50 messages.
- [ ] **Click "Load more".** Older messages appear above
 the previous top. Scroll position preserved (you see
 the same content you were seeing, with new older
 messages above you). ↓ button appears.
- [ ] **Click multiple times.** Each click loads 50 more.
 Button disappears once all messages are loaded.
- [ ] **Switch chat.** Switch companion tabs or quests.
 The new chat shows its most-recent 50 (or fewer).
- [ ] **Realtime chat during load-more.** With "Load
 more" active, receive a new chat. The new message
 appends to the end of the visible window (and
 visibleCount auto-grows if needed).
- [ ] **Realtime chat while at the bottom.** The
 `chatAtBottomRef` correctly flips to false when a
 new message arrives and the user was at the bottom
 (the stale-at-bottom fix).

## Risk

Low. The load-more is a stateful addition that doesn't
change the existing scroll behavior. The stale-at-bottom
fix is a strict improvement (no regressions — the
onContentSizeChange at-bottom recompute only updates
state, never triggers a scroll).

## Rollback

`git revert v3.11.41` restores v3.11.40. The chat renders
all messages at once (no pagination), and the stale-
at-bottom gap returns.