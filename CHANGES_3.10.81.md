# v3.10.81 — Android chat input clipped under suggestion bar (v3.10.80 follow-up)

Tobe reported on v3.10.80 (2026-07-23, after building
v3.10.80):

> "@Clawsuu now it hides under the top of the
> keyboard. This should be adaptive or smart so it
> fits all phones if possible"

Screenshot showed the chat list squeezed correctly,
and the input row was visible — but its bottom edge
was clipped under the keyboard's suggestion bar
(Gboard's "@Clawsuu @Clawsuu#5799 Ja" row). The input
field's text was visible but the bottom ~20-25dp of
the row was covered.

## Root cause

v3.10.80 used `e.endCoordinates.height` from the
`keyboardDidShow` event as the keyboard's height, then
applied it as `paddingBottom` on the inputContainer.

On Android 15+ with edge-to-edge, `endCoordinates.height`
reports the keyboard's **content area height** (just
the keys area, ~240dp on a typical phone), NOT the
keyboard's **visual height** (which includes the
~50-60dp suggestion bar at the top + rounded-corner
padding).

Result: `paddingBottom: endCoordinates.height` only
pushed the input up by the keys area. The input
row landed at the top of the keys area, and the
suggestion bar (which is also part of the keyboard
visually) covered its bottom edge.

## Fix

Compute the keyboard's **visual height** from
`endCoordinates.screenY` instead:

```tsx
const coords = e?.endCoordinates;
const visualHeight = coords
  ? (typeof coords.screenY === 'number'
      ? Math.max(0, Dimensions.get('screen').height - coords.screenY)
      : coords.height ?? 0)
  : 0;
setKeyboardHeight(visualHeight);
```

`screenY` is the Y position of the keyboard's actual
top edge (in screen coordinates, including the
suggestion bar and any top decoration). Subtracting
it from the full screen height gives the keyboard's
true visible height.

Fallback to `endCoordinates.height` if `screenY`
isn't present (older RN versions or some keyboards).

Used `Dimensions.get('screen').height` (the full
physical screen height) rather than
`Dimensions.get('window').height` (the app window,
which may be different if adjustResize ever starts
working again on some devices).

## Why this is "adaptive / fits all phones"

Different keyboard apps have different layouts:
- **Gboard:** suggestion bar at top, ~50-60dp tall
- **Samsung Keyboard:** suggestion bar + Samsung's
  handwriting area, ~70-80dp
- **SwiftKey:** suggestion bar, ~40-50dp
- **Hacker Keyboard (no suggestion bar):** 0dp

Using `screenY` (which is the keyboard's actual top
edge regardless of internal layout) is the only
measurement that's reliable across all keyboard
apps. The v3.10.80 attempt of just using
`endCoordinates.height` was correct in spirit
but wrong in API — it assumed the height includes
all visual elements, which it doesn't on modern
Android.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Replaced `e?.endCoordinates?.height` with
    `Dimensions.get('screen').height - coords.screenY`
    (with fallback to height)
- `android/app/build.gradle` — versionCode 304→305,
  versionName 3.10.80→3.10.81
- `package.json` — version 3.10.80→3.10.81

## Lessons

**`endCoordinates.height` from RN's keyboard module
is NOT the keyboard's visual height on Android 15+.**
It's the keyboard's content area. The visual height
is `screen_height - screenY`. Always use the
screenY-derived value on Android, fall back to
height only if screenY is missing.

**When the user says "make it adaptive / fit all
phones", the answer is almost always "use the
source of truth rather than a derived value".**
The keyboard's actual top position is the source of
truth for "where does the visible area end".
`endCoordinates.height` is derived from that but
with assumptions baked in (the height INCLUDES the
suggestion bar). When those assumptions break on
a new platform version, the derived value is wrong
silently. Using `screenY` directly makes no
assumptions.

**Two-stage fixes on cross-platform UI bugs are
common.** v3.10.80 got the structural fix right
(manual padding instead of relying on adjustResize),
and v3.10.81 just gets the measurement right.
Don't be afraid to ship a "first attempt" version
that fixes the main bug — the measurement issue
is easier to spot from a screenshot than from
reading the code in isolation.

**Add a small breathing-room buffer as
belt-and-suspenders.** Even with `screenY`, the
input row might sit visually flush against the
keyboard. Adding 8dp buffer above the keyboard
would prevent this. Skipped for now because the
input row's own `paddingVertical: 8` already
provides visual separation. If Tobe reports the
input looks "too tight" against the keyboard in
a future version, add an explicit buffer.