# v3.11.25 — revert per-bubble quest chip to inline tinted pill; scrollToEnd → animated:false to kill "skip up" jitter

Two Tobe reports at 2026-10-01 07:18 (Discord #cyber-dev):

> "Lets change back to the previous quest text style in the
> chat bubbles on the mobile. It still has some scroll issue,
> i just opened the app after it being on in the background
> for about 15min, perhaps he has answered now. I see he has
> not. And additionally when i scroll to the bottom it skips
> back up a bit."

Two distinct symptoms — chip visual style + scroll jitter
on bottom-scroll. This release addresses both.

## Symptom 1: per-bubble quest chip too prominent

v3.11.22 changed the per-bubble quest chip from an inline
tinted pill (sitting in the agent-label row, two color
variants matching the bubble's border color) to a
solid-orange absolutely-positioned chip pinned to the
top-right corner of every bubble. The change was made on
Tobe's 2026-09-30 12:37 feedback ("the text is hard to
see in gray, it should be Orange") — but after 24h of
real use, the chip was visually too prominent:

- Solid orange overrode the bubble border-color identity
  (orange = quest context, regardless of whether the
  bubble was user or AI).
- Absolute positioning meant the chip didn't share the
  row with the agent label — it visually "stuck on" to
  the bubble corner.
- The solid orange felt out of place against the white
  bubble backgrounds.

### Fix

Revert to the v3.11.5–v3.11.17 inline tinted pill:

```tsx
bubbleHeaderRow: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 4,
},
bubbleQuestLabel: {
  fontSize: 9,
  fontWeight: '600',
  paddingHorizontal: 6,
  paddingVertical: 2,
  borderRadius: 4,
  overflow: 'hidden',
  marginLeft: 6,
  maxWidth: '60%',
},
bubbleQuestLabelAi: {
  backgroundColor: t.brand.accentDim + '22',
  color: t.brand.accent,
},
bubbleQuestLabelUser: {
  backgroundColor: t.brand.cyanDim + '22',
  color: t.brand.cyanDim,
},
```

JSX applies the per-side variant based on `item.isUser`:

```tsx
<Text
  style={[
    styles.bubbleQuestLabel,
    item.isUser ? styles.bubbleQuestLabelUser : styles.bubbleQuestLabelAi,
  ]}
  numberOfLines={1}
>
  🎯 {name}
</Text>
```

The `🎯` emoji prefix is restored (v3.11.18 had removed
it for width; the inline pill has room).

The v3.11.18 logic — always render the pill when the
bubble carries a quest stamp, render NOTHING for un-stamped
legacy bubbles — is preserved. The pill renders only on
bubbles with `item.activeQuestId != null`.

The v3.11.22 logic that the pill pinned to top-right with
solid orange is removed entirely.

## Symptom 2: chat "skips back up a bit" when scrolled to the bottom

Tobe opens the app after 15 min in the background,
manually scrolls down to the bottom of the chat, and the
chat visibly moves upward by a small amount — leaving a
sliver of blank space at the bottom of the visible chat.
He drags back down, and the moment comes back.

### Root cause

`onContentSizeChange` fires (broadcasts landing,
periodic heartbeats, agent-history hydrate — anything that
re-renders the FlatList). The handler checks
`wasNearBottom = chatAtBottomRef.current ||
lastDistanceFromEndRef.current < 100` and, if true,
schedules `scrollToEnd({ animated: true })` 80ms later.

When the user is at the bottom:

1. `chatAtBottomRef.current` is true.
2. The 80ms timer fires.
3. `scrollToEnd({ animated: true })` runs
   `Animated.Scroll` over ~250ms.
4. During the animation, the FlatList fires `onScroll`
   events whose `contentOffset.y` briefly diverges from
   the settled position (Animated.Scroll interpolates
   frame-by-frame).
5. The `onScroll` handler updates
   `lastDistanceFromEndRef` / `chatAtBottomRef` based on
   the in-flight value.
6. The Animated.Scroll itself causes a contentSize
   re-measure, which fires another `onContentSizeChange`.
7. `wasNearBottom` is true (the in-flight value looks
   "near bottom" even when the animation is at the
   target), so another scrollToEnd is queued.
8. The user sees a visible "skip up + scroll down" loop
   for as long as the cycle continues.

This is the **same class of bug as MEMORY.md layer 11**
(the "scroll-jitter every ~20s" symptom that v3.11.18
attempted to address), but the v3.11.18 debounce was
not sufficient — `animated: true` makes the animation
itself a source of new onScroll + onContentSizeChange
events, so the debounce can never fully settle.

### Fix

`scrollToEnd({ animated: false })` in the debounced
handler. After 80ms of debounce, the FlatList has fully
settled; an **instant** scroll lands at the precise
target without firing any in-flight `onScroll` events.

Visually a no-op when the user is already at the bottom
(which is the case for most `scrollToEnd` calls — the
chat scrolls to a position it's already at). For the
rare "near-but-not-at-bottom" case (user within 100px of
bottom when a new message arrives), the instant scroll
lands precisely at the new bottom. The user sees the
new message appear at the bottom of the chat. No
animation, no skip-up loop.

This is the **fourth iteration** of the scroll-jitter bug:

- v3.10.111: forced scroll-to-bottom on every layout
  (Tobe: "almost forcefully scrolls down").
- v3.10.178: restore-to-saved-offset, no force-scroll.
- v3.11.15: gate on `messages.length` grew (the
  "v3.11.14 double-jump" fix).
- v3.11.18: debounce 80ms + re-anchor on reflow-only.
- **v3.11.25**: scrollToEnd → `animated: false` (this
  release).

### Lesson

`animated: true` for `scrollToEnd` is unsafe in any code
path that listens to `onScroll` and `onContentSizeChange`
to make decisions. The animation itself produces those
events with mid-flight values, which can feed back into
the scroll decision. Use `animated: false` for any
programmatic scroll that should be **invisible if the
target equals the current position**.

## Files changed

- `src/screens/HomeScreen.tsx` — chip styles + JSX variant
  applied; `onContentSizeChange` handler's
  `scrollToEnd({ animated: false })`.
- `package.json` — version bump to `3.11.25`.
- `android/app/build.gradle` — versionCode `419`,
  versionName `"3.11.25"`.