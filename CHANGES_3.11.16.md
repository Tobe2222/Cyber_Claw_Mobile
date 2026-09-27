# v3.11.16 — restore-scroll uses animated:true instead of double-jump animated:false

Tobe (2026-09-27 21:42, Discord #cyber-dev):

> "@Clawsuu Okey updated and tested. Better but it still
> bugs up and down with high speed from time to time."

v3.11.15 reduced the bounce by consolidating scroll-to-end
into one path with `animated: true`, but the restore
paths still used double-`scrollToOffset({ animated:
false })` (immediate + 300ms settle). The double-jump
is a visible "snap to position A, then snap to position A
again 300ms later" pattern that Tobe is still seeing.

## Root cause

Two paths in HomeScreen had the same defensive
double-scrollToOffset pattern:

1. The restore useEffect (line ~1843): immediate
   scrollToOffset, then 300ms-later scrollToOffset
   with the same offset. The intent was to handle
   FlatList's lazy-measurement: the first scroll
   might land before the FlatList has measured the
   full content, so the offset might be wrong. The
   re-scroll corrects it.

2. The FlatList's `onLayout` (line ~6987): same
   pattern, for the case where onLayout fires before
   the restore useEffect.

In practice, **the first scroll almost always lands
correctly** because the FlatList has had time to
measure by the time tryRestore runs (the polling
backoff gives 75-600ms for the hydrate, which gives
the FlatList plenty of time). The second scroll is
nearly always a no-op visually but **does still
trigger a layout pass** that produces a tiny visible
"settle" — and combined with other animation
frames, looks like bouncing.

## Fix

Both paths now use a single `scrollToOffset({ animated:
true })`. If the FlatList hasn't measured yet, the
animated scroll is internally retried by React
Native's ScrollView as the content becomes available
(this is built into the platform; we don't need to
duplicate the retry in our code). The single
animated scroll is smooth — the user sees one
continuous motion instead of two jumps.

```ts
// Before (v3.11.15 and earlier):
chatRef.current?.scrollToOffset({ offset: off, animated: false });
setTimeout(() => {
  if (cancelled) return;
  chatRef.current?.scrollToOffset({ offset: off, animated: false });
}, 300);

// After (v3.11.16):
chatRef.current?.scrollToOffset({ offset: off, animated: true });
```

Same change applied to the onLayout fallback path.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Restore useEffect: single `scrollToOffset({ animated:
    true })` (was double `scrollToOffset({ animated:
    false })`).
  - onLayout fallback: same single-animated change.
- Bumps: `package.json` 3.11.15 → 3.11.16.
- `versionCode` 411 → 412, `versionName` "3.11.15"
  → "3.11.16".

## Lesson

When a defensive "scroll, wait, scroll again" pattern
exists because the underlying measurement is racy,
**prefer `animated: true` over `animated: false` +
retry**. The platform's ScrollView already retries
internally on animated scrolls. The defensive retry
in our code was duplicating that and producing
visible jumps in the case where the first scroll
was correct.

The diagnostic: when "scroll, wait, scroll again"
produces visible bouncing, the second scroll is
almost always the culprit. Animated scrolls let the
platform hide the retry; non-animated scrolls make
every retry visible.

## What's NOT in this release

If Tobe's "high speed" bouncing persists, possible
remaining sources:

- The FlatList's `removeClippedSubviews` (default
  behavior on Android) might re-create item views
  during scroll, firing onScroll multiple times in
  rapid succession. Each onScroll computes
  `distanceFromEnd` and calls `setChatAtBottom`.
  Same value → bailout. Different value → state
  change → re-render. If the values oscillate, the
  scroll position can oscillate.

- Keyboard insets on Android can fire
  `keyboardDidShow` / `keyboardDidChange` events
  with slightly different heights during the open
  animation. Each event triggers a re-render. The
  FlatList re-lays out. onContentSizeChange fires
  (with v3.11.15, no scroll because length didn't
  grow). But the layout shift itself might cause
  the FlatList to auto-correct its scroll position
  (RN's ScrollView auto-corrects when content
  size changes mid-scroll). The auto-correct
  could be the source of the high-speed bouncing.

If neither of these is the cause, the next step is
to add a debounce on scrollToEnd calls so multiple
fires within 100ms coalesce into one animated scroll.
