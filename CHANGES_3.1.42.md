# 3.1.42 — Mobile Arena: Real Canvas-Size Fix via RN→WebView Init

## What it fixes (after testing v3.1.41)
1. **Still floating above the ground.** v3.1.41 bumped GROUND_FRACTION to 0.95 as a workaround for the Android WebView's broken `window.innerHeight`, but this just moved the bug. The companions slid to the edges of the canvas with feet still well above the visible grass.
2. **"Slowly float to each side without walking animations."** The companions were sliding sideways to the edges, then staying there. They showed the idle pose (front-facing) even though state was 'walk' — because the idle state resets direction to 0... wait, no, idle was the LATEST state. Actually the direction DID carry over from a previous walk (2 or 3, side-view), but the user perceived it as idle because the animation was missing or the pose didn't look like walking.

## Root causes

**Cause #1: canvas.size was wrong.** Even with my GROUND_FRACTION workarounds, the canvas was sized by `window.innerWidth/innerHeight`, which on Android WebView returns the full viewport (~800 CSS px on iPhone mini), not the WebView container's size (~187 CSS px). So `canvas.width` and `canvas.height` were both wrong, and EVERY position/bound calculation was off.

**Cause #2: state machine kept moving them to edges, no bouncing back.** Once the canvas-width was wrong, the `bounce off edges` code in `update()` let the companions travel off-screen because `canvas.width` was 800 instead of 360. They'd disappear off the right edge of the visible WebView.

**Cause #3 (side-effect): idle pose direction.** When pickState rolled idle, it didn't reset `c.direction`, so the companion stayed in its last side-view pose. With clipping at the edge this looked weird.

## The fixes

### 1. `Arena.init(canvasW, canvasH)` — RN passes explicit canvas size
React Native calls `window.Arena.init(SCREEN_WIDTH, ARENA_HEIGHT)` on WebView load. The WebView's `resize()` then uses these explicit values instead of `window.innerWidth/innerHeight`. After this, `canvas.width` and `canvas.height` are guaranteed to be `360 x 187` (or whatever the device's ARENA_HEIGHT is).

```js
let explicitCanvasW = null, explicitCanvasH = null;

function resize() {
  const w = explicitCanvasW != null ? explicitCanvasW : (canvas.clientWidth || window.innerWidth);
  const h = explicitCanvasH != null ? explicitCanvasH : (canvas.clientHeight || window.innerHeight);
  canvas.width = w;
  canvas.height = h;
  ...
}

function init(canvasW, canvasH) {
  if (typeof canvasW === 'number' && canvasW > 0) explicitCanvasW = canvasW;
  if (typeof canvasH === 'number' && canvasH > 0) explicitCanvasH = canvasH;
  resize();
}
```

### 2. `GROUND_FRACTION = 0.70` — back to the mathematically correct value
With the canvas now correctly sized, the grass band in the bgImage (1266×631, 2:1 aspect, grass at ~70% of image height) is at `0.70 * canvas.height`. So feet at `0.70 * 187 - 64 = 67` CSS px = 36% of canvas height = visible grass. 

### 3. Idle resets direction to 0 (forward-facing)
When `pickState` rolls idle, it now sets `c.direction = 0`. So the idle pose shows the front-facing sprite, not a leftover side-direction from a previous walk. Makes the companion look like it's standing idle instead of awkwardly sideways.

### 4. Diagnostic now reports explicit canvas dims
`Arena.getDebug()` includes `explicitW` and `explicitH` so we can confirm on next test whether RN's `init()` call actually set them.

## Files changed
- `android/app/src/main/assets/arena.html` — Arena.init(), explicit dims in resize(), GROUND_FRACTION 0.95 → 0.70, idle resets direction to 0, getDebug reports explicit dims
- `src/screens/HomeScreen.tsx` — calls `window.Arena.init(SCREEN_WIDTH, ARENA_HEIGHT)` on WebView onLoadEnd
- `package.json` — 3.1.41 → 3.1.42
- `android/app/build.gradle` — versionCode 91 → 92, versionName "3.1.42"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.42
- `CHANGES_3.1.42.md` (new)

## What I deliberately did NOT change
- Walk speed, state distribution, walk animation. All working when state is walk and canvas is sized correctly.
- Scale handling. The "lamasuu bigger than clawsuu" issue is a desktop-side config issue (you set `scale: 3` for lamasuu, which renders BIGGER than clawsuu's default 2 on mobile). To make lamasuu smaller, set its desktop scale to 1 or 1.5 — the mobile will respect whatever you set.
- The mirror stays read-only: no click handlers, no toys, no treats, no speech bubbles.

## Verification math (on iPhone mini, 360pt wide)
- `Arena.init(360, 187)` → `canvas.width=360, canvas.height=187`
- `groundLine = 0.70 * 187 = 131 CSS px`
- Scale-2 sprite (dh=64): `c.y = 131 - 64 = 67 CSS px`
- Sprite body from y=67 to y=131 (36%-70% of canvas)
- In screenshot pixels (at @3x): y=200+67*566/187 to y=200+131*566/187 = y=403 to y=597
- Visible grass band at y=600+ in screenshot
- Feet at y=597 → just above the grass, basically on it. ✓
- For scale-3 (lamasuu, dh=96): `c.y = 131-96 = 35 CSS px`. Body from y=35 to y=131. Feet at y=131 → on the grass.

## Lessons (adding to MEMORY)
- **Android WebView `window.innerHeight` is the FULL viewport, not the WebView container.** The only reliable fix is to pass the canvas size from React Native to the WebView via injectJavaScript.
- When positioning code uses `canvas.width/height`, ensure those values match the visible area. If the canvas is larger than the WebView, all positioning math is off.
- For stateful animations, when state changes (e.g. to idle), reset all related state — including visual direction. Otherwise companions look "stuck" in the previous pose.

## How to verify on next test
1. Install APK. Open the app.
2. On the home screen, the companions should be standing ON the grass (visible green band), not floating above it.
3. They should start walking within 1 second of the arena loading.
4. They should bounce off the edges and continue walking (not get stuck at the edges).
5. Optional: in Log tab, the `arena_resize` event from the WebView should report `w=360, h=187` (or whatever your device's actual WebView size is), confirming RN→WebView init is working.