# v3.11.17 — don't auto-scroll during keyboard reflow; suppress redundant quest pills

Tobe (2026-09-27 23:02, Discord #cyber-dev):

> "the chat suddenly go to no active quest chat when i
> was scrolling the active one. And when typing the
> chat seemingly random jumped up a couple of times."

Two distinct symptoms. This release addresses both.

## Symptom 1: "no active quest chat when scrolling"

Tobe saw the chat panel show messages with "— No quest"
pills even while scrolling the active quest's bucket.
The messages themselves were correct (the active
quest's bucket content), but every bubble's pill was
"— No quest" because the bubble's `activeQuestId` was
null at append time (legacy messages predating the
active quest, or messages sent before the user
activated the quest).

Per-bubble quest pills are useful when:
- The user is viewing the DEFAULT bucket (mixed
  attribution) — pills distinguish which bubbles were
  sent under which quest.
- A bubble's quest differs from the current view —
  pills flag the cross-quest content visually.

But pills are REDUNDANT and visually noisy when:
- The user is on an active quest and the bubble was
  sent under that same active quest — every pill says
  the same thing.
- The user is on an active quest and the bubble is
  legacy/null-attributed — every pill says
  "— No quest", which reads as "the chat is showing
  the wrong quest" even though the chat panel is in
  the correct bucket.

Fix: suppress the per-bubble pill when the user is
on an active quest AND the bubble matches the active
quest. Still show the pill when the bubble's quest
DIFFERS from the active view (cross-quest content).
The active-quest name is shown once in the chat
header (the pill above the input row), so the user
always knows which quest they're in.

```tsx
// Before: always show some pill.
{item.activeQuestId == null
  ? '— No quest'
  : `🎯 ${...}`}

// After: show pill only when contextually useful.
{(activeChatQuestId == null || activeChatQuestId === undefined)
  ? (item.activeQuestId == null
      ? '— No quest'
      : `🎯 ${...}`)
  : (item.activeQuestId !== activeChatQuestId
      ? (item.activeQuestId == null
          ? '— Legacy (no quest)'
          : `🎯 ${...}`)
      : null)}
```

## Symptom 2: "jumps up when typing"

When the user taps the input and the keyboard opens,
the chat panel shrinks (KeyboardAvoidingView's padding
changes). The FlatList re-lays out multiple times
during the keyboard-open animation (Android can fire
`keyboardDidShow` / `keyboardDidChange` events with
slightly different heights during the open). Each
re-layout fires `onContentSizeChange`.

The v3.11.15 fix gated the auto-scroll on
`messages.length grew`, so layout reflows no longer
scroll. But the FlatList's `contentSize` ALSO changes
slightly during the keyboard animation (as items
re-measure in the shrinking visible area), and on
Android the FlatList's internal position auto-corrects
to the new `contentSize.height - layoutMeasurement.height`
target. The user sees the chat "skip up" as the
auto-correct target jumps.

Fix: also gate the auto-scroll on `keyboardVisible`.
While the keyboard is up, the user is typing — they're
not reading new messages arriving. Skip the auto-scroll.
When they send (which closes the keyboard), the
message arrival fires `onContentSizeChange` with the
keyboard already closed, and the auto-scroll lands
smoothly to the new message.

```ts
onContentSizeChange={() => {
  if (!chatInitialDecisionRef.current) return;
  if (keyboardVisible) return;  // ← v3.11.17: skip during keyboard
  const grew = messages.length > prevMessagesLengthRef.current;
  prevMessagesLengthRef.current = messages.length;
  if (grew && chatAtBottomRef.current) {
    chatRef.current?.scrollToEnd({ animated: true });
  }
}}
```

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `renderMessage`: suppress per-bubble quest pill when
    user is on active quest AND bubble matches active
    quest. Still show pill for cross-quest or legacy
    content.
  - `onContentSizeChange`: gate on `keyboardVisible`.
    Skip auto-scroll while keyboard is up.
- Bumps: `package.json` 3.11.16 → 3.11.17.
- `versionCode` 412 → 413, `versionName` "3.11.16"
  → "3.11.17".

## Lesson

**Don't auto-scroll while the user is typing.** The
auto-scroll's purpose is "follow new content the user
is reading." When the user is typing, they're
producing content, not reading it. Any visual change
to the scroll position during typing is a
distraction.

The keyboard open is also the moment the chat panel
is shrinking, which is the moment the FlatList's
content-size calculation is most volatile. Suppressing
auto-scroll during this window eliminates a class of
visual glitches that arise from the layout settling.

## Strong rule

**Auto-scroll is a READING-INTENT feature, not a
content-presence feature.** Gate it on:
- The user is at the bottom (chatAtBottom === true).
- New content arrived (length grew).
- The user is not actively producing content
  (keyboard not visible, no input focus, etc.).

Skip it for any state where the user isn't trying
to follow new messages. The "during typing"
exception is one example; another future case might
be "during voice-mode playback" or "during scroll
gesture" (already implicitly handled by chatAtBottom).
