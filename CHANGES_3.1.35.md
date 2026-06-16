# v3.1.35 — make the arena look like the desktop: visible background, twinkle stars, per-companion bob

## What the user reported

After v3.1.33, the arena did show the boar + hare sprites
and their name labels, but:

- **No background** — no sky, no ground, no horizon line.
  Just the bare sprites on the dark blue body colour.
- **No shadows** under the companions.
- **No active ring** around the active companion.
- **Sprites didn't move** — the idle pose has 4 nearly-
  identical frames so even when the frame counter
  advances, the visual change is imperceptible.

User: "But it should be much faster and look like the
desktop ofcourse."

## What's actually missing

The render pipeline calls `drawBackground()` every
frame, so the background IS being drawn — but the
colours (`#0a0a2e` → `#1a1a4a` → `#0a1a1a`) are all
very dark blues that look indistinguishable from black
on a phone screen. And the sprites' idle animation
only has subtle pose variations between frames.

## The fix

Three coordinated changes to arena.html:

### 1. Visible background

- Brighter sky gradient (`#1a1a4a` → `#2a2a5a` → `#3a2a3a`)
  so the sky is actually visible against the body.
- Brighter ground band (`#2a3a1a` → `#0a1a0a`).
- Bright orange horizon line (1 px, the same `#f7931a`
  used throughout the app's UI).
- 40 twinkling stars in the sky region. Each star has
  a deterministic position (seeded LCG) so it doesn't
  flicker on resize, and a per-star twinkle period
  (0.0005..0.0025 per ms) for visual interest.
- 20 grass patches near the ground for texture.

### 2. Per-companion bob

Each companion now has a 2-px vertical sine-wave bob
on its idle pose. The bob period is per-companion
(0.85x..1.15x of a base period) and seeded by a hash
of the companion id, so the two companions don't bob
in sync. The shadow stays on the ground (no bob) so
the companion appears to "bounce" above the shadow
rather than carry it.

The bob is the dominant visual cue for "the animation
is alive" — the sprite frame differences are nearly
imperceptible, but a 2-px bob is obvious. If you
squint at the desktop's pixel arena, the same trick is
what makes the boar/hare look "breathing" — the sprite
sheet idle animation does very little; the movement is
what sells it.

### 3. Faster frame rate

`frameSpeed` went from 200ms to 120ms. At 200ms/frame
the idle animation is 5 fps which is choppy. At
120ms/frame it's ~8 fps which still isn't a buttery
60fps but is much closer to the "alive" feel.

## Files

- `android/app/src/main/assets/arena.html`
  - Brighter, more visible background with twinkling
    stars and grass patches.
  - `bobFor(c)` helper for the per-companion vertical
    bob.
  - `drawShadow`, `drawRing`, `drawCompanion`, `drawName`
    all use `c._drawY` (set in `render` as `c.y + bob`)
    for the visual position. Shadow doesn't bob — it
    stays on the ground.
  - `frameSpeed` 200 → 120.
  - `STARS` constant (40 stars, deterministic position
    + per-star twinkle speed).
- `package.json` — bumped to 3.1.35
- `android/app/build.gradle` — versionCode 85,
  versionName 3.1.35
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.35` and `CyberClaw-Android-3.1.35.apk`

## Verification

- JS syntax clean (`node --check`).
- After install, the arena should show:
  - Visible sky gradient (dark blue at top, warmer at
    horizon).
  - Twinkling stars in the sky.
  - Bright orange horizon line.
  - Green ground band with subtle grass patches.
  - Both companions drawn with their idle sprite
    (boar + hare).
  - Shadows under each companion (slight grey ellipse).
  - Names above each companion.
  - Active ring (gold, pulsing) under the active one.
  - Both companions bobbing up and down ~2px at
    different rates (Clawsuu faster, Lamasuu slower,
    for example).
