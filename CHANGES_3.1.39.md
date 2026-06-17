# 3.1.39 — Mobile Arena Positioning + Activity Tuning

## What it fixes
1. Companions stood with their feet against the very bottom of the arena viewport (and partially clipped on small phones) — the visible walking area didn't match the desktop's ground line.
2. Companions sat idle too long on first load (often 2–6s of stillness) before they started moving.

## Why it happened
- The mobile `arena.html` used `groundY = canvas.height * 0.7`, but the sprite is drawn from `c.y` *downward* — so the sprite's TOP-LEFT sat at 70% and its body extended off the bottom of the canvas. On a typical phone arena viewport (≈ 400px tall) the sprite feet landed at 280+128 = 408px, partially clipped.
- The desktop uses `height * (horizonLine + 0.1)` = 0.6 AND positions by the feet, so the body fits cleanly above the ground line.
- The mobile `pickState()` used the desktop's 60/30/10/0 distribution (idle/walk/run/zoomies) with idle stateTimer 2–6s. On a small arena with two companions the stillness is very obvious.

## The fixes (`arena.html`)
1. **Ground line:** new `GROUND_FRACTION = 0.6` constant (matches the desktop). `layout()` now positions each companion so the FEET land on the ground line: `c.y = groundLine - dh` (previously `c.y = groundLine`, which put the top-left on the line).
2. **Idle probability:** dropped from 45% to 30%.
3. **Idle duration:** `stateTimer = 1000 + random()*2000` (1–3s) instead of 2–6s.
4. **Walk probability:** bumped from 30% to 45%, run 10% → 20%, zoomies 0% → 5%.
5. **First-roll delay unchanged** (still 0.2–1.0s, derived per-id).

## Behaviour after the fix
- A companion starts moving within ~1s of loading.
- Most of the time both companions are walking or running rather than standing still.
- Feet of all sprites land on the visible ground area, matching the desktop.

## Files changed
- `android/app/src/main/assets/arena.html` — layout + pickState
- `package.json` — 3.1.38 → 3.1.39
- `android/app/build.gradle` — versionCode 88 → 89, versionName "3.1.39"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.39

## What I deliberately did NOT change
- `scale` handling. Mobile already reads `agent.scale` from the desktop's `agents_list` payload and uses it for sprite size. If lamasuu looks the same size as clawsuu on the mobile despite a smaller desktop setting, that's a desktop-side bug — `_pixelCompanionScale` isn't being persisted/applied to lamasuu specifically. Worth investigating on the desktop, not here.
- The mirror remains read-only: no click handlers, no toys, no treats, no speech bubbles (still excluded per v3.1.31 contract).
- Vertical movement still suppressed (companions stay on the ground line).

## Verification
- Layout math sanity-checked: on a 393×400 arena viewport, `groundLine = 240`, a scale-4 sprite (128px tall) has `c.y = 112` so feet land at 240. Sprite body fully visible above 240, with 160px of headroom above. Matches the desktop feel.
- `node --check` on the extracted `<script>` parses clean.
- State distribution: 30% idle / 45% walk / 20% run / 5% zoomies — combined with shorter idle (1–3s vs 2–6s), the expected "companion stationary at any given moment" rate drops from ~63% to ~40%.