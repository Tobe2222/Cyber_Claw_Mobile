# v3.11.27 — kill the "wild scrolling" cycle on the chat

**Tobe 2026-10-01 10:14:**

> "The chat scroll is still buggy. I jumps all around. Then
> i go to the bottom, it stays there for some seconds and it
> goes wild scrolling again."

Still present in v3.11.26. The v3.11.25 fix (animated:
false) addressed the "skip up a bit" symptom but didn't
kill the underlying self-perpetuating scroll cycle.

## Root cause

The v3.11.18 onContentSizeChange handler fires
scrollToEnd on **any** contentSize change while the user
is at the bottom:

```ts
const wasNearBottom = chatAtBottomRef.current ||
  lastDistanceFromEndRef.current < 100;
if (wasNearBottom) {
  // schedule scrollToEnd at 80ms
}
```

But `onContentSizeChange` fires not only when new
content arrives — it also fires on pure FlatList
re-measurement passes with the **same** contentSize.
Android's React Native FlatList does this on every
scroll (each scrollToEnd → onScroll → re-measure →
another onContentSizeChange, with height drifted by
+/-1-2px from the previous measurement).

The cycle:

1. onContentSizeChange #1 (newHeight = 5000.0px)
2. Schedule scrollToEnd at 80ms.
4. 80ms later, scrollToEnd fires (instant).
5. scrollToEnd triggers onScroll.
6. FlatList re-measures. New contentSize = 5000.5px.
7. onContentSizeChange #2 (newHeight = 5000.5px, delta=+0.5).
8. Schedule scrollToEnd at 80ms.
9. Repeat.

Each scrollToEnd is `animated: false` (v3.11.25), so
the moves are instant — but the FlatList re-measures
after each scroll and the schedule never settles. The
loop persists forever, and the user sees the chat
position jiggling by 1-2px every ~80ms while they're
at the bottom.

Tobe's report: "I go to the bottom, it stays there for
some seconds and it goes wild scrolling again." The
"some seconds" gap is the boundary of a heartbeat /
broadcast event that re-triggers the chain. Once it
starts, it self-perpetuates until the user scrolls away
from the bottom (which sets chatAtBottomRef = false
and breaks the loop).

## Fix

Only auto-scroll when the contentSize **actually
changed** by more than 2px (the per-measurement
sub-pixel jitter). Pure re-measurement passes (same
contentSize within +/-2px) are skipped, which breaks
the cycle.

```ts
const newHeight = (typeof h === 'number') ? h : 0;
const prevHeight = prevContentHeightRef.current;
const heightDelta = newHeight - prevHeight;
prevContentHeightRef.current = newHeight;
const heightChanged = heightDelta > 2 || heightDelta < -2;
if (wasNearBottom && heightChanged) {
  // schedule scrollToEnd
}
```

The shrunk case (heightDelta < -2) catches the
v3.11.18 "stranded above new bottom" symptom — when
a bubble's text rewrapped to remove a line of height,
the user might be left stranded above the new (smaller)
bottom. We re-anchor in that case.

## What v3.11.18 got right vs what v3.11.27 fixes

- **v3.11.18 (correct):** Re-anchor when contentSize
  shrinks (bubble rewrapped shorter). Without this, the
  user is stranded above the new bottom.
- **v3.11.18 (buggy):** Re-anchor on ANY contentSize
  change, including pure re-measurement passes with
  the same height. This produces the wild-scrolling
  cycle.
- **v3.11.27:** Only re-anchor when height actually
  changes. Pure re-measurement passes (height drift
  +/-2px) are no-ops. Grows AND shrinks trigger
  re-anchor; unchanged heights are skipped.

## Files changed

- `src/screens/HomeScreen.tsx` — `prevContentHeightRef`
  added; `onContentSizeChange` callback now reads
  `(_w, h)` params and gates scrollToEnd on a real
  height delta.
- `package.json` — version bump to `3.11.27`.
- `android/app/build.gradle` — versionCode `421`,
  versionName `"3.11.27"`.