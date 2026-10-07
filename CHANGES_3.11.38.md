# v3.11.38 — Chat scroll: stop the "jumps up a bit" on hot-foreground reconnect

## Summary

v3.11.37 fixed the "berzerk" symptom (multiple animated
scrolls on cold open) but introduced a new symptom on hot
foreground reconnect: the chat would settle "above the new
bottom" by N bubble-heights. Tobe 2026-10-07 14:04:
"opened it non fresh again and this time it does not want
to stay at the bottom, it just jumps up a bit."

## Root cause

v3.11.37's latch fired scrollToEnd on:
- (a) bucket key changed (chat switch), OR
- (b) bucket went from 0 to non-empty (cold open).

On hot foreground reconnect (app process alive, just
backgrounded → foregrounded):
- Local cache still has the chat messages from before.
- WS reconnects → desktop replays `agents_list` →
 mobile fires `requestAgentHistory` for each agent →
 desktop sends `agent_history` responses → mobile
 appends to the bucket map → `setAnchorHydrateTick++`
 → projection effect re-runs.
- The bucket grew (say, 5 → 8 messages) because the user
 was away and new messages accumulated.
- v3.11.37's `messagesArrived` check was `lastLen === 0`
 → false (lastLen was 5, not 0). No scroll scheduled.
- FlatList renders 8 messages. The user's scrollY is
 preserved from before the re-hydration (let's say it
 was at the bottom of the previous 5-message content).
 Now contentSize grew by 3 messages. The user's
 scrollY is still 5-message-end worth of pixels.
 Visually: the chat appears to "jump up" by 3 bubble-
 heights. ↓ button appears (chatAtBottomRef flips to
 false).

The v3.11.37 `animated:true` smooth-scroll would have helped
if the timing was perfect, but the animation's target
becomes invalid mid-flight when contentSize grows during
the animation, contributing to the wrong-target settle.

## Fix (v3.11.38)

Two changes in the projection effect's scroll latch:

1. **New condition: `bucketGrew` (was `messagesArrived`).**
 Fires whenever the new bucket is larger than the last
 one we saw. anchorHydrateTick is only bumped by
 `chat_history` / `agent_history` handlers (NOT by
 realtime `appendAgentMessage` calls), so this trigger
 fires ONLY on desktop re-hydration — never during
 normal conversation. Real-time chat (the "new
 messages stay at OLD bottom" requirement) is
 unaffected.

2. **`animated:false` instead of `animated:true`.** The
 scroll now lands in one frame, no in-flight drift.
 Tradeoff: loses the smooth-scroll aesthetic in
 favour of jitter-free precision on re-hydration. (The
 ↓ button still uses animated:true because that one is
 a user-initiated action where smoothness is
 desirable.)

## Files touched

- `package.json` — version bump 3.11.37 → 3.11.38
- `android/app/build.gradle` — versionCode 431 → 432,
 versionName 3.11.37 → 3.11.38
- `src/screens/HomeScreen.tsx` — projection effect's
 scroll latch: `messagesArrived` → `bucketGrew`,
 `animated:true` → `animated:false`.

## What did NOT change

- Cold-open behavior (bucket 0 → populated → scroll)
 is unchanged.
- The "" button on the chat tab remains animated:true.
- Realtime chat events still do NOT auto-scroll.
- The "↓ N new messages" badge still works as the
 affordance for "you're scrolled up and there's new
 content below the fold."

## Manual QA
- [ ] **Hot foreground reconnect.** Open app, scroll up
 to read history, send app to recents, return to app.
 Chat is at the bottom.
- [ ] **Cold open.** Force-stop, reopen. Chat is at the
 bottom.
- [ ] **Hot open with new messages.** Send app to
 recents, have someone send a chat from another source,
 return to app. Chat is at the new bottom (showing the
 new messages).
- [ ] **In-conversation new messages.** Open app, send a
 message, get a reply, scroll up to read history. The
 new message does NOT yank you to the bottom; ↓ badge
 appears.
- [ ] **Tap ↓ button.** Smooth animation to the bottom
 (this still uses animated:true for user-initiated
  scrolls).

## Rollback

`git revert v3.11.38` restores the v3.11.37 latch (chatChanged
OR messagesFromEmpty) and the animated:true scroll. The
hot-reconnect "jumps up a bit" symptom returns
immediately on foreground.