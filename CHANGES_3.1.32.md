# v3.1.32 — fix "Failed to load sprite catalog" and rename "sprite" to "companion"

## What was wrong

The user reported two things on v3.1.31:

1. **"Failed to load sprite catalog: FAILED TO FETCH"** in
   the arena. The catalog never loaded.
2. **"Why are they called sprites? They should be called
   companions."** — "sprite" is a developer/legacy term
   inherited from the desktop's pixel-arena.js. The user
   never sees a "sprite" anywhere else in the app.

## The fix

### 1. Catalog is now embedded, not fetched

v3.1.31 tried to load the catalog with
`fetch('companions/catalog.json')`. **Android WebView's
`fetch()` refuses to load `file://` URLs from a non-secure
origin** — a known restriction. The fetch fails with
"FAILED TO FETCH" and the WebView never sees the catalog.

Image loading via `new Image(); img.src = 'file:///...'`
is allowed (only fetch() / XHR is restricted), so the
sprite images were always going to work. It's just the
catalog that needed a different path.

v3.1.32 inlines the catalog as a JS const in arena.html.
The catalog is small (~5 KB), changes rarely (only when
a new companion is added), and the cost of regenerating
on build is negligible.

To regenerate after editing the catalog:
```
python3 tools/build_embedded_catalog.py
```

The script reads `assets/companions/catalog.json` and
rewrites the `EMBEDDED_CATALOG` const in `arena.html` in
place. It's idempotent — running it twice produces the
same output. The script is committed at
`tools/build_embedded_catalog.py`.

### 2. "sprite" → "companion" in user-visible text

All user-facing status messages now say "companion":

- "Failed to load sprite catalog" → "Failed to load
  companion catalog"
- "Arena ready" (unchanged — already correct)

Internal code (variable names, comment text, the
EMBEDDED_CATALOG const field names) still uses "sprite"
because that's the pixel-arena convention inherited
from the desktop (each companion is rendered from a
pixel-art framesheet). The user never sees "sprite"
anywhere now.

## Files

- `android/app/src/main/assets/arena.html`
  - Catalog inlined as `EMBEDDED_CATALOG` const (5
    companions: Fox, Boar, Deer, Hare, Black Grouse).
  - `loadCatalog()` no longer async — just assigns the
    embedded const and validates it.
  - User-facing error messages now say "companion"
    instead of "sprite".
  - Image loading path updated to
    `file:///android_asset/companions/...` (works in
    WebView's `new Image()` even though fetch() doesn't).
- `tools/build_embedded_catalog.py` — new. Regenerates
  the EMBEDDED_CATALOG const from the JSON catalog.
- `package.json` — bumped to 3.1.32
- `android/app/build.gradle` — versionCode 82,
  versionName 3.1.32
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.32` and `CyberClaw-Android-3.1.32.apk`

## Verification

- arena.html JS parses cleanly (verified with `new
  Function`).
- `build_embedded_catalog.py` is idempotent (running
  twice produces the same file, by hash).
- After install, opening the app should show the
  embedded catalog loaded successfully (no "Failed to
  load" status), and the arena should render Clawsuu
  and Lamasuu (or whatever companions the desktop has).
