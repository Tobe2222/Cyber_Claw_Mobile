# v3.11.40 — Chat scroll: drive scroll-to-bottom off onContentSizeChange

## Summary

v3.11.39's rAF+setTimeout approach still left the chat at the
top on cold open (Tobe 2026-10-07 17:29: "It still started at
top"). The rAF was firing before the FlatList had measured
its content, scrollToEnd was a no-op, and the rAF consumed
the latch — cancelling the 100ms setTimeout fallback. The
scroll was permanently lost.

The fix: drive the scroll off the FlatList's
onContentSizeChange event, which fires AFTER the FlatList
has measured its content — the exact moment when
scrollToEnd actually works.

## Root cause

v3.11.37's projection-effect schedule used
`requestAnimationFrame(scrollToEnd)`. The rAF fires on the
next frame after the projection effect runs (which is during
React's commit phase, after the state update for the new
data). The FlatList's measurement pass is async — it
happens on the next layout cycle, not the same commit
cycle. So the rAF fired before the FlatList had measured,
scrollToEnd read contentSize=0, and was a no-op.

v3.11.38 tried to fix this with `animated:false` (instant
scroll, no animation drift). But instant scroll requires
the contentSize to be already known at the moment of the
call. Same race condition.

v3.11.39 added a 100ms setTimeout fallback. The rAF fired,
consumed the `didScroll` latch, cancelled the setTimeout.
The setTimeout never got to retry. The scroll was lost.

## Fix (v3.11.40)

The scroll now lives in the FlatList's onContentSizeChange
handler. The projection effect sets a LATCH
(`pendingScrollKeyRef`) when (chatChanged || bucketGrew)
fires. The onContentSizeChange handler consumes the latch
on its FIRST fire where the FlatList has non-zero content
and runs the scroll. Subsequent fires (the v3.11.27
multi-pass concern) see a null latch and are no-ops.

```ts
// Projection effect:
if (chatChanged || bucketGrew) {
  pendingScrollKeyRef.current = `${aid}::${bucketKey}`;
  pendingScrollLenRef.current = bucket.length;
}

// FlatList onContentSizeChange:
onContentSizeChange={(_w, h) => {
  if (pendingScrollKeyRef.current !== null && h > 0) {
    pendingScrollKeyRef.current = null;  // consume
    chatRef.current?.scrollToEnd({ animated: true });
    chatAtBottomRef.current = true;
    setChatAtBottom(true);
    setChatUnreadCount(0);
  }
}}
```

`onContentSizeChange` is the FlatList's report of "I've
just been re-measured with new content". It fires AFTER
the FlatList has committed its new layout — exactly when
scrollToEnd is guaranteed to find a non-zero target. No
more rAF/setTimeout gymnastics.

## Files touched

- `package.json` — version bump 3.11.39 → 3.11.40
- `android/app/build.gradle` — versionCode 433 → 434,
 versionName 3.11.39 → 3.11.40
- `src/screens/HomeScreen.tsx`:
  - Replaced `pendingScrollRafRef` /
 `pendingScrollTimerRef` (the v3.11.37/8/9 schedule
 handles) with `pendingScrollKeyRef` /
 `pendingScrollLenRef` (the v3.11.40 latch).
  - Projection effect: sets the latch on
 `chatChanged || bucketGrew`, no longer schedules
 rAF/setTimeout.
  - FlatList `onContentSizeChange`: consumes the
 latch, runs the scroll.

## What did NOT change

- v3.11.39's tab nav state preservation
 (`display: activeTab === X ? 'flex' : 'none'`) is
 kept intact.
- The ↓ jump-to-bottom button still uses
 animated:true (user-initiated, smoothness matters).
- Real-time chat events still do NOT auto-scroll
 (latch is only set by chat_history / agent_history
 events, not by appendAgentMessage).
- All other v3.11.33–v3.11.39 changes are kept
 intact.

## What I did NOT do (per Tobe's 17:29 follow-up)

Tobe confirmed he wants the two "perhaps" features:

- **Discord-like pagination** ("Load more" button at
 the top). Planned for v3.11.41.
- **Image gallery button** at top right. Planned for
 v3.11.42.

Both are well-scoped and clean to add on top of a
working scroll.

## Manual QA
- [ ] **Cold open.** Force-stop, reopen. Chat is at
 the bottom.
- [ ] **Hot foreground reconnect.** Background app,
 send a chat from another source, foreground app.
 Chat is at the new bottom.
- [ ] **Chat switch.** Switch companion tabs. Each
 chat opens at its bottom.
- [ ] **Tab nav preservation.** Open chat, scroll up,
 go to Settings, come back. Chat is at the same
 scroll position (preserved by v3.11.39's
 display:none refactor).
- [ ] **Multiple chat_history batches.** Cold open
 with 3+ batches arriving within 2s. ONE scroll to
 the bottom (the latch consumes the first
 onContentSizeChange, subsequent fires are no-ops).
- [ ] **In-conversation new messages.** Open chat,
 send a message, get a reply. No auto-yank. ↓ badge
 appears if scrolled up.

## Risk

Low. The new mechanism is strictly more robust than
the rAF-based one (driven off a data-state event that
always fires after the FlatList is ready, rather than
guessed timing).

The one concern: in-conversation new messages while at
the bottom don't fire a chatAtBottomRef update (the
onScroll handler doesn't fire when the FlatList
re-measures without a user scroll). This was already
the case in v3.11.33–v3.11.39 (the onContentSizeChange
handler was a no-op for at-bottom state). Not a new
regression. Tracked for a future v3.11.X+ if Tobe
notices it.

## Rollback

`git revert v3.11.40` restores v3.11.39's rAF +
setTimeout schedule. The "still started at top" bug
returns.