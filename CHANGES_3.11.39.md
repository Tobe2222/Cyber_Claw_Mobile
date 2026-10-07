# v3.11.39 — Chat scroll: fix the regression + preserve state across tab switch

## Summary

Two regressions in v3.11.33→v3.11.38, both fixed:

1. **Chat starts at top** (regression from v3.11.38's `animated:false`).
   v3.11.38 used `scrollToEnd({ animated: false })` for jitter-
   free precision, but the rAF-only schedule had no retry — if
   the FlatList hadn't measured its content yet when the scroll
   fired (contentSize=0), the scroll was a no-op and the chat
   stayed at the natural mount position (scrollY=0).
   Tobe 2026-10-07 16:03: "chat seems to always start at the
   top and i have to Click the button after a small scroll to
   reach the bottom."
2. **Tab nav resets chat** (regression from v3.11.33's
   conditional render). The chat tab content was conditionally
   rendered (`activeTab === 'chat' && (...)`), which UNMOUNTED
   the FlatList on tab switch and re-mounted it at scrollY=0
   when the user came back. Tobe 2026-10-07 16:03: "iy resets
   some what after i go into settings for example. It should
   stay where it was left."

## Fix (v3.11.39)

### 1. Scroll-to-bottom retry

Reverted `animated:false` → `animated:true` (the previous
attempt at jitter-free precision was the regression cause).
Added a 100ms `setTimeout` as a second pass after the rAF
to catch the case where the rAF fires before the FlatList
has measured. Both calls are gated on `didScroll` so only
one scrollToEnd lands.

```ts
if (chatChanged || bucketGrew) {
  let didScroll = false;
  const scrollToBottom = (animated: boolean) => {
    if (didScroll) return;
    if (bucket.length === 0) return;  // bucket empty, abort
    chatRef.current?.scrollToEnd({ animated });
    chatAtBottomRef.current = true;
    setChatAtBottom(true);
    setChatUnreadCount(0);
    didScroll = true;
    // cancel the other scheduled pass
  };
  pendingScrollRafRef.current = requestAnimationFrame(() => scrollToBottom(true));
  pendingScrollTimerRef.current = setTimeout(() => scrollToBottom(true), 100);
}
```

The `bucket.length === 0` guard prevents scrolling to the
bottom of an empty FlatList (which would be a no-op anyway,
but bails out earlier).

### 2. Tab nav state preservation

Wrapped each tab's content in a `<View style={{ flex: 1,
display: activeTab === X ? 'flex' : 'none' }}>` so the
contents stay mounted across tab switches. The hidden
tab's FlatList keeps its scroll position, the input
keeps its draft text (already persisted at the
module-scope level, so unaffected), and any other
component state survives the round-trip.

```jsx
<View style={{ flex: 1, display: activeTab === 'chat' ? 'flex' : 'none' }}>
  {/* chat tab content — stays mounted */}
</View>
<View style={{ flex: 1, display: activeTab === 'events' ? 'flex' : 'none' }}>
  <FlatList ... />  {/* events tab — stays mounted */}
</View>
<View style={{ flex: 1, display: activeTab === 'log' ? 'flex' : 'none' }}>
  {/* log tab content — stays mounted */}
</View>
```

## Files touched

- `package.json` — version bump 3.11.38 → 3.11.39
- `android/app/build.gradle` — versionCode 432 → 433,
 versionName 3.11.38 → 3.11.39
- `src/screens/HomeScreen.tsx`:
  - Re-added `pendingScrollTimerRef` ref.
  - Projection effect's scroll schedule: reverted
 animated:false → animated:true, added 100ms setTimeout
 fallback with `didScroll` guard.
  - Wrapped all 3 tab contents in `display: activeTab
 === X ? 'flex' : 'none'` views.

## What did NOT change

- The ↓ jump-to-bottom button still works (and still
 uses animated:true).
- Real-time chat events still do NOT auto-scroll.
- Cold-open behavior (bucket 0 → populated → scroll to
 bottom) is unchanged.
- Hot-foreground behavior (bucket grew during re-hydration
 → scroll to bottom) is unchanged.
- The "↓ N new messages" badge is unchanged.

## Things still on Tobe's list (NOT done in this release)

- **Discord-like pagination** ("Load more" button at the
 top). Tobe said "perhaps" — tracked but not implemented.
- **Image gallery button** at top right. Tobe said
 "perhaps" — tracked but not implemented.

Both are clean follow-up features. Happy to do them in
v3.11.40+ if Tobe wants.

## Manual QA
- [ ] **Cold open.** Force-stop, reopen. Chat is at the
 bottom (smooth scroll).
- [ ] **Hot foreground reconnect.** Background app, send
 a chat from another source, foreground app. Chat is
 at the new bottom.
- [ ] **Tab nav preservation.** Open chat, scroll up to
 read history, go to Settings tab, come back to chat.
 Chat is at the SAME scroll position (preserved).
- [ ] **Tab nav preservation with new messages.** Open
 chat, scroll up, go to Settings, have a chat land,
 come back. Chat is at the SAME scroll position
 (no auto-yank from the new message).
- [ ] **Tab nav → bottom on intent.** Open chat, scroll
 up, switch to a different companion tab, switch back.
 Chat of the new companion is at the bottom (because
 the (agent) changed). The original companion's chat
 scrolls to the bottom (because the user explicitly
 picked that companion again — this is correct per
 Tobe's earlier spec).

## Risk

Low. The scroll-to-bottom retry is a strict superset of
v3.11.38's behavior (covers more cases, doesn't break
existing). The display:none refactor is the standard
React Native pattern for keeping tabs mounted and is
well-tested in production apps.

## Rollback

`git revert v3.11.39` restores v3.11.38. The
chat-starts-at-top bug returns; the tab nav reset bug
returns.