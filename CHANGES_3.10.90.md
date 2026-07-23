# v3.10.90 — always-visible "↓ N new messages" badge (jump-to-bottom affordance)

Tobe reported on v3.10.89 (2026-07-23 23:26):

> "@Clawsuu do we have a update function when scrolling
> to the bottom? A refresh for new messages like
> function? Lets add that if we dont"

Tobe wanted an explicit affordance to discover and jump
to new messages — not just auto-scroll. The "↓ N new
messages" badge that already existed (v3.8.6+) only
showed when the user was scrolled up. When at bottom,
the auto-scroll hid the badge entirely.

## Root cause

The `chatScrollToBottomBtn` render guard was:

```jsx
{chatUnreadCount > 0 && !chatAtBottom && (
  <TouchableOpacity style={styles.chatScrollToBottomBtn} ...>
```

Two conditions had to be true: unread messages AND user
not at bottom. So when the user was at bottom (which
is the default), the badge never appeared, even when
new content arrived.

Combined with the unread-count logic:

```js
if (chatAtBottomRef.current) {
  setTimeout(() => chatRef.current?.scrollToEnd(...), 50);
} else {
  setChatUnreadCount(c => c + 1);
}
```

The unread count was only incremented when scrolled up.
At bottom, the count stayed at 0. So the badge never
showed when at bottom.

This was actually correct for the original use case
("at bottom = you see new content automatically") but
became a bug after v3.2.23 (missed-broadcast replay).
The replay added content while the user was at the
bottom — auto-scrolled to show it, but the user might
not notice a brief scroll when they were looking at
something else. There was no visual cue that new
content had arrived.

## Fix

Two changes in `HomeScreen.tsx`:

### 1. Always increment the unread badge

When a new agent message arrives, increment the unread
count regardless of whether the user is at the bottom
or scrolled up. At bottom, the auto-scroll still fires
(both happen). Scrolled up, stay put + show badge.

```js
if (chatAtBottomRef.current) {
  setTimeout(() => chatRef.current?.scrollToEnd(...), 50);
}
setChatUnreadCount(c => c + 1);
```

### 2. Always show the badge when unread > 0

Remove the `!chatAtBottom` requirement from the badge
display:

```jsx
{chatUnreadCount > 0 && (
  <TouchableOpacity style={styles.chatScrollToBottomBtn}
    onPress={() => {
      chatRef.current?.scrollToEnd({ animated: true });
      setChatUnreadCount(0);
    }}>
    <Text>↓ {chatUnreadCount} new message...</Text>
  </TouchableOpacity>
)}
```

User taps the badge → scrolls to bottom + clears unread.
This works in both cases:
- **At bottom:** chat is already there; tap dismisses
  the badge. Visual feedback that the user noticed the
  new content.
- **Scrolled up:** tap jumps to the new content. Same
  as the v3.8.6 behaviour.

## Side effects

- **Badge always shows briefly when at bottom.** If
  user is at bottom and a new message arrives, badge
  appears. Auto-scroll happens at the same time. User
  sees both. To dismiss, tap the badge (or scroll
  manually, or switch tabs and back — both clear the
  unread count via the existing `useEffect([activeTab])`
  hook at line 2976).
- **No more "silent" arrival.** Tobe's v3.2.23 scenario
  (broadcast missed during WS disconnect, replayed
  after reconnect) used to be invisible. Now the badge
  appears after the replay lands, giving a clear
  visual cue that new content exists.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Removed `!chatAtBottom` from `chatScrollToBottomBtn`
    render guard (the badge now shows whenever unread > 0)
  - `chatUnreadCount` now increments on every agent
    message, regardless of `chatAtBottomRef.current`
- `package.json` — version 3.10.89 → 3.10.90
- `android/app/build.gradle` — versionCode 313→314

## Lessons

**"At bottom = you see new content" is a UX assumption
that breaks when content can arrive in batch.** Auto-scroll
works fine for one-at-a-time arrivals (typical chat).
But when 1+ messages can arrive together (idle check-ins,
replay-on-reconnect, broadcast bursts), the user might
not notice a brief auto-scroll. A persistent indicator
that "X new since you last looked" is more reliable.

**Affordances should be available, not just helpful.**
The "↓ N new messages" badge already existed — but only
in one specific state (scrolled up + unread). Users
who were at bottom had no way to discover the feature.
Making it always-available (when unread > 0) gives it
more utility without removing the existing use case.

**Don't auto-clear things the user might want to know
about.** The original code auto-cleared unread at
"at bottom = true". That's the right call for normal
chat but wrong for batch arrivals. The fix separates
"auto-scroll" from "clear unread": always scroll if at
bottom (preserves the original behaviour) AND always
show the badge until the user explicitly dismisses
(via tap or tab switch).