# 3.1.58 — Fix lamasuu size bug: apply same scale transform in both code paths

## What it fixes
Tobe: "Okey cool. Captured the moment. It turned big here. Which it should not."

The log showed:
```
[10:05:34 AM] 🔍 scale_update: lamasuu 1→3 (desktop sent: 3)
```

So lamasuu's mobile scale jumped from 1 to 3 when the desktop sent `scale: 3`. The mobile scale is supposed to be `max(1, floor(desktop_scale / 2))` — desktop 3 should map to mobile 1, not mobile 3.

## Root cause
The mobile's `setAgents()` has two code paths:
- **Build path** (different IDs or first call): uses `buildCompanion()` which applies `Math.max(1, Math.floor(desktopScale / 2))`
- **In-place update path** (same IDs): applied `a.scale` directly without the `/2` transform

So the same `a.scale = 3` would render as:
- First setAgents (build): mobile scale 1
- Second setAgents (in-place update): mobile scale 3 (raw, 3x bigger!)

That's the "lamasuu suddenly turned big" bug Tobe reported three times across v3.1.54, v3.1.55, and v3.1.57. The v3.1.56 / v3.1.57 diagnostic logging made it visible; v3.1.58 fixes it.

## Why it took multiple versions
The original v3.1.44 introduced the `/2` rule in `buildCompanion` with a comment explaining "mobile is small, halve the desktop scale". The in-place update path was added later (v3.1.51 for idempotency) but the comment wasn't carried over, so the `/2` rule wasn't applied. Nobody noticed until the WebView was reused across reconnects (which makes the in-place path the common one) and the user reported the size changing mid-session.

## The fix
In the in-place update path, apply the same `max(1, floor(desktopScale / 2))` transform as `buildCompanion`:

```js
const DESKTOP_DEFAULT_SCALE = 5;
const desktopToMobileScale = (desktopScale) => {
  const ds = (typeof desktopScale === 'number' && desktopScale >= 1 && desktopScale <= 8)
    ? desktopScale
    : DESKTOP_DEFAULT_SCALE;
  return Math.max(1, Math.floor(ds / 2));
};

// In the in-place update:
const newScale = desktopToMobileScale(a.scale);
c.scale = newScale;
```

Both code paths now produce the same mobile scale for the same desktop scale value:
- Desktop 3 → mobile 1 (both paths)
- Desktop 5 → mobile 2 (both paths)
- Desktop null/undefined → mobile 2 (default; both paths)
- Desktop 0/9+ → mobile 2 (default; both paths)

The in-place update path's clamping (re-clamp `c.x` / `c.y` to the new band) and diagnostic logging (the `arena_scale_update` event) are preserved. After v3.1.58, the `arena_scale_update` event will fire on the first setAgents call too (when the WebView rebuilds with the new scale), not just on later in-place updates. The log will show the transition as a "from→to" pair.

## Files changed
- `android/app/src/main/assets/arena.html` — `setAgents()` in-place update now applies `desktopToMobileScale(a.scale)` instead of `a.scale` directly
- `package.json` — 3.1.57 → 3.1.58
- `android/app/build.gradle` — versionCode 107 → 108, versionName "3.1.58"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.58
- `CHANGES_3.1.58.md` (new)

## Lesson: same input must produce same output in every code path
A function with a "transform X to Y" rule should apply that rule everywhere X is consumed, not just in the "main" code path. The build path's `Math.floor(desktopScale / 2)` was the rule; the in-place path's raw `a.scale` violated it. The visual symptom (lamasuu suddenly 3x bigger) was downstream of a logic-level inconsistency.

The diagnostic events from v3.1.56 / v3.1.57 were essential to finding this — without the log showing `scale_update: lamasuu 1→3 (desktop sent: 3)`, I'd have kept guessing at the trigger.
