# v3.10.179 — Force-scroll to the most recent failed task card

Tobe (2026-08-30 11:56, Discord #cyber-dev, screenshot): "This
appeared after I asked how it had gone. That little bug report
should be visible before I send something again."

## Background

v3.10.177 added the `taskSummary` footer to error bubbles — a
structured card showing the error category (timeout / crash /
network / generic), the duration, the captured steps that ran
before the failure, and Retry / Copy buttons.

But the auto-scroll behaviour in `messages.length` useEffect
(HomeScreen.tsx ~line 3897) only scrolls to the **bottom** of
the FlatList, gated on `chatAtBottomRef.current`. If the user
was scrolled up reading history when the error bubble landed,
the error would arrive at the bottom of the chat, the auto-scroll
would NOT fire (because `chatAtBottom === false`), and the user
would stay where they were — invisible to the new card.

Tobe's screenshot shows the card after they had already typed
"How did it go?" — the typing bubble is at the bottom of the
visible area, and the error card is in the upper portion of the
visible chat. The user is right: the typing bubble should not be
able to push a failure card out of view.

## What changed

### 1. Force-scroll on failure (HomeScreen `messages.length` effect)

When a new agent bubble arrives carrying
`taskSummary.status === 'failed'`, force-scroll to it
immediately. The gate (`chatAtBottomRef.current`) is bypassed
because the user *needs* to see what went wrong. `scrollToIndex`
is used with `viewPosition: 0.2` (a bit below the top of the
viewport) so the diagnostic card is fully in view, not just
peeking.

`scrollToIndex` throws if the item hasn't been measured yet
(FlatList measures lazily). Wrapped in a try/catch with a
120ms-retry-then-scrollToEnd fallback so the first attempt —
which fires before the FlatList has measured the freshly-
appended bubble — gets a second chance.

The unread badge is cleared (`setChatUnreadCount(0)`) for
failure bubbles because the user is going to see them
immediately — no need for the "↓ N new messages" cue.

### 2. Pre-send snap (HomeScreen `sendMessage` useCallback)

When the user presses Send, walk backwards through the active
agent's message list. If the bubble directly before the new
user bubble is an agent bubble with a failed `taskSummary`,
fire a `scrollToIndex` to it in parallel with the send. The
send is not blocked — the queueing and the scroll run
independently. The scroll uses `animated: true` so the user
sees the chat "remember" the failure before they finish typing
the follow-up.

We don't scan beyond the first user message going backwards.
The user has already seen/acknowledged anything from an earlier
turn; the only failure we snap to is the one from the current
turn (the bubble they're following up on).

### 3. What was NOT changed

- **Successful reply auto-scroll** — kept as v3.10.90 / 178.
  The "at bottom = auto-scroll" gate still applies for
  non-failure bubbles. Discord-equivalent.
- **Tab-switch scroll position** — kept as v3.10.178. The
  Chat → Settings → Chat round-trip still preserves scroll
  position.
- **Error card itself** — kept as v3.10.177 / 177.1. The card
  structure (category icon + duration + step list + Retry /
  Copy buttons) didn't change; only the scroll-to-it
  behaviour did.

## Files

`src/screens/HomeScreen.tsx`:
- `messages.length` useEffect (line ~3925): added
  `taskSummary.status === 'failed'` branch that calls
  `scrollToIndex` with retry + `setChatUnreadCount(0)`
- `sendMessage` useCallback (line ~3649): added a pre-send
  walk-back over the active agent's message list to find the
  most recent failure and `scrollToIndex` to it

`package.json` 3.10.178→3.10.179,
`android/app/build.gradle` versionCode 386→387,
versionName 3.10.178→3.10.179.

## Verification

- `npx tsc --noEmit` reports the same 12 pre-existing errors as
  v3.10.178 — zero new TS errors.
- Behaviour to test on the phone:
  1. Send a long-running task that you know will time out
     (e.g. ask me to do something across many files).
  2. While waiting, scroll up in the chat to read history.
  3. When the 15-min cap (now bumped from 10 min — see the
     matching desktop change in this release) fires, the
     chat should snap down to the failure card.
  4. Type a follow-up — the chat should snap to the card
     before the typing bubble appears.
- Wire-compatible with desktop and gateway. No sync protocol
  change.

## Lesson

**"Auto-scroll to bottom" is not the same as "auto-scroll to
the new thing the user needs to see."** For success bubbles,
they're the same thing. For failure bubbles, the user needs to
see the diagnostic card, not the bottom of the chat — and the
typing bubble that immediately follows their next message can
hide the card if the auto-scroll doesn't run at exactly the
right moment.

The fix is "scroll to the most recent thing the user needs to
see, not the most recent thing in the list." That requires
distinguishing failure bubbles from success bubbles in the
scroll handler — which is what `taskSummary.status === 'failed'`
gives us.

Companion lesson: **auto-scroll effects should re-evaluate on
"should the user see this right now?" not just on "did
something change?"** The `messages.length` dep is the trigger;
the `taskSummary` content is the decision.

## Related desktop change (separate repo)

`projects/cyberclaw/src/js/app.js`:
- `AGENT_TIMEOUT_MS`: 600000 (10 min) → 900000 (15 min) at
  both call sites (main `sendChatMessage` line 3144 and image-
  path `sendChatImage` line 6850). Tobe 2026-08-30 11:48.
- `typingFailsafe`: 300000 (5 min) → 600000 (10 min) to match
  the new timeout ceiling. The failsafe clears the typing
  bubble if the LLM is still thinking past that point, so it
  must stay below the timeout.
- Same release version (3.10.179) for mobile + desktop.
