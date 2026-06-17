# 3.1.48 — Mobile Arena: Polish Pass (v3.1.47 feedback fixes)

## What it fixes
Four polish items from the v3.1.47 test:

1. **Companion tabs need minimal space.** Tobe was referring to the per-companion tab row (Clawsuu / Lamasuu / etc.), not the Chat/Events/Log tab row. The companion tabs were too padded.
2. **Voice/Wake buttons were missing "Mode" text.** They said "Voice" and "Wake" — should say "Voice Mode" and "Wake Mode".
3. **Companions only walking cardinal (side-to-side or up-and-down), and resetting to starting position.** They should walk diagonally too, and not teleport back to start.
4. **Remove the green debug text** in the top-left of the arena.

## The fixes

### 1. Companion tab spacing tightened
`HomeScreen.tsx` styles:
- `companionTabBar.maxHeight`: 64 → 36
- `companionTabBarContent.paddingVertical`: 6 → 3; `paddingHorizontal`: 8 → 6
- `companionTab.paddingVertical`: 6 → 3; `paddingHorizontal`: 12 → 8
- `companionTab.borderRadius`: 16 → 12
- `companionTab.marginRight`: 6 → 4
- `companionTabEmoji.fontSize`: 16 → 12; `marginRight`: 6 → 4
- `companionTabName.fontSize`: 12 → 11; `maxWidth`: 90 → 80

The Chat/Events/Log tab row was already at `paddingVertical: 4` from v3.1.46 — left as-is.

### 2. Voice/Wake button text
`arena.html`:
- Button text: `Voice` → `Voice Mode`; `Wake` → `Wake Mode`
- Button width: 54px → 80px so the longer text fits
- Font size: 10px → 9px; added `white-space: nowrap`

### 3. Movement: diagonal + no reset
`arena.html`:
- **Diagonal movement**: pickState's run state now uses `Math.random() * Math.PI * 2` for a random angle, matching the desktop's "excited zoomies" behavior. Walk is still cardinal (4 directions); run/zoomies can be any angle.
- **No reset**: `layout()` was resetting every companion's `c.x` and `c.y` on every resize event (Android WebView fires resize events for various reasons — keyboard, orientation, etc.). Now `layout()` only sets positions for NEW companions (those without a `c._positioned` flag). Existing companions keep their current position across resizes. Matches the desktop's behavior.

### 4. Debug overlay removed
`arena.html`:
- Removed `#debug` CSS block
- Removed `<div id="debug"></div>` from body
- Removed `debugEl` reference
- Removed `drawDebug()` function and its call from `render()`
- Removed `debugMode` flag

`Arena.getDebug()` is still exposed on `window.Arena` for ad-hoc inspection via `injectJavaScript` from RN.

## Files changed
- `android/app/src/main/assets/arena.html` — debug removed, diagonal movement, layout() preserves positions, Voice/Wake text
- `src/screens/HomeScreen.tsx` — companion tab spacing tightened
- `package.json` — 3.1.47 → 3.1.48
- `android/app/build.gradle` — versionCode 97 → 98, versionName "3.1.48"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.48
- `CHANGES_3.1.48.md` (new)

## What I deliberately did NOT change
- 4-directional state machine in walk (still cardinal, matching desktop)
- 1.85:1 canvas aspect / GROUND_FRACTION
- Scale handling (mobile = desktop / 2)
- The Chat/Events/Log tab row padding (already at 4 from v3.1.46)

## Lessons
**Read the user's feedback literally.** v3.1.47 I over-corrected by removing ALL emojis from tabs. v3.1.48 I'm carefully distinguishing: the "tabs" that needed tighter spacing are the **companion tabs**, not the Chat/Events/Log tabs. The two are visually similar but functionally different rows.

**layout() should preserve positions across resize.** Easy mistake to make — every other game loop just calls layout() unconditionally. The desktop's position-relative-to-state-machine model needs layout() to only position *new* entities. Used a `_positioned` flag on each companion to track this.