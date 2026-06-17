# 3.1.43 — Mobile Arena: Clean Rewrite (Stop Guessing, Start Showing)

## Why this exists
v3.1.39 → v3.1.42 was a sequence of bandaids on top of bandaids. The original mobile arena.html (v3.1.38) was a port of the desktop's pixel-arena.js state machine, but it was developed organically and accumulated many small issues that I tried to fix one at a time without seeing the actual runtime values.

v3.1.43 is a CLEAN REWRITE. Same architecture, same state machine, same sprite conventions, but:
- Single source of truth for canvas size: `Arena.init(W, H)` from RN
- State and animation decoupled (state='walk' but animation='run' if run sheet loaded — no silent fallbacks to idle)
- Visible debug overlay showing canvasW, canvasH, windowInnerH, per-companion state/animation/vx/xy
- Timeout on image load (5s) to prevent hanging
- Diagnostic data in `arena_set_agents` event showing which animations loaded for each companion
- ARENA_SCALE constant (in pixels per second) so speeds are tunable in one place

## Key architectural changes

### 1. `pickAnimationKey()` always returns a valid sheet
Previously: `pickAnim(c)` returned the state's sheet if loaded, else fell back to idle. So if walk PNG failed to load, the companion would have state='walk' and vx applied (moving) but show idle animation. That's the "slide without walking animations" bug.

Now: `pickAnimationKey(c)` walks a fallback chain (state → run/walk alternates → walk → idle → any). The companion ALWAYS has an animation sheet that matches its state, OR a sensible fallback that has the correct direction rows.

### 2. `state` and `animation` are separate fields
- `state` = AI state (idle / walk / run)
- `animation` = sprite sheet to draw (idle / walk / run / etc.)

The desktop does the same. The state machine updates state; the draw step updates animation by calling `pickAnimationKey()`. If a sheet is missing, animation can differ from state — but it's always a sheet that exists.

### 3. Visible debug overlay
A small green text box in the top-left of the canvas shows:
- Canvas dimensions (canvas.width × canvas.height)
- Window inner height (the broken value)
- Explicit values from RN init
- Per-companion: state, animation, vx, x, y, direction

This is on by default. If positioning is still wrong, you'll see exactly what the canvas thinks its size is. Toggle via `window.Arena.setDebug(false)` from RN if needed.

### 4. Image load timeout
5-second timeout on each image load. If a PNG is missing, we don't hang forever waiting for onload.

### 5. Initial state random walk
First `pickState` is called after 2-5 seconds (was 4-7 in v3.1.42). 40% idle / 50% walk / 10% run distribution. No "initial state = walk" hack — the state machine handles it.

### 6. The companion flow
On `setAgents`:
1. RN calls `Arena.init(SCREEN_WIDTH, ARENA_HEIGHT)` — canvas size is correct
2. RN calls `Arena.setAgents([{id, sprite, scale}, ...])`
3. WebView builds each companion (loads all sprite sheets, picks the one specified)
4. Layout puts feet at `0.70 * canvas.height - dh` (the actual grass position in the bgImage)
5. The first `pickState` happens after 2-5s; until then, the initial idle animation plays
6. Each subsequent `pickState` rolls a new state based on the distribution above

## How to test

1. Install the APK
2. Open the app
3. Look at the home screen tab. You should see:
   - A green debug overlay in the top-left showing canvas dimensions, per-companion state/animation
   - Companions on the visible grass band (not floating)
   - Companions walking with visible leg animations (state='walk' or 'run' with side-view sprite rows)
4. If something's wrong, the debug overlay tells you exactly what state each companion is in and what canvas size is being used

## Files changed
- `android/app/src/main/assets/arena.html` — clean rewrite, ~22KB, single-file
- `package.json` — 3.1.42 → 3.1.43
- `android/app/build.gradle` — versionCode 92 → 93, versionName "3.1.43"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.43
- `CHANGES_3.1.43.md` (new)

## What I deliberately did NOT change
- Sprite assets. All sheets already load (verified by file presence).
- React Native side. Same `Arena.init/setAgents/setActive/setBackground` API.
- State distribution tuning. 40/50/10 (idle/walk/run) is a good starting point.
- Scale handling. Mobile default is 2. Desktop-sent scale is respected.

## Lessons (adding to MEMORY)

**Don't bandaid on top of bandaid.** After v3.1.39 → v3.1.40 → v3.1.41 → v3.1.42 all failed to land the floating/animation fix, the right move was to stop and look at the actual runtime values (via a debug overlay) rather than guess at what was wrong. v3.1.43 does that.

**State ≠ Animation.** The desktop separates the AI state from the sprite sheet. The mobile was conflating them. Decoupling them lets the sprite animation be "the best available for this state" rather than "the state or nothing."

**Always show the user what's actually happening.** A small debug overlay in the corner would have saved us 4 iterations.

## Still the user's responsibility
**Lamasuu's size.** The mobile reads `agent.scale` from the desktop's `agents_list` correctly. If lamasuu looks bigger than clawsuu, it's because the desktop config has `lamasuu.scale = 3` (bigger than clawsuu's default 2 on mobile). To make lamasuu smaller, set its desktop scale to 1 or 1.5 — the mobile will respect it.