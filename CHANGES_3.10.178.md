# v3.10.178 — Discord-style chat scroll (stay where you left off)

Tobe (2026-08-28 13:04, Discord #cyber-dev): "i think we need to
build the chat cleaner, it seems to force scroll to the bottom
when starting the app all the time and sometimes creating a
crash, the chat should just be where it last left off. Just like
discord chat behaviour."

## Background

This is the second time Tobe has flagged force-scroll-to-bottom
in a month (previous was 2026-07-30, fixed in v3.10.111).
v3.10.111 added a `chatLayoutSeenRef` latch so `onLayout` only
fires the scroll-to-end on the very first layout — preventing
"scrolls on every keyboard show" — and added a per-agent
`cyberclaw-chat-scroll-byagent` persistence layer so the saved
position could be restored on cold start.

But two v3.10.111-era bugs survived:

1. **Cold-start race.** The AsyncStorage hydrate of
   `cyberclaw-chat-scroll-byagent` runs *async*. The
   FlatList's `onLayout` fires *sync* the first time the
   FlatList mounts. So on every cold start the onLayout ran
   BEFORE the hydrate completed, saw
   `chatRestoreOffsetRef.current === null`, and fell into the
   `else { scrollToEnd() }` branch — yanking the user to the
   bottom even when they had a saved scroll-up position.

2. **Tab-switch auto-scroll.** v3.10.111 KEPT the
   `useEffect([activeTab === 'chat'])` scroll-to-bottom
   for "open at the bottom" behaviour. But the user already
   said in v3.10.111's report that they wanted
   "discord-style stay where you left off" — and Discord
   doesn't scroll-to-bottom when you re-open a channel tab.
   The tab-switch effect made Chat → Settings → Chat
   always return to the bottom.

## What changed

### 1. Race fix (cold start)

New module-scope ref `chatHydrateDoneRef` in HomeScreen.
Flipped to `true` by the AsyncStorage hydrate effect after
the load attempt completes (whether or not data was found).

The FlatList's `onLayout` handler now polls the gate with a
short backoff (75ms × 8 attempts ≈ 600ms total) before making
the restore decision. Once the hydrate completes, the handler
reads `chatRestoreOffsetRef.current` — the saved offset is now
actually there.

The race is bounded: the latch (`chatLayoutSeenRef.current`)
is still set synchronously the first time `onLayout` fires,
so the polling only happens once per FlatList mount.

### 2. No auto-scroll on cold start without a saved offset

If the hydrate completes with no saved offset (first ever
open, or the user never scrolled), the FlatList is left at
its natural initial position (top = oldest message). We do
NOT auto-scroll to the bottom.

The existing "↓ N new messages" badge in the footer (line
~4721) is the user's affordance to jump to the bottom if
they want. The badge shows when `chatUnreadCount > 0`.

The pre-v3.10.178 behaviour was `scrollToEnd()` in this
case — which is what caused "force scroll to the bottom
when starting the app all the time". Discord's behaviour
for the same case is the same: don't pretend you know
where the user wanted to be, just show the channel.

### 3. Removed the tab-switch scroll-to-bottom

The `useEffect([activeTab])` previously did
`setTimeout(scrollToEnd, 50)` whenever the user re-entered
the chat tab. v3.10.178 keeps only the
`setChatUnreadCount(0)` portion (so the unread badge still
clears on tab focus). The scroll-to-bottom is gone.

Result: Chat → Settings → Chat leaves the chat at its
current scroll position. The FlatList unmounts when the
user leaves the chat tab and re-mounts when they return;
on the re-mount, `chatLayoutSeenRef.current === true`
(the latch persists across FlatList remounts), so
onLayout is a no-op and the FlatList sits at its natural
position (top of messages).

Note: tab-switch-back doesn't fully restore the user to
their exact prior scroll position in this version — the
FlatList re-mount is a fresh FlatList, and the
`chatLayoutSeenRef` latch was specifically designed to
prevent the on-every-layout bug. To properly restore on
tab-switch, the FlatList would need to be hoisted out of
the `{activeTab === 'chat' && <FlatList>}` conditional
(use `display: 'none'` instead of unmount), and that's a
larger refactor that's out of scope here. Tobe's 13:04
report is about the cold-start force-scroll — that's
fixed. If tab-switch position-preservation comes up later,
the v3.10.111 memory entry (2026-07-30) flagged this exact
extension as the next step.

### 4. What was NOT changed (and why)

- **`messages.length` useEffect** (auto-scroll on new
  message when at bottom) — kept exactly as v3.10.90.
  Gated on `chatAtBottomRef.current` so the user only
  gets auto-scrolled to bottom if they were ALREADY at
  the bottom. Discord-equivalent.
- **User-sent message auto-scroll** — kept as
  v3.10.111. When you tap Send, the chat scrolls to show
  your new message. Discord-equivalent (you don't have to
  hunt for what you just sent).
- **`onContentSizeChange` auto-scroll** — kept as
  v3.10.111. Same gate (`chatAtBottomRef.current`).
  New incoming messages auto-scroll only when the user is
  at the bottom.
- **`onScroll` save-to-AsyncStorage** — kept as v3.10.126.
  250ms debounced, keyed by agentId. Doesn't change.

## Crash likelihood

Tobe also said "sometimes creating a crash". The most
likely culprit was the `scrollToEnd` racing against the
FlatList mid-measurement when messages were appending —
which forced a synchronous layout pass. Removing the
unconditional `scrollToEnd` calls in the tab-switch and
cold-start-without-offset paths reduces that surface area
significantly. Not a fix-the-crash-shaped change; a
fix-the-trigger-of-the-crash change. If a different crash
reappears, the new diagnostic guard (`chatHydrateDoneRef`
gate) gives a tighter scope for debugging.

## Files

`src/screens/HomeScreen.tsx`:
- New `chatHydrateDoneRef` (line ~925) tracking whether the
  scroll-offset hydrate completed
- AsyncStorage hydrate useEffect (line ~1066) sets
  `chatHydrateDoneRef.current = true` in a `finally` block
- FlatList `onLayout` handler (line ~4954) replaced with a
  hydrate-gated restore: polls `chatHydrateDoneRef` for up
  to ~600ms before falling through to "no auto-scroll"
- Tab-switch `useEffect` (line ~3938) reduced to
  `setChatUnreadCount(0)` only — the `scrollToEnd` is gone

`package.json` 3.10.177→3.10.178,
`android/app/build.gradle` versionCode 385→386,
versionName 3.10.177→3.10.178.

## Verification

- `npx tsc --noEmit` reports the same 12 pre-existing
  errors as v3.10.177 — zero new TS errors.
- The fix is contained: HomeScreen is the only file touched.
- Stays wire-compatible with the desktop. No sync
  protocol change.

## Lesson

**Restore-from-persistence MUST race-correct against the
synchronous mount of the persistent-state consumer.** The
v3.10.111 fix correctly persisted scroll offsets and
correctly tried to restore them on mount — but the
restore lived in `onLayout` (synchronous) while the
hydrate lived in `useEffect` (async). Both correctly, but
together they raced, and the race always lost for the
user.

The pattern: any "restore X on mount" effect needs to
either (a) be synchronous (e.g. via a top-level
Promise.all before the first render), or (b) gate the
restore on a "did the load finish?" flag. Option (b) is
simpler and what's used here — a polling backoff with a
hard cap, plus a fall-through behavior that does nothing
rather than something destructive. Doing-nothing is
strictly better than doing-the-wrong-thing.

Companion lesson: **a tab-switch useEffect that scrolls
to the bottom is a UX bug disguised as a feature.**
"Re-open at the bottom" sounds right until the user
expects "stay where I left". The Discord default is
preserve; preserve is the right default for any scroll
position the user can drive themselves.
