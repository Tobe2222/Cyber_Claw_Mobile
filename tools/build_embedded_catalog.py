#!/usr/bin/env python3
"""
build_embedded_catalog.py — regenerate the EMBEDDED_CATALOG const
inside android/app/src/main/assets/arena.html from the JSON catalog
in android/app/src/main/assets/companions/catalog.json.

Run from the project root after editing the catalog:
    python3 tools/build_embedded_catalog.py

What it does:
  1. Reads android/app/src/main/assets/companions/catalog.json
  2. Splits arena.html into head + body-with-script
  3. Replaces the EMBEDDED_CATALOG const with the new JSON
  4. Writes the file back

Why we need this: Android WebView's fetch() refuses to load
file:// URLs from a non-secure origin (the page's origin is
"null" for file:// in many cases). The catalog has to be
inlined as a JS const, not fetched at runtime. To keep
catalog.json as the source of truth (and diffable in PRs),
this script copies the JSON content into arena.html.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = ROOT / "android" / "app" / "src" / "main" / "assets" / "companions" / "catalog.json"
ARENA_PATH = ROOT / "android" / "app" / "src" / "main" / "assets" / "arena.html"

# Pattern matches from `const EMBEDDED_CATALOG = {` up to the matching `};`
# In our well-formed arena.html the const is followed by a blank line
# and then `function loadCatalog() {`, so we can use a simple marker.
START_MARKER = "const EMBEDDED_CATALOG = {"
END_MARKER = "};"


def main():
    if not CATALOG_PATH.exists():
        print(f"error: {CATALOG_PATH} not found", file=sys.stderr)
        return 1
    if not ARENA_PATH.exists():
        print(f"error: {ARENA_PATH} not found", file=sys.stderr)
        return 1

    with CATALOG_PATH.open() as f:
        catalog = json.load(f)

    with ARENA_PATH.open() as f:
        html = f.read()

    start = html.find(START_MARKER)
    if start < 0:
        print(f"error: EMBEDDED_CATALOG const not found in {ARENA_PATH}", file=sys.stderr)
        return 1
    end = html.find(END_MARKER, start)
    if end < 0:
        print(f"error: EMBEDDED_CATALOG closing marker not found", file=sys.stderr)
        return 1
    end += len(END_MARKER)

    # Format the JSON with 2-space indent (matches the existing
    # hand-written style in arena.html).
    # START_MARKER already includes the opening `{` after `=`, so
    # we just append a newline + JSON body + closing `};`.
    new_const = START_MARKER + "\n" + json.dumps(catalog, indent=2) + "\n" + END_MARKER
    new_html = html[:start] + new_const + html[end:]

    with ARENA_PATH.open("w") as f:
        f.write(new_html)

    n_companions = len(catalog.get("companions", []))
    print(f"updated {ARENA_PATH.relative_to(ROOT)}: {n_companions} companion(s) inlined")
    return 0


if __name__ == "__main__":
    sys.exit(main())
