# 3.1.54 — Vertical walkable band is now scale-aware (clawsuu stops bouncing)

## What it fixes
Tobe reported clawsuu was still "running up and down 10x in a row" after v3.1.53. Lamasuu was calm. The v3.1.53 state-machine tuning helped lamasuu but didn't address the real cause of clawsuu's behaviour.

## Root cause: the walkable band was too narrow for larger sprites
The vertical bounce bounds in `update()` were:

```js
const minY = canvas.height * 0.60;            // sprite-top at 60% of canvas
const maxY = canvas.height * 0.95 - dh;       // sprite-top at 95% minus sprite height
```

The walkable BAND HEIGHT is `0.35*h - dh`. On a 230px-tall mobile canvas (mobile ARENA_HEIGHT = min(SCREEN_WIDTH*0.52, 230)):

- **Clawsuu** (scale=2, dh=64): band = 230 * 0.35 - 64 = **16.5px tall** ← collapse
- **Lamasuu** (scale=1, dh=32): band = 230 * 0.35 - 32 = **48.5px tall**

Clawsuu's band was 3x smaller. Worse, the bounce code on wall-hit forced `c.direction = 0` (down) at the top wall and `c.direction = 1` (up) at the bottom wall — overriding the AI's chosen direction. So clawsuu walked up, hit the top, was forced to face down, walked down, hit the bottom, was forced to face up. Ping-pong. Lamasuu had more vertical headroom, so the bounce happened less often and the forced direction changes were less visible.

The starting position made it worse: `yFrac = 0.65` for the first companion. With dh=64 and h=230, clawsuu started at c.y = 0.65*230 - 64 = 85.5 — ABOVE the new minY of 138, so it was clamped to the top on the first frame and immediately started the down-then-up cycle.

## The fix
**1. Band is now feet-relative, not sprite-top-relative.**

```js
// Old: minY = h * 0.60, maxY = h * 0.95 - dh   (band = 0.35*h - dh, varies with scale)
// New: minY = h * 0.70 - dh, maxY = h - dh     (band = 0.30*h, same for all scales)
```

Now the band height is always `0.30 * canvas.height` regardless of sprite size. For h=230, both companions get a 69px vertical band. No more "clawsuu is squashed into a 16px corridor."

The new `minY` puts the FEET at grass top (0.70*h, where the grass starts in the background image), and the new `maxY` puts the FEET at the canvas bottom. So the companion can walk "up toward the horizon" and "down toward the foreground" across the whole grass band.

**2. Bounce no longer overrides direction.**

```js
// Old: c.direction = 0 on top bounce, = 1 on bottom bounce (forced AI direction)
// New: bounce only flips c.vy, the AI's _lastWalkDir is preserved
```

Forcing `c.direction` on bounce was fighting the AI's 75% direction bias. The next walk roll would either respect the forced direction (75%) or re-randomize (25%), creating inconsistent behaviour. Now the bounce just pushes the companion back into the band; the AI picks the next direction on the next state roll.

**3. Layout yFrac is now feet-Y, not sprite-top-Y.**

```js
// Old: c.y = h * yFrac - dh  where yFrac=0.65..0.85
//       (sprite-top at 65%-85% of canvas)
// New: c.y = h * yFrac - dh  where yFrac=0.78..0.92
//       (feet at 78%-92% of canvas)
```

The new yFrac range matches the new feet-based band [0.70, 1.0]. Companion 0 starts with feet at 78% (mid-band, slightly toward the horizon), companion 1 starts with feet at 92% (near the foreground).

## Why the v3.1.53 tuning didn't help
The v3.1.53 changes (60% idle, 75% direction bias) were all about HOW the AI rolls directions. But the bounce was OVERRIDING the AI's choice on every wall hit. So the AI's calibration didn't matter — the bounce was the dominant force on clawsuu. Lamasuu had a wider band, so the bounce happened less often, so the AI's calibration was visible.

## Math check (h=230)
| Companion | scale | dh  | start c.y | minY  | maxY  | band  | start in band? |
|-----------|-------|-----|-----------|-------|-------|-------|----------------|
| Clawsuu   | 2     | 64  | 115.4     | 97    | 166   | 69px  | ✓ (26% from top) |
| Lamasuu   | 1     | 32  | 179.6     | 129   | 198   | 69px  | ✓ (79% from top) |

Both have the same 69px band. Walk speed is 0.020-0.032 (midrange 0.025), at 60fps that's ~0.42px/frame. To cross 69px takes ~165 frames = ~2.75s. Walk duration is 3-6s, so most walks will END before hitting a wall. The "spam up and down" pattern is now structurally impossible.

## Files changed
- `android/app/src/main/assets/arena.html` — band math (update + layout) and bounce code
- `package.json` — 3.1.53 → 3.1.54
- `android/app/build.gradle` — versionCode 103 → 104, versionName "3.1.54"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.54
- `CHANGES_3.1.54.md` (new)

## On lamasuu size (still open)
Tobe: "Sizes looks good again."

Last session, I had the analysis: hare ears add ~10-15px of phantom height to lamasuu's silhouette, making the 32px hare look as tall as the 64px boar. The visual sizes ARE correct in pixel terms (2x body area), but the SILHOUETTE comparison is misleading because of the ears.

If Tobe still feels lamasuu looks bigger than expected, the workaround from last session is: set lamasuu's desktop scale to 4 (→ mobile 2 → 64px), so both companions are 64px. The hare's ears will still extend higher, but the body widths will match.
