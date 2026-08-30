# v3.10.180 — Auto-collapse stale error cards + remove broken pre-send snap

Tobe (2026-08-30 19:17, Discord #cyber-dev, screenshot): "That
error message still appears after I sent a new message. Im at
v179."

## Background

v3.10.179 added two scroll-to-failed-card changes:

1. Force-scroll to the most recent failed taskSummary bubble
   when it lands in `messages.length` useEffect. (Works as
   intended — confirmed by screenshot 1 at 19:17:11.)
2. Pre-send snap in `sendMessage` useCallback that walks
   backwards through the message list and tries to scroll to
   the failure card before clearing the input. (Had a timing
   bug — see "What changed" #2 below.)

After v3.10.179, Tobe sent "Continue" at 7:17 PM. Screenshot 2
shows the chat at 19:17:19 with the failure card visible (it
was scrolled to on arrival), the "Continue" user bubble below
it, and a "Clawsuu is thinking..." typing bubble at the bottom.
The failure card was still rendering as the FULL diagnostic
panel with Retry / Copy buttons even though Tobe had moved on
to a new turn — that's noise.

Two distinct issues to fix:

1. **Stale card persists after the user moves on.** The Retry /
   Copy buttons apply to a task the user has already abandoned;
   they should collapse to a one-line indicator once the user
   sends a new message.
2. **The pre-send snap in `sendMessage` was buggy.** It
   assumed the user bubble was already in `messagesByAgentRef`
   and used `list.length - 2` as the walk-back start. But
   `appendAgentMessage(userMsg, ...)` runs LOWER in the same
   `sendMessage` function — the user bubble isn't there yet at
   the time the snap fires. The walk-back landed on the
   previous user bubble from the older turn and broke out
   immediately without ever inspecting the failure. The snap
   never actually fired. Tobe hit this at 19:17 — the card
   was visible because of the messages.length scroll on
   arrival, not because of the pre-send snap.

## What changed

### 1. Auto-collapse on next user message

New `collapsedTaskCards: Set<string>` state in HomeScreen
(line ~835). When `messages.length` useEffect fires AND the
new last bubble is a user message, walk back through the
message list and add every failed taskSummary bubble id to
the set (line ~3952).

The renderer checks `collapsedTaskCards.has(item.id)` before
deciding which view to render:

- **Collapsed** (id is in the set): a single-line
  `TouchableOpacity` styled as a muted pill —
  `taskErrorCardCollapsed` (light red background, thin border)
  with text "ⓘ Failed attempt · {duration} ago · tap to
  expand". Tapping removes the id from the set, re-expanding
  the card with full Retry / Copy actions.
- **Expanded** (default): the existing v3.10.177 card with
  category icon, duration, step list, Retry and Copy buttons.

The Set is useState, not persisted to AsyncStorage. On app
restart, the Set resets and the user sees the cards expanded
again — correct behaviour, since "the failure just happened"
from their perspective.

### 2. Removed the pre-send snap

Removed the entire `try { ... scrollToIndex ... } catch` block
from `sendMessage` (formerly lines ~3655-3719). The pre-send
snap was redundant with the scroll-to-failed that already
fired when the error bubble arrived in the messages.length
effect — Tobe was already at the card when the new turn
started. The snap didn't add anything and was buggy.

### 3. What was NOT changed

- **scroll-to-failed on arrival** (v3.10.179, messages.length
  effect): kept. Tobe's 11:56 ask stands.
- **Successful reply auto-scroll**: kept as v3.10.90 / 178.
- **Tab-switch scroll position**: kept as v3.10.178.
- **Error card structure (expanded view)**: kept exactly as
  v3.10.177 / 177.1. Only the auto-collapse behaviour is new.

## Files

`src/screens/HomeScreen.tsx`:
- New state `collapsedTaskCards` (line ~835)
- `messages.length` useEffect (line ~3945): user-branch now
  walks back and adds failed taskSummary ids to the set
- `sendMessage` useCallback (line ~3664): removed the entire
  v3.10.179 pre-send snap block
- Renderer (line ~4318): the `{condition && (<ternary>)}`
  picks between `<TouchableOpacity>` (collapsed) and
  `<View>` (expanded) based on `collapsedTaskCards.has(item.id)`
- Styles (line ~6056): new `taskErrorCardCollapsed` and
  `taskErrorCollapsedText`

`package.json` 3.10.179 → 3.10.180,
`android/app/build.gradle` versionCode 387 → 388,
versionName 3.10.179 → 3.10.180.

## Verification

- `npx tsc --noEmit` reports the same 12 pre-existing errors as
  v3.10.179 — zero new TS errors.
- Behaviour to test on the phone:
  1. Send a long-running task that you know will time out.
  2. Wait for the error card to land. The chat should auto-
     scroll to show it (v3.10.179 behaviour — kept).
  3. Send a follow-up message ("Continue" or anything).
     The card should immediately collapse to a one-line
     pill. The typing bubble should appear at the bottom of
     the chat. The chat should NOT snap-scroll to the card
     on send (the snap is gone).
  4. Tap the collapsed pill — it should re-expand to the
     full Retry / Copy panel.
- Wire-compatible with desktop and gateway. No sync protocol
  change.

## Lesson

**A "scroll to X" behaviour needs to actually be on the path
that creates X.** The v3.10.179 pre-send snap was in
`sendMessage` but the failure bubble was already in the
message list — the snap had nothing to "create" by the time
it ran. The visible scroll-to-failed behaviour was coming
from the messages.length effect on arrival (which IS on the
path that creates the bubble), not from the pre-send snap.

The pattern: when a behaviour "isn't working" in production,
trace which effect/handler actually fires the side effect
that produces the visible result. The two scroll patches
were both labelled "v3.10.179 scroll-to-failed" but only one
of them was actually causing the scroll.

Companion lesson: **state that affects presentational collapse
should be in useState (not a persisted field on the data
object)** when the collapse is a UI choice, not part of the
data the user would expect to see on restart. The Set lives in
component state and resets on remount — that's the right
scope.
