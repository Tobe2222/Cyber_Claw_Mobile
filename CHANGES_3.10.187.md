# v3.10.187 — Looks editor: live sprite preview + dropdown sprite picker

Tobe (2026-09-04 18:36, Discord #cyber-dev, screenshot):
"@Clawsuu Okey it looks better now. I would like the looks to be
editable on this page. So the user can see the changes in the
window at the top there. So if he changes the sprite he view it
there, aswell as its size/scale. Make the sprite a drop down. And
the scale the same bar as before. From 1 to filling the whole view
screen in the top there."

## Context

The v3.10.186 split put the Looks editor on its own screen, but
the editor only had inputs (sprite picker + scale slider). The
preview that the parent CompanionSettingsScreen showed was NOT
mirrored in the editor — the user had to back out and look at the
parent card to see how their changes looked. Tobe wanted the
preview to live INSIDE the editor at the top, with the picker and
slider driving it live as he drags them.

The sprite picker was also a grid of 5 emoji cards. Tobe wanted
it as a dropdown ("Make the sprite a drop down"), matching the
desktop Companion Forge's preset dropdown pattern.

## Fix

### 1. Live preview at the top of the Looks editor

The Looks editor now has a 240×240 WebView at the top of the
scroll, before the Name input. The WebView loads `arena.html`
with `centered=true&centeredScale=5` (same URL as the parent
CompanionSettingsScreen uses for its preview). The WebView is
read-only (`pointerEvents="none"` + `scrollEnabled={false}`) —
the user controls sprite + scale via the inputs below, the
preview is informational.

Three useEffects drive the preview live:

- **On scale change**: injects
  `window.Arena.setCenteredScale(N)` where N = scale × 1.6.
  arena.html's `setCenteredScale` (new API in this release)
  mutates the companion's c.scale + c.x/c.y so the canvas
  re-paints at the new size on the next frame. No WebView
  reload, no JS bridge chatter.
- **On sprite change**: injects
  `setActive(id) + setAgents(slim) + setCentered(true) +
  setCenteredScale(N)`. The sprite catalog is bundled with
  the mobile app (5 sprites), so the new sprite's PNG atlas
  is already available — arena.html just swaps the data
  source.
- **On preview ready (arena_loaded fired)**: pushes the
  initial companion to the preview. Handles the case where
  the WebView remounts but the user hasn't touched anything.

The preview shows a "Loading {name}…" overlay until arena.html
fires `arena_loaded`, then hides it (the canvas-drawn name
takes over).

### 2. Sprite picker → native dropdown

The grid of 5 emoji cards (introduced in v3.10.93) is replaced
with a native Picker from `@react-native-picker/picker`. The
dropdown shows the catalog emoji + name for each option:

```
[ 🦊  Fox                  ▼ ]
[ 🐗  Boar                 ▼ ]
[ 🦌  Deer                 ▼ ]
...
```

The dropdown matches the desktop's preset dropdown pattern and
is the obvious "pick one of N options" control for a 5-entry
catalog.

### 3. arena.html: new `setCenteredScale` API

arena.html's `CENTERED_SCALE` was a `const` set once from URL
params. Changed to `let` and exposed a new function
`setCenteredScale(value)` on `window.Arena`:

```js
function setCenteredScale(value) {
  const v = parseFloat(value);
  if (!Number.isFinite(v) || v <= 0) return;
  CENTERED_SCALE = Math.max(1, Math.min(20, v));
  if (!CENTERED_MODE) return;
  for (const c of companions) {
    const [fw, fh] = c.data.frameSize;
    const dw = fw * CENTERED_SCALE;
    const dh = fh * CENTERED_SCALE;
    c.scale = CENTERED_SCALE;
    c.x = (canvas.width - dw) / 2;
    c.y = (canvas.height - dh) / 2;
    c.vx = 0; c.vy = 0;
  }
}
```

`window.Arena.setCenteredScale` is exposed via the existing
`window.Arena` namespace. Mobile calls inject this via
`previewWebViewRef.current.injectJavaScript(...)`. The scale
clamp (1–20) matches the URL-param validation range.

### 4. Scale slider range

The scale slider on the mobile was previously 1–8. Same range
in this release — the upper bound maps to arena scale 12.8
(8 × 1.6), which already overflows the 240×200 preview box.
Tobe's "fill the whole view screen" upper bound is achieved
at scale 7–8; pushing higher would push the sprite off-screen
in the preview.

## Files changed

- `src/screens/CompanionEditScreen.tsx` — added
  `WebView` + `Picker` imports, `LOOKS_ARENA_HTML_VERSION`
  constant, `previewWebViewRef` ref + `previewReady` state,
  three live-preview useEffects (scale / sprite / ready),
  new render block for the Looks mode (preview + Name +
  Picker dropdown + Scale slider), removed the old
  sprite-picker grid + the inline `🎨 LOOKS` group label
  (no longer needed since the page is one focused mode),
  added new styles (`looksPreviewWrap`, `looksPreview`,
  `looksPreviewHint`, `looksPreviewHintText`, `pickerWrap`,
  `picker`, `pickerItem`), removed unused styles
  (`spriteGrid`, `spriteCard`, `spriteCardActive`,
  `spriteIcon`, `spriteLabel`, `spriteLabelActive`).
- `android/app/src/main/assets/arena.html` — changed
  `CENTERED_SCALE` from `const` IIFE to `let` initializer,
  added `setCenteredScale(value)` function, exposed it via
  `window.Arena.setCenteredScale`. The function mirrors the
  position-recompute logic from `setCentered(true)` so the
  companion stays camera-locked at the new size.
- `package.json` (3.10.186 → 3.10.187), `android/app/build.gradle`
  `versionName` and `versionCode` (393 → 394).

## Verification

- TypeScript: `tsc --noEmit` produces zero new errors in the
  touched files. The 36 pre-existing errors are unrelated
  (mostly in trainer components, none in CompanionEditScreen
  or CompanionSettingsScreen).
- arena.html syntax: the existing `requestAnimationFrame(loop)`
  + IIFE setup is untouched; the new function follows the
  same shape as the existing `setCentered`.
- Manual flow: open Looks editor → preview shows the current
  sprite at the current scale. Drag scale slider → preview
  sprite grows/shrinks live. Tap dropdown → preview swaps to
  the new sprite within ~100ms.

## General lesson

When the user wants to see a live preview, the cost of
shipping a real canvas-based preview (vs. an emoji + scale
fudge) is one WebView + one IPC channel. The previous
emoji-based preview was cheaper but felt dead — a static
emoji that doesn't animate can't convey "this is your
companion" the way a live pixel sprite can. The 240px box
on the mobile is the same canvas the parent
CompanionSettingsScreen uses, so the two previews feel
identical to the user.

The `setCenteredScale` API addition is the smallest possible
extension of arena.html's existing centered-mode machinery.
When extending a canvas renderer, prefer to add a focused
setter over re-architecting the existing positioning code.
arena.html's `setCentered(true)` was already doing the
"recompute x/y for centered sprite" math; the new
`setCenteredScale` just factors that math out so it can be
called without entering centered mode.
