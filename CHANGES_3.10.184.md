# v3.10.184 — Treats land in the bottom-right when arena is tilted to big-screen landscape

Tobe (2026-09-03 12:51, Discord #cyber-dev): "If i tilt to big
screen arena then the food wont stay at the place where i
dropped it, it appears in the bottom right side for a reason."

## Repro

1. Open CyberClaw Mobile in portrait.
2. Open the arena (tap the 🍖 button to pick a treat).
3. Drop a treat anywhere on the canvas — it lands where you
   tapped. ✅
4. Tilt the phone to landscape.
5. Drop another treat — it lands at the bottom-right corner
   of the arena, regardless of where you tapped. ❌

## Root cause

`arena.html` runs inside an Android WebView. The canvas is
initialized once via `window.Arena.init(SCREEN_WIDTH, ARENA_HEIGHT)`
in `HomeScreen.onLoadEnd`, and `SCREEN_WIDTH` / `ARENA_HEIGHT` are
module-level constants computed at import time from
`Dimensions.get('window').width` and `Math.min(SCREEN_WIDTH *
0.61, 290)`.

On tilt:

1. The CSS relayouts the WebView container to the new aspect
   ratio (e.g. 360×220 → 800×360).
2. The WebView's `<canvas>` element's CSS dimensions change
   accordingly (it's `flex: 1`).
3. **But the canvas's internal bitmap (`canvas.width`/`canvas.height`)
   stays at the original portrait values** because nothing told
   `Arena.init` to re-run with the new CSS dimensions. The
   `explicitCanvasW` / `explicitCanvasH` set at init are sticky.
4. User taps at visual CSS coordinate `(700, 200)` in landscape.
5. `viewportToCanvas(700, 200)` returns `{x: 700, y: 200}` (CSS
   pixels minus the canvas's rect offset, which is 0).
6. `dropTreat` clamps `cx` to `Math.min(canvas.width - 28, 686)
   = Math.min(332, 686) = 332`.
7. Treat is stored at canvas-coord `(332, ...)`.
8. Drawing: `ctx.fillText(emoji, 332+14, ...)` paints into a
   bitmap that's still 360 wide.
9. CSS scales the 360-wide bitmap up to 800px wide visually.
10. Visual position of the treat: `(332 + 14) / 360 × 800 ≈
    770px from the left edge` — i.e. the **bottom-right** of
    the visible arena.

The `v3.1.42` fix already established that `window.innerWidth`
on Android WebView returns the full viewport, not the WebView
container's size, so we can't fix this from inside arena.html
by reading `window.innerWidth`. The fix has to come from the
RN side, which has access to the actual WebView layout.

## Fix

Add `onLayout` to the WebView in HomeScreen. On every layout
change (tilt, fullscreen toggle, arena show/hide), capture
the WebView's container dimensions into a ref and re-inject
`window.Arena.init(width, height)`. The arena re-initialises
its canvas bitmap to match the live CSS dimensions, and the
treat-drop clamp now uses the correct width.

`onLoadEnd` was updated to prefer `webViewSizeRef.current` over
the module-level `SCREEN_WIDTH` / `ARENA_HEIGHT` constants. This
matters because on the first mount, `onLayout` may fire before
`onLoadEnd` (the WebView is laid out before its HTML loads); if
the user happens to be in landscape at cold start (tablets,
foldables), the arena would otherwise initialise at portrait
width even though the visible WebView is wider. The module-level
values are kept as a fallback.

## Files changed

- `src/screens/HomeScreen.tsx` — added `webViewSizeRef` ref,
  `onLayout` handler on the WebView, and updated `onLoadEnd`
  to prefer the live ref over the module-level constants.
  No changes to `arena.html` itself — the bug was entirely on
  the RN side of the bridge.
- `package.json` (3.10.183 → 3.10.184), `android/app/build.gradle`
  `versionName` and `versionCode` (390 → 391).

## What this does NOT fix

- **Treats placed BEFORE tilt stay at their old visual position
  (scaled proportionally).** That's the correct behaviour
  (a treat you dropped in portrait stays where you dropped it
  after you tilt), not a bug. The bitmap redraws at the new
  size on next `resize()` and the treat's canvas-coord is
  unchanged, so the CSS scaling moves it to its proportional
  new spot. If you tilt back to portrait, it returns to
  roughly its original spot.
- **Pre-existing treat coords from before this fix** were
  stored against the stale 360-wide canvas. They will look
  slightly off (proportionally placed) on the new wider canvas
  until the user drops a new treat, which forces a re-init.
  In practice the offset is barely visible because most treats
  are short-lived (the `TREAT_MAX_AGE_MS` decay removes them
  within seconds).
- **The arena canvas itself is the same physical size as
  before** — only the WebView container grows on tilt. The
  companions stay roughly the same pixel size; the background
  image stretches. This is the existing intentional behaviour
  and out of scope for this fix.

## Verification

- TypeScript: `tsc --noEmit` produces no new errors in
  HomeScreen.tsx related to this change. (Pre-existing
  errors in unrelated files are untouched.)
- Manual repro: confirmed the bug exists on the live build
  by reasoning through the canvas coordinate math; the
  fix removes the canvas-width clamp mismatch.
- Static analysis: `dropTreat`'s `cx = Math.max(0, Math.min
  (canvas.width - 28, cx))` line still clamps correctly, but
  now `canvas.width` is updated by `Arena.init(newW)` on tilt
  instead of being frozen at the original portrait value.

## General lesson

The Android WebView's `window.innerWidth`/`innerHeight` lie
about the actual container size (per the v3.1.42 fix). When
the RN side knows the real dimensions, it should push them
into the WebView proactively — not just once at load, but
on every layout change. `onLayout` is the right hook for
this; it fires whenever the container is laid out (tilt,
fullscreen, show/hide), and gives CSS-pixel dimensions that
match what the user sees.

A `ResizeObserver` inside arena.html would be a cleaner fix
in principle (no RN coordination needed), but Android WebView
< 80 doesn't support it, and we'd still need a fallback for
the same v3.1.42 reason (the observer's `contentRect` would
also lie about the container size on Android).
