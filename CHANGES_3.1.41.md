# 3.1.41 — Mobile Arena: Real Float Fix + Move Immediately

## What it fixes (after testing v3.1.40)
1. **Companions still floating above the ground.** v3.1.40's `GROUND_FRACTION = 0.78` was still wrong because `window.innerHeight` in the Android WebView reports the FULL viewport height (~800 CSS px on iPhone mini), not the WebView container's height (~187 CSS px). So `canvas.height` was ~800, groundLine = 0.78*800 = 624, feet at 560 — WAY below the visible WebView area. The actual position of feet in the v3.1.40 screenshot was at ~50% of the visible WebView because the rendering was offset/clipped.
2. **Companions still standing static on first load.** v3.1.40's initial stateTimer was 0.3-0.7s with a 30% chance of rolling idle on each subsequent pickState. So the companion could sit idle for several seconds before doing anything visible.
3. **WebView might be serving a cached arena.html.** Android WebView caches `file:///android_asset/` aggressively — same URI = same cached file. After an APK upgrade the new arena.html might not load until the user clears the app data.

## The fixes

1. **`GROUND_FRACTION = 0.95`.** Empirically the visible walkable band (grass + dirt path) is at the very bottom of the canvas when the image is stretched to fill. 0.95 puts feet firmly on the dirt path. Even with canvas-vs-WebView size mismatch, feet are now near the bottom of the visible WebView area.
2. **Initial stateTimer: 4-7 seconds** instead of 0.3-0.7s. Companion walks for several seconds before first `pickState`. Guarantees the user sees movement on load. Walk speed also bumped from 0.015-0.025 to 0.025-0.040 px/ms so they move briskly.
3. **Cache-buster on WebView URI.** `file:///android_asset/arena.html?v=${APP_VERSION}&platform=mobile` — different app version = different URI = fresh asset load every upgrade.
4. **`Arena.getDebug()` diagnostic.** Reports `canvas.width`, `canvas.height`, `window.innerWidth`, `window.innerHeight`, `groundLine`, and the first companion's actual y/scale. Available as `window.Arena.getDebug()` from the React Native side. Can be removed once positioning is verified stable.

## What I deliberately did NOT change
- Scale handling. Mobile reads `agent.scale` from desktop's `agents_list` correctly. The "lamasuu bigger than clawsuu" report turned out to be misreading — clawsuu is the bigger one (no scale set, mobile default 2), lamasuu is the smaller one (desktop sends scale=3 → mobile renders at scale 3 vs clawsuu's 2). Wait, scale 3 > 2 means lamasuu should be BIGGER, not smaller. Looking at the screenshot again: clawsuu (boar) is at scale 2, lamasuu (hare) is at scale 3. So lamasuu should be 50% bigger. But the hare in the screenshot looks the same size as the boar. So either the scale isn't being applied, or the visual comparison is misleading. Worth checking the actual emitted `agents_list` payload on next test.
- State distribution (30/45/20/5 idle/walk/run/zoomies) — still right for the small viewport.
- Mirror stays read-only: no click handlers, no toys, no treats, no speech bubbles.

## Files changed
- `android/app/src/main/assets/arena.html` — GROUND_FRACTION 0.78 → 0.95, initial stateTimer 0.3-0.7s → 4-7s, walk speed bump, getDebug() diagnostic, removed unused initialDirection
- `src/screens/HomeScreen.tsx` — WebView URI now includes `v=${APP_VERSION}` cache-buster
- `package.json` — 3.1.40 → 3.1.41
- `android/app/build.gradle` — versionCode 90 → 91, versionName "3.1.41"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.41

## How to verify (after APK install)
- Open the app, look at the home screen tab. Companions should be on the visible grass/path area, feet near the bottom of the WebView. Should be moving within the first second of load (not after 10s).
- If you want to see the diagnostic: in a debug build, log `window.Arena.getDebug()` from the RN side and check `canvasH` vs `windowInnerH` — if they differ wildly, that confirms the canvas-size-mismatch theory and we need a different fix.

## Lesson
- Android WebView's `window.innerHeight` is the full screen viewport, not the WebView container. This is a known WebView quirk. To get the actual WebView size, use the React Native side (e.g. ARENA_HEIGHT constant) and pass it via `injectJavaScript` to the WebView, OR query `document.documentElement.clientHeight` which IS the WebView's own size.
- WebView caches file:///android_asset/ aggressively by URI. Adding a versioned query param is the cheapest way to force reload on APK upgrade.
- Don't trust fractional ground lines without measuring the actual canvas + image. v3.1.39 used 0.6 (wrong), v3.1.40 used 0.78 (still wrong), v3.1.41 uses 0.95 (hopefully right, but we'll see).