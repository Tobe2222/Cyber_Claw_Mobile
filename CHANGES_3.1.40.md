# 3.1.40 — Mobile Arena: Match Desktop Feel

## What it fixes (from the v3.1.39 screenshot test)
1. **Floating in the sky** — feet were at 60% of canvas height, but the actual visible ground in the bgImage (1266×631) starts at ~72% of image height. On a 1.8:1 mobile canvas that's ~78% of canvas height, not 60%.
2. **Above the ground** — same root cause: 60% was a guess, not derived from the actual image.
3. **Too big** — default scale 4 (128px tall) dominated the small mobile viewport.
4. **Not moving on first load** — initial state was `idle` with stateTimer 0.2-1.0s, so the first second was always idle. On a 1-2s screenshot the companion was guaranteed to be in idle.
5. **"Arena ready" stuck on screen** — the status overlay never cleared, so "ARENA READY" sat in the top of the canvas forever.

## The fixes (`arena.html`)

1. **Ground fraction derived from the actual bgImage.** The forest background is 1266×631 (2:1 aspect); the walkable ground (the green grass band) starts at ~72% of the image. Stretched to fill the mobile canvas (1.8:1 typical), the ground ends up at ~78% of canvas height. `GROUND_FRACTION = 0.78`, with `c.y = groundLine - dh` so the FEET sit on the ground.

2. **Default scale 4 → 2.** Desktop default is 5 (and the desktop canvas is huge). Scale 2 (= 64px tall) fits comfortably in the small mobile arena. If the desktop sends an explicit `scale`, we still use it (e.g. lamasuu with desktop-set 3 stays at 3).

3. **Initial state = `walk`, not `idle`.** Companions start moving on first paint. First `pickState` roll after 0.3-0.7s — long enough to be a "natural" first action, short enough that the user doesn't see them as static.

4. **"Arena ready" cleared after 2.5s** so it doesn't sit on top of the action.

## What I deliberately did NOT change
- State distribution (30% idle / 45% walk / 20% run / 5% zoomies) — still the right tuning for the small viewport.
- Mirror stays read-only: no click handlers, no toys, no treats, no speech bubbles.
- Vertical movement suppressed (companions stay on the ground line).
- The desktop's `_pixelCompanionScale` defaults are unchanged (5 for new agents). Mobile is independent.

## Files changed
- `android/app/src/main/assets/arena.html` — GROUND_FRACTION, default scale, initial state, status clear
- `package.json` — 3.1.39 → 3.1.40
- `android/app/build.gradle` — versionCode 89 → 90, versionName "3.1.40"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.40
- `CHANGES_3.1.40.md` (new)

## Verification math (on a 720×400 mobile canvas)
- groundLine = 0.78 × 400 = 312px
- scale-2 sprite (32×2 = 64px tall), feet at 312, head at 248
- Sprite body fills the lower 16% of canvas, with the actual ground (visible green) at 312 → matching
- Sprite top at 248 sits clearly above the orange horizon line, in the sky/upper forest area — natural pixel-arc proportions

## Lesson learned
- The desktop's `horizonLine + 0.1 = 0.6` works for the desktop because the desktop's canvas is 1.4:1 — when you stretch a 2:1 image to 1.4:1, the image's 72% horizon lands at 72% × (2/1.4) = 103% (clipped) — i.e. ground is at the very bottom of the canvas. So 0.6 actually puts feet in the dirt, not in the sky. The math is aspect-ratio dependent and doesn't port directly to a wider canvas.
- When porting desktop positioning to mobile, derive the ground line from the actual image's content (where the grass is) and the canvas's aspect ratio, not from the desktop's hardcoded fraction.
- The bgImage was already being stretched to fill the canvas on both desktop and mobile — same drawing logic, different canvas aspect → different visible ground position. Always test positioning on the target device.