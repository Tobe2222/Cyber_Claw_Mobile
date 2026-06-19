# 3.1.69 — Companion tab icons: Twemoji SVG (smooth, consistent)

## What it adds
Tobe (on the desktop): "its still the wrong emojis, no matter their size. change the size back also." After v3.1.25 the chat tabs were technically rendering the Unicode emoji (`🐗`, `🐇`), but on Linux the system emoji font (Noto Color Emoji) renders these as low-resolution bitmaps that look pixelated at small chat-tab sizes. Tobe was seeing pixel-art boar/hare icons — which is actually the correct emoji glyph, just rendered badly by the system font.

The fix: bundle the Twemoji SVG files (vector, smooth at any size, consistent across platforms) and render those in the chat tabs. The 5 SVGs are tiny (~8KB total) and live at `assets/icons/{sprite}.svg` in the Android assets folder, mirroring the desktop.

## Changes
- **Android assets get the 5 Twemoji SVGs** at `android/app/src/main/assets/icons/{boar,hare,fox,deer,grouse}.svg`.
- **Mobile catalog gets `iconFile` field** pointing to the SVG path (e.g. `assets/icons/boar.svg`).
- **Chat tab renders `<Image source={{ uri: a.iconFile }}>`** when the iconFile is available. Falls back to text emoji (per-agent → sprite → no fallback) when iconFile is missing.
- **Agent type includes `iconFile?`** in both App.tsx and HomeScreen.tsx.

## Why Twemoji SVG beats Unicode emoji on Android too
Android ships with Noto Color Emoji which is bitmap-based and renders poorly at small sizes. Bundling Twemoji SVG means the mobile shows the same smooth boar/hare icons as the desktop, regardless of which Android version or OEM font setup.

## Files changed
- `android/app/src/main/assets/icons/{boar,hare,fox,deer,grouse}.svg` (new) — Twemoji SVGs
- `android/app/src/main/assets/companions/catalog.json` — added `iconFile` per sprite
- `App.tsx` — `agents` type includes `iconFile?`
- `src/screens/HomeScreen.tsx` — chat tab renders `<Image>` from iconFile, agent type includes `iconFile?`, added `companionTabIconImg` style
- `package.json` — 3.1.68 → 3.1.69
- `android/app/build.gradle` — versionCode 118 → 119, versionName "3.1.69"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.69
- `CHANGES_3.1.69.md` (new)

## Lesson: bundling assets beats relying on system fonts
For app-level icons (chat tabs, picker rows, anywhere you show an identifier), bundle the SVG/PNG and render it directly. The system emoji font is fine for typed text in chat messages because the user knows what they typed. For app UI, system fonts vary wildly across platforms. Bundling Twemoji (or any vector icon set) gives consistent, smooth, recognizable icons everywhere with no font dependency.
