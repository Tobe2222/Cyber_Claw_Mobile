# v3.8.7 — Chat: open-at-bottom lands reliably, even on first paint

Tobe: "Okey cool it built now. But i noticed when i
opened it now that clawsuu had a new message but when
i scrolled down it was not visible. I then clicked the
red notification on the clawsuu tab and then it popped
up at the bottom of the text channel. That Click should
not be needed, it should appear in the text channel
without having to Click the red notification."

## What was happening

When Tobe opened the app on Clawsuu's chat:
1. Clawsuu had a new message ("Late hour, but I'm wide
   awake…") below a long history of older messages
2. The chat history hydrated from AsyncStorage with all
   messages including the new one
3. The FlatList rendered — but **landed at the top of
   the scrollable area**, showing old messages
4. The new message was below the visible area
5. **No "↓ N new messages" badge appeared** — because
   the badge only fires when a new message arrives while
   `chatAtBottom === false`, not when an existing
   (already-hydrated) message is at the bottom of a
   freshly-rendered list
6. Tobe clicked the red dot on the Clawsuu tab to find
   the message — that re-rendered the chat (or scrolled
   it) and the message appeared

## Root cause

Two related races between `onScroll`, `onLayout`,
`onContentSizeChange`, and the `messages.length` effect:

### Race 1: onLayout vs onScroll

The previous `onLayout` handler did a single
`setTimeout(150)` calling `scrollToEnd`. Meanwhile,
`onScroll` was firing concurrently with
`distanceFromEnd = huge` (because the FlatList starts
at the top), which set `chatAtBottom = false`.

If `onScroll` won (set `chatAtBottom` to false BEFORE
the 150ms timer ran), the subsequent `onContentSizeChange`
saw `chatAtBottom = false` and refused to scroll on the
new content. The chat stayed at the top.

### Race 2: closure vs ref in the messages.length effect

The `useEffect([messages.length])` that decides whether
to auto-scroll or bump the unread badge read
`chatAtBottom` from its closure. The closure captures
the value at effect-run time. If `chatAtBottom` was
updated by `onScroll` between when the closure was
captured and when the effect body ran, the effect saw
a stale value.

## Fix

### 1. Two-attempt scroll in onLayout

```js
onLayout={() => {
  if (messages.length > 0) {
    chatRef.current?.scrollToEnd({ animated: false });
    setTimeout(() => {
      chatRef.current?.scrollToEnd({ animated: false });
      setChatAtBottom(true);
    }, 250);
  }
}}
```

Immediate attempt + 250ms followup. The followup runs
after the FlatList has measured its full content, and
`setChatAtBottom(true)` ensures the next
`onContentSizeChange` doesn't reset us.

### 2. New explicit first-paint scroll effect

```js
useEffect(() => {
  if (messages.length === 0) return;
  const timer = setTimeout(() => {
    chatRef.current?.scrollToEnd({ animated: false });
    setChatAtBottom(true);
  }, 200);
  return () => clearTimeout(timer);
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [messages.length > 0]);
```

Belt-and-suspenders to `onLayout`. Fires once when the
messages list first populates (e.g. on AsyncStorage
hydration) and stays quiet on subsequent messages (the
`messages.length` useEffect handles those).

The dep is `[messages.length > 0]` — a boolean. The
effect fires when the boolean flips `false → true`,
and doesn't re-fire when it stays `true` (i.e. on each
new incoming message).

### 3. chatAtBottomRef for the FlatList handlers

```js
const chatAtBottomRef = useRef(true);
useEffect(() => { chatAtBottomRef.current = chatAtBottom; }, [chatAtBottom]);
```

Now `onContentSizeChange` and the messages.length effect
read the latest value via the ref instead of through
the closure. The state version (`chatAtBottom`) drives
the badge render; the ref drives the imperative
scroll/bump logic. They stay in sync via the mirror
effect.

## Files touched

- `src/screens/HomeScreen.tsx`
  - new `chatAtBottomRef` ref + mirror effect
  - `onContentSizeChange` reads `chatAtBottomRef.current`
  - `onLayout` does two-attempt scroll + sets
    `chatAtBottom(true)` after
  - new `[messages.length > 0]` first-paint scroll effect
  - `messages.length` effect reads `chatAtBottomRef.current`
- `package.json` (3.8.6 → 3.8.7)
- `android/app/build.gradle` (versionCode 221 → 222,
  versionName 3.8.6 → 3.8.7)

## Not touched

- Other screens (WakeMode, Settings, Quests) — only the
  HomeScreen chat FlatList is affected.
- SyncClient, VoiceSettings, trainer components.
- Desktop.
- The "↓ N new messages" badge itself — works as
  designed for *new* incoming messages while the user
  is scrolled up; this release just ensures it isn't
  needed on first paint.

## Note

Pre-existing TypeScript error in HomeScreen.tsx around
line 2666 (an orphan JSX self-close from a v3.1.37-era
deletion) is unchanged. Metro bundler ignores it; the
project builds cleanly. Not in scope for this fix.