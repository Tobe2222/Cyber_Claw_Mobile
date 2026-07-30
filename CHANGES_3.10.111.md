# v3.10.111 — Discord-style chat scroll (stay where you left it)

## The complaint

Tobe (2026-07-30 ~08:00 GMT+2):

> "I can see it almost forcefully scrolling down to the bottom of the
> chat channel. Could me make its behaviour more normal? Like discord
> is? Just stay where it was last left. Perhaps start at bottom on
> startups?"

The chat FlatList was yanking the user back to the bottom mid-read
whenever the layout reflowed — keyboard open, font scale change,
companion tab re-render, anything. Even though the
`chatAtBottomRef`-based guard was already correct for new incoming
messages, the **`onLayout` handler forced a scroll-to-bottom on
EVERY layout event**, not just the first.

## The fix (one setting toggle, three small changes)

### 1. `onLayout` — only force scroll on the FIRST layout (was: every layout)

Added a `chatLayoutSeenRef` that latches to `true` after the first
onLayout fires. Subsequent layouts (keyboard, font, rotation, reflow)
don't fight the user's scroll position.

```js
const chatLayoutSeenRef = useRef(false);
// ...
onLayout={() => {
  if (messages.length > 0 && !chatLayoutSeenRef.current) {
    chatLayoutSeenRef.current = true;
    chatRef.current?.scrollToEnd({ animated: false });
    setTimeout(() => {
      chatRef.current?.scrollToEnd({ animated: false });
      setChatAtBottom(true);
    }, 250);
  }
}}
```

### 2. "Near bottom" threshold — 32px → 50px

The existing onScroll handler treated any scroll within 32px of the
end as "at the bottom" and auto-snapped. Bumped to 50px to better
match Discord's "you're within a hair of the bottom" zone — small
phones have denser scroll budgets where 32px feels twitchy.

```js
const isAtBottom = distanceFromEnd < 50; // was 32
```

### 3. First-paint scroll preserved (it was already startup-only)

The `useEffect` that scrolls on `messages.length > 0` becoming true
fires once per session (the array doesn't get reset when the FlatList
unmounts on tab-switch). Left in place — this is the "start at bottom
on startups" behavior Tobe said was fine.

## What stays the same (and why)

These were already correct — I only verified, didn't touch:

- **`onContentSizeChange`** — only scrolls if `chatAtBottomRef.current`
  is true. New incoming messages don't yank scrolled-up users.
- **`messages.length` effect (incoming agent reply)** — same
  `chatAtBottomRef` guard. The unread-badge counter still increments
  per Tobe's v3.10.90 request.
- **`activeTab === 'chat'` switch effect** — still scrolls to bottom
  on tab switch. Discord also auto-scrolls when you re-open a
  channel, so this matches the "Discord-like" target.
- **Send button** — still scrolls to bottom (you just sent it).

## Files

- `src/screens/HomeScreen.tsx`:
  - New `chatLayoutSeenRef` near `chatAtBottomRef` (~line 608)
  - `onScroll` threshold 32 → 50 (~line 3774)
  - `onLayout` guarded by `chatLayoutSeenRef` (~line 3865)

## Lessons (for future-me)

- **`onLayout` fires on layout, not on mount.** Any handler that
  force-scrolls inside `onLayout` will re-fire on every reflow
  — font scale, keyboard, rotation, etc. Use a "have we laid out
  yet?" latch if you only want mount-time behavior.
- **Scroll-position preservation across conditional render is
  unsolved in HomeScreen.** When the user goes chat → events → chat,
  the FlatList unmounts and remounts at scroll position 0 (top).
  Preserving it would need a memoized FlatList (e.g. wrapped in a
  component that uses `useMemo`+`forwardRef` to keep the ref stable
  across remounts) or moving the FlatList out of the conditional.
  Out of scope for this fix — file for later if Tobe asks.
- **`Animated.ScrollView`/`FlatList` doesn't have a "did user just
  scroll?" dedupe vs "did we programmatically scroll?" distinction.**
  Both flow through the same `onScroll`. So if you want to detect
  "the user just scrolled, not a programmatic jump", you need to
  set a flag around `scrollToEnd()` calls and check it in `onScroll`.
  Did not need this for the current fix.

versionCode: 335
