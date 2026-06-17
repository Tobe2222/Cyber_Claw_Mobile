# v3.1.38 — port the desktop's pixel-arena AI to mobile (state machine + 4-direction facing)

## What was wrong

After v3.1.37, the mobile arena drew the forest background
and the companion sprites on boot. But the companions were
static — they stood in place and bobbed 2px on a sine wave
every 0.85–1.15 seconds. The desktop's pixel-arena.js runs a
full state-machine AI on each companion (idle / walk / run /
zoomies, with 4-direction sprite facing, hunting toys and
treats, bouncing off arena bounds). The mobile felt lifeless
by comparison.

The user reported it as "they still don't behave like they do
on the desktop."

## What v3.1.38 changes

We close the "feels alive" gap on the mobile read-only mirror
without expanding the scope past what the mirror should do.

### arena.html

1. **Load every animation the catalog lists**, not just
   `idle`. Previously `buildCompanion` did
   `const animsToLoad = ['idle']`. Now it iterates
   `Object.entries(compData.animations)` and loads all of
   them — so `walk`, `run`, `hurt`, `death`, `attack` are
   pre-fetched and decoded at build time. The catalog's
   per-animation `speed` field is now consumed as "frames
   per second" → `frameInterval = round(1000 / speed) ms`.
   Idle = 6 fps (167ms), walk = 8 fps (125ms), run = 10 fps
   (100ms), so walking and running look distinctly more
   energetic than idling.

2. **State machine per companion**, mirroring the desktop
   `pixel-arena.js` distribution:
   - `state ∈ {'idle', 'walk', 'run', 'zoomies'}`
   - `direction ∈ {0,1,2,3}` — sprite-sheet row, same
     convention as the desktop (0=down, 1=up, 2=left, 3=right)
   - `vx, vy` — velocity in pixels per ms
   - `stateTimer` — ms until the next state roll
   - New `pickState(c)` is called from `update()` when
     `stateTimer ≤ 0`. Same roll distribution as the desktop:
     idle 45% / walk 30% / run 15% / zoomies 10%
     (where zoomies reuses the `run` animation with a
     higher speed).
   - Initial `stateTimer` is randomised per-companion
     (200–1000 ms) so the two companions don't roll their
     first behaviour on the same tick.

3. **Velocity + bounds clamp** in `update()`:
   - `c.x += c.vx * dt` each frame
   - Side bounce: if `c.x + halfW < 0` or `> canvas.width`,
     snap to the edge and reverse vx, and force the
     facing direction to match the new heading
   - Vertical safety clamp (rarely fires on the mobile since
     companions stay on the ground line, but defensive)
   - After movement, the velocity → direction sync re-asserts
     the facing row from vx (left when vx<0, right when vx>0).
     This matches the desktop's preference for side sprites
     during horizontal motion.

4. **Per-animation frame advance**: `update()` now calls
   `pickAnim(c)` to get the current animation (falling back
   to `idle` if the state animation didn't load), and advances
   `c.frame` based on that animation's `frameInterval` instead
   of the old hardcoded 120ms for every state.

5. **Directional drawing in `drawCompanion()`**: previously
   `sy = 0` (always the first row). Now `sy = row * fh` where
   `row = c.direction`, clamped to the number of rows the
   sheet actually has. So a companion walking left draws
   from row 2 (the left-facing frames), walking right from
   row 3, etc.

### What this is NOT

- **No treats / toys / speech bubbles / sleep** — the mobile
  is still a read-only mirror of the desktop's arena. The
  file's top-of-file comment from v3.1.31 still applies.
  Those features are out of scope until the user asks for
  the mirror to become interactive.
- **No vertical movement** — the mobile has a single ground
  line; companions don't walk "up" or "down" the screen.
  `vy` is always 0. The direction row is still 0–3 because
  the catalog has 4 rows, but only rows 2 (left) and 3
  (right) get used in practice.
- **No per-companion personality / boredom model** — the
  desktop has a `comp.boredom` accumulator that biases the
  state rolls after long idle stretches, and a few "play"
  / "stretch" / "yawn" branches. The mobile uses pure
  random rolls. Adding boredom is a future step.

## Files

- `android/app/src/main/assets/arena.html`
  - `buildCompanion`: load all catalog animations, add
    `state`/`direction`/`vx`/`vy`/`stateTimer` fields
  - New `pickState(c)` — desktop-style AI state roll
  - New `pickAnim(c)` — current-state → animation lookup
    with idle fallback
  - Rewrote `update(dt)` — state timer, velocity, bounds
    clamp, per-anim frame advance
  - `drawCompanion(c)` — sprite-sheet row = direction
- `package.json` — version 3.1.37 → 3.1.38
- `android/app/build.gradle` — versionCode 87 → 88,
  versionName 3.1.37 → 3.1.38
- `.github/workflows/build.yml` — APK artifact name
  `CyberClaw-Android-3.1.37.apk` → `…-3.1.38.apk`
- `.github/workflows/android-build.yml` — debug artifact
  name `app-debug-3.1.37` → `app-debug-3.1.38`

## Verification

- `node --check` on the extracted `<script>` block from
  `arena.html` parses clean.
- Companion objects now expose `state`, `direction`, `vx`,
  `vy`, `stateTimer` in addition to the previous fields;
  `drawShadow` / `drawRing` / `drawName` / `bobFor` are
  unchanged and still work.
- The desktop's `pixel-arena.js` AI distribution
  (idle/walk/run/zoomies) is preserved exactly.
- Shadow stays on the ground line (uses `c.y`, not the
  bobbed `_drawY`); the companion bobs above the shadow
  as it walks.
