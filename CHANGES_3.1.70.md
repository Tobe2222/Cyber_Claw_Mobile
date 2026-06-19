# 3.1.70 — Mobile chat tabs use SVG data URI (works in React Native)

## What it fixes
Tobe: "Updated mobile and that still has the old robot icons." After installing v3.1.69 the mobile chat channel tabs at the bottom of the arena still showed robot icons, while the desktop (v3.1.28) was correctly showing Twemoji SVGs.

## Root cause: relative file paths don't resolve in React Native's Image
v3.1.69's mobile code did:
```js
<Image source={{ uri: a.iconFile }} />
```
where `a.iconFile = 'assets/icons/boar.svg'` (a relative path from the broadcast payload).

React Native's `Image` component doesn't resolve relative file paths from a runtime payload. It can load from:
- `require('./local.png')` (bundled at build time, not runtime)
- `uri: 'https://...'` (HTTP/HTTPS URLs)
- `uri: 'data:image/svg+xml;base64,...'` (data URIs)

A relative path like `'assets/icons/boar.svg'` is neither, so the Image fails to load and falls back to whatever the system renders next — usually the per-agent emoji text (which is `'🤖'` for the user's agents).

## Fix: bundle SVG content as base64 data URI in the broadcast
The desktop now sends `iconDataUri` alongside `iconFile` in the agents_list broadcast. `iconDataUri` is the SVG content encoded as a base64 data URI:

```
data:image/svg+xml;base64,PHN2ZyB4bWxucz0i...
```

React Native's `<Image source={{ uri: dataUri }}>` renders data URIs reliably. The SVG is <3KB so the base64 overhead is negligible.

The mobile prefers `iconDataUri` over `iconFile` (data URIs always work; file paths may not). Falls back to `iconFile` if `iconDataUri` is missing (for older desktop broadcasts). Falls back to text emoji (per-agent → sprite emoji) if both are missing.

## Files changed
- `App.tsx` — `agents` type includes `iconDataUri?`
- `src/screens/HomeScreen.tsx` — chat tab uses `(a.iconDataUri || a.iconFile)` as Image source
- `package.json` — 3.1.69 → 3.1.70
- `android/app/build.gradle` — versionCode 119 → 120, versionName "3.1.70"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.70
- `CHANGES_3.1.70.md` (new)

## Desktop counterpart: v3.1.29
The desktop now sends `iconDataUri` in BOTH broadcast sites (`broadcastAgentsListToMobile` and the `mobile-request-agents-list` IPC handler). Previously only the second one had `iconFile`; the first one (the initial broadcast after `initArenaCompanions`) didn't. v3.1.29 also adds `iconDataUri` to both.

## Lesson: data URIs are the portable image format
For runtime image content that crosses process boundaries (renderer → React Native, server → client, etc.), data URIs are the most reliable format:
- React Native Image: ✓
- HTML `<img>`: ✓
- CSS `background-image`: ✓
- Android WebView: ✓

Relative file paths require the recipient to know how to resolve them, which varies by environment. Bundle the bytes, encode as data URI, send. Trade-off: ~33% size overhead from base64, but for small icons (<5KB) that's negligible.

Same pattern: when sending data the consumer needs to render but might not have a filesystem context for, ship the data itself, not a path.
