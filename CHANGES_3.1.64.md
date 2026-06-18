# 3.1.64 — Voice mode: filter companions properly + restore on exit + correct canvas size

## What it fixes
Tobe: "this happens when i test voice mode now. A bit of everything. It says js error in the arena when exiting."

Three issues from the screenshots:
1. **Voice mode shows BOTH companions** in centered mode (not just the active one)
2. **JS error in the WebView** when exiting voice mode
3. **Companion is gigantic** — fills the entire screen vertically in voice mode (the boar in screenshot 1)

## Bug 1: Both companions shown in centered mode

### Cause
`setCentered(true)` in arena.html had this check:

```js
if (enabled && activeId) {
  // Filter to just the active companion
  const active = companions.find(c => c.id === activeId);
  if (active) {
    companions = [active];
    // ...
  }
}
// Then later: c = companions[0]; /* center the first one */
```

When `activeId` was null (the home screen's WebView doesn't get `setActive` on the initial agents_list — only on tab tap), the `if (enabled && activeId)` check failed silently, and the filtering was skipped. The rest of the function still ran on `companions[0]` (the first one), centering it. But the OTHER companions were still in the array, drawn at their layout positions. Result: big centered first companion + smaller unfiltered others.

### Fix
Always filter when `enabled` is true, regardless of whether `activeId` is set:

```js
if (enabled) {
  // v3.1.64: ALWAYS filter, not just when activeId is set.
  let target = null;
  if (activeId) {
    target = companions.find(c => c.id === activeId);
  }
  if (!target && companions.length > 0) {
    target = companions[0];
  }
  if (target) {
    target.isActive = true;
    companions = [target];
  }
}
```

Now voice mode always shows exactly one companion (the active one if known, otherwise the first).

## Bug 2: JS error when exiting voice mode

### Cause
When `setCentered(false)` was called, it tried to restore the layout by calling `layout()`. But the companions array had been filtered to 1 element (the one that was centered). `layout()` would position that one element in the canvas — not the original 2. Going from "1 centered companion" to "1 companion in default position" without restoring the original array caused an inconsistent state. Plus, the unfiltered companions had `_positioned = false` from the original layout, but they were removed from the array.

### Fix
Save the original companions array when entering centered mode. Restore it on exit:

```js
let savedCompanions = null;

function setCentered(enabled) {
  if (enabled) {
    if (!savedCompanions && companions.length > 1) {
      savedCompanions = companions.slice();  // snapshot
    }
    // ... filter to one
  } else if (savedCompanions) {
    companions = savedCompanions;  // restore
    savedCompanions = null;
    for (const c of companions) {
      c._centered = false;
      c._positioned = false;  // re-trigger layout
    }
  }
}
```

The `companions.slice()` makes a shallow copy — the actual companion objects are referenced by both arrays, so the centered changes (scale, position) propagate. When we restore, we just reset the position flags and let `layout()` reposition them in the smaller canvas.

## Bug 3: Companion is gigantic

### Cause
The arena's canvas is initialized via `Arena.init(SCREEN_WIDTH, ARENA_HEIGHT)` (360x187 in the home screen's onLoadEnd). The canvas is 360x187 INTERNAL pixels, but the CSS `width:100%; height:100%` makes it display at the WebView's full size (360x780+ on a tall phone).

The companion at scale 10 = 320px is 320px on a 187px-tall canvas — already overflows. When the canvas is stretched 4x vertically to fill the WebView, the companion becomes 1280px tall on screen. That's the "fills the entire screen vertically" boar in screenshot 1.

The wake mode had the same problem but less obvious because the WakeModeScreen's WebView is the same size and the boar at 320px looks similar.

### Fix
Re-init the canvas with the FULLSCREEN dimensions when entering voice mode, and restore the small dimensions when exiting:

```ts
useEffect(() => {
  if (fullscreen) {
    const { width: SW, height: SH } = require('react-native').Dimensions.get('window');
    webViewRef.current?.injectJavaScript(
      `window.Arena && window.Arena.init(${SW}, ${SH}) && window.Arena.setCentered(true); true;`,
    );
  } else {
    webViewRef.current?.injectJavaScript(
      `window.Arena && window.Arena.setCentered(false) && window.Arena.init(${SCREEN_WIDTH}, ${ARENA_HEIGHT}); true;`,
    );
  }
}, [fullscreen]);
```

Now in voice mode, the canvas is the full screen size (360x780). The companion at scale 10 = 320px is 320px on a 780px-tall canvas, displayed at 320px on screen. Visually about the same size as before but without the stretching.

Also applied the same fix to WakeModeScreen's WebView onLoadEnd — the wake mode WebView now re-inits to the full screen size on load.

## Files changed
- `android/app/src/main/assets/arena.html` — `setCentered` always filters when enabled; saves/restores original companions array; handles null activeId case
- `src/screens/HomeScreen.tsx` — re-init canvas to fullscreen dimensions in the `useEffect([fullscreen])` when entering voice mode, restore small dimensions when exiting
- `src/screens/WakeModeScreen.tsx` — added `onLoadEnd` that inits the canvas to full screen dimensions
- `package.json` — 3.1.63 → 3.1.64
- `android/app/build.gradle` — versionCode 113 → 114, versionName "3.1.64"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.64
- `CHANGES_3.1.64.md` (new)

## Lesson: silent fallthroughs hide bugs
The `if (enabled && activeId)` check in v3.1.62 was a "guard" that failed silently. When the guard failed, the rest of the function still ran, producing a partial result (1 centered + N unfiltered). No error, no warning, just wrong behavior. The right pattern is either:
- An explicit "else" branch that handles the failure case (e.g., default to first companion)
- A throw / console.error so the failure is visible
- A test that catches the silent fallthrough

The user's screenshot was the test — it caught what the code's tests didn't.

## Lesson: arrays that mutate need a save point
When you mutate an array (filtering to a subset), and the user might want to undo that mutation, save the original first. `companions.slice()` is cheap (it's a shallow copy of references) and gives you an undo button. The alternative — trying to recreate the original state from the partial state — is much harder.
