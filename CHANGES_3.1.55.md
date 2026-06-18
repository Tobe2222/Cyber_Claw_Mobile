# 3.1.55 — State machine rewritten to match the desktop

## What it fixes
Tobe: "Clawsuu now pingpongs in a longer run but still not strolling about randomly, just up and down in the same area. Lamasuu tends to have a pattern of mostly sideways then turning to face the screen and idling and then do the same again. Why is this so difficult? I just want them behaving the same way as they do on desktop, to do random strolls in all directions. Idling in all directions. No patterns."

## Why the v3.1.53 / v3.1.54 state machine still had patterns
The previous state machine had a **75% direction bias** — when a walk ended, the companion had a 75% chance of continuing in the same direction. Combined with the small mobile arena (69px walkable band on a 187px-tall canvas, 360px wide), that bias was structurally wrong:

- Companion walks up → hits top wall (band is 69px, so a walk easily reaches it)
- 75% bias keeps the direction = "up"
- Bounce flips velocity (vy sign), companion slides back down along the wall
- Next state roll, still 75% chance to keep "up", companion walks up again
- → corridor ping-pong in the same area

Lamasuu's "sideways then face camera then idle then repeat" was the same bias playing out on the horizontal axis: walk right → hit right wall → bounce to "left" but 75% bias keeps "right" → sprite slides left facing right → eventually state rolls to idle (which sets direction=0=down=facing camera).

The v3.1.54 fix (feet-relative band, no direction override on bounce) was necessary but not sufficient. The 75% bias was the real pattern-generator.

## The fix
**The mobile state machine now matches the desktop's `src/js/pixel-arena.js` exactly** (lines 814-855). The desktop does NOT bias direction — every walk/run/zoomies roll picks a fresh random cardinal direction.

### State distribution
| State    | Old (v3.1.53) | New (v3.1.55) | Desktop |
|----------|---------------|---------------|---------|
| idle     | 60%           | 45%           | 45%     |
| walk     | 38%           | 30%           | 30%     |
| run      | (in zoomies)  | 15%           | 15%     |
| zoomies  | 2%            | 10%           | 10%     |

Total moving: 55% (was 40%). Matches the desktop's "feels alive" mix.

### Direction picking
- **Old**: 75% chance to keep last walk direction, 25% to reroll
- **New**: 100% fresh random on every state roll. No memory. No bias.

### Speeds
- **Old walk**: 0.020-0.032 (faster than desktop)
- **New walk**: 0.015-0.025 (matches desktop)
- **New run**: 0.06-0.10 (matches desktop)
- **New zoomies**: 0.08-0.13 (matches desktop)

### Durations
- **Old walk**: 3-6s (too long for small arena)
- **New walk**: 2-6s (matches desktop)
- **New run**: 1-3s (matches desktop)
- **New zoomies**: 0.6-1.4s (matches desktop)
- **New idle**: 3-8s (matches desktop)

## Plus: velocity-based facing in update()
The mobile was setting `c.direction` in `pickState()` and never updating it during the walk. The desktop does:

```js
// Desktop src/js/pixel-arena.js lines 866-878
if (amx > 0.002 || amy > 0.002) {
  if (amy > amx * 2.0) {
    comp.direction = comp.vy > 0 ? 0 : 1; // down : up
  } else {
    comp.direction = comp.vx < 0 ? 2 : 3; // left : right
  }
}
```

This re-derives the facing direction from the dominant velocity axis AFTER the bounce code has flipped velocity. Without this:
- Companion walks right (dir=3), hits right wall, bounce flips vx to negative
- Companion slides left along the wall, sprite still facing right → moonwalking

With this:
- Companion walks right (dir=3), hits right wall, bounce flips vx to negative
- Velocity-based facing detects vx<0, sets dir=2 (left)
- Sprite faces left, walks left → natural

**Threshold: prefer left/right.** Side sprites look better for diagonal movement. Vertical (up/down) is only used when vertical velocity is clearly dominant (>2x horizontal). This is why the run distribution in the sim shows 70-80% horizontal — which matches the desktop's "look right" feel.

## 60s simulation results (h=187, w=360)
**clawsuu (scale=2):**
- States: 55.5% idle, 33.3% walk, 11.1% run
- Moving direction distribution: 24.6% down, 32.4% up, 19.3% left, 23.7% right — well-balanced
- Run direction: 11.7% down, 12.0% up, 35.9% left, 40.4% right — horizontal-dominant (side sprites)
- Max consecutive same direction: 7.9s (one walk + bounce)

**lamasuu (scale=1):**
- States: 66.4% idle, 20.0% walk, 13.7% run
- Moving direction distribution: 20.2% down, 16.2% up, 32.9% left, 30.6% right — well-balanced
- Run direction: 10.1% down, 11.8% up, 36.9% left, 41.2% right — horizontal-dominant
- Max consecutive same direction: 7.0s

Both companions have similar direction distributions. No more "always up" or "always sideways" patterns.

## Files changed
- `android/app/src/main/assets/arena.html` — `pickState()` rewritten, velocity-based facing added to `update()`, removed horizontal bounce direction overrides
- `package.json` — 3.1.54 → 3.1.55
- `android/app/build.gradle` — versionCode 104 → 105, versionName "3.1.55"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.55
- `CHANGES_3.1.55.md` (new)

## On the "no patterns" requirement
Tobe: "Idling in all directions. No patterns."

The velocity-based facing also handles idle direction. When idle, the companion stops moving and `c.direction` stays at its last value (whatever it was facing when it stopped). So:
- If the companion was walking right and the state rolled to idle, it stops facing right
- If it was walking up, it stops facing up
- If it was facing down (the default direction=0 from pickState's idle), it stops facing down

So idle happens in all 4 directions, not just facing camera. Combined with the fresh-random direction on every walk roll, the result is the random-stroll behaviour Tobe wanted.

## Why this took 3 versions
v3.1.53 tuned the state distribution. v3.1.54 fixed the band math and removed bounce direction overrides. v3.1.55 removes the 75% direction bias (the actual pattern-generator) and adds velocity-based facing (the missing visual piece). The earlier fixes were necessary prerequisites — the bounce direction override in v3.1.53 was fighting the bias, and the band collapse in v3.1.53 was exaggerating the wall-bounce frequency — but neither addressed the core problem: the AI was remembering its last direction, which on a small arena means a corridor pattern every time.
