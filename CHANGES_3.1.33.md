# v3.1.33 — fix the embedded-catalog bug from v3.1.32; add runtime error display

## The bug

v3.1.32 inlined the catalog in arena.html but the JS was
broken — the embedded catalog body had a leading `{` that
combined with the const declaration's `{` to produce a
duplicate, which is a JS syntax error. The WebView
silently failed to execute the IIFE (no error visible to
the user), the status stayed on "Loading arena..." for
20+ seconds, and no companions ever rendered.

The original write of arena.html had the bug. The
`build_embedded_catalog.py` script then re-introduced it
on every run (because it wrote
`START_MARKER` + `"\n"` + `json.dumps(...)` which put a
second `{` on its own line right after the const).

`node --check` flagged the error, but I'd verified the
script as "idempotent" by running it twice and seeing the
same hash. The hash was the same because the file was
already broken the same way both times. The script was
faithfully writing a broken file.

## The fix

Two parts:

### 1. Strip the leading `{` (and trailing `}`) from the JSON body in the script

`tools/build_embedded_catalog.py` now strips the leading
`{` (and whitespace/newlines) from `json.dumps(catalog,
indent=2)` before splicing it into the const, since the
START_MARKER already includes the opening `{` (and
END_MARKER already includes the closing `};`). The
catalog body now sits between them as the inner contents
of the dict, not a duplicate object literal.

I also fixed the file in place so the next script run
produces a clean output.

### 2. Add a runtime error handler to arena.html

`window.addEventListener('error', ...)` and
`window.addEventListener('unhandledrejection', ...)` are
now set up before any other code runs. They catch any
uncaught error and:

- Display the error message in the status bar (so the
  user sees something useful instead of "Loading
  arena..." forever)
- Post a `arena_js_error` / `arena_promise_error`
  message back to React Native (so the Log tab shows
  the error too)

This way, if anything in the IIFE ever throws again
(including a syntax error in a future change), the user
gets a visible error in the arena's status bar and the
mobile's log, not a silent freeze.

## Files

- `android/app/src/main/assets/arena.html`
  - Fixed the duplicate `{` in the embedded catalog.
  - Added `window.addEventListener('error', ...)` and
    `unhandledrejection` listeners that report to
    `setStatus` and `notifyRN`.
- `tools/build_embedded_catalog.py`
  - Strip the leading `{` and trailing `}` from the
    JSON body before splicing into the const.
  - Now actually idempotent (running it twice produces
    the same file by hash, AND that file has valid JS).
- `package.json` — bumped to 3.1.33
- `android/app/build.gradle` — versionCode 83,
  versionName 3.1.33
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.33` and `CyberClaw-Android-3.1.33.apk`

## Verification

- `node --check` on the script content: clean.
- `build_embedded_catalog.py` is idempotent: same hash
  after running twice.
- The status text transitions through "Loading arena…"
  → "Arena ready" (success) as expected.
- The `arena_loaded` log message appears in the mobile
  Log tab when the catalog loads.
- If anything in the future throws, the user sees
  "JS error: <message>" in the status bar instead of
  silent failure.
