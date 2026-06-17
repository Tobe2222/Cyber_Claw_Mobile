# 3.1.44 — Mobile Arena: scale = desktop / 2

## What it fixes
Lamasuu was rendering bigger than clawsuu on mobile despite the user wanting it smaller. The mobile was using the desktop's scale value as-is, so `lamasuu.scale=3` rendered at 3 (96px sprite) and `clawsuu.scale` unset rendered at the mobile default 2 (64px sprite) — making lamasuu BIGGER.

## The fix
Tobe clarified: "the scale of the mobile should be the desktop size divided by 2." So the mobile now always halves whatever the desktop sends:

- Desktop default = 5 (no scale set on agent → desktop uses `_buildCompanion` default of 5)
- Mobile default = 5 / 2 = 2.5 → floor → 2

- Desktop explicit (e.g. lamasuu = 3) → Mobile = 3 / 2 = 1.5 → floor → 1
- Desktop explicit (e.g. clawsuu = 4) → Mobile = 4 / 2 = 2
- Result clamped to `Math.max(1, ...)` so it never goes below 1.

## Concrete results after this change
- **Clawsuu** (no scale on desktop → desktop uses 5): mobile renders at 2 (= 64px sprite)
- **Lamasuu** (desktop scale=3): mobile renders at 1 (= 32px sprite) — *smaller* than clawsuu, as Tobe intended
- Any future agent: if desktop scale is N, mobile is `floor(N/2)`, clamped to ≥ 1

## Files changed
- `android/app/src/main/assets/arena.html` — scale handling: `scale = Math.max(1, Math.floor(desktopScale / 2))`
- `package.json` — 3.1.43 → 3.1.44
- `android/app/build.gradle` — versionCode 93 → 94, versionName "3.1.44"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.44
- `CHANGES_3.1.44.md` (new)

## What I deliberately did NOT change
- State machine, animation handling, layout, GROUND_FRACTION, canvas size init — all from v3.1.43. They were working per the screenshot.
- React Native side — no API changes.

## Note for the user
If lamasuu is now TOO small at scale 1 (32px sprite), you can bump its desktop scale to 4 (which becomes 2 on mobile) or higher. The rule is consistent: whatever you set on the desktop, the mobile will show at half.