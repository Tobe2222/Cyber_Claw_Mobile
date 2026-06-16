# v3.1.31 — proper pixel-arena port: multiple companions visible at once

## What changed

The mobile's `arena.html` was a 438-line single-sprite
canvas. It only knew about one companion at a time, read
from a `?companion=...` query param. To show Clawsuu and
Lamasuu in the same arena, we had to either (a) port the
desktop's multi-sprite `pixelArena.js` to the mobile, or
(b) render two side-by-side single-sprite canvases.

The user asked for (a). This version is the proper port.

## The port

### assets

Copied the entire `src/assets/companions/` tree from
`cyberclaw` to
`android/app/src/main/assets/companions/`. 260 KB of sprite
folders + `catalog.json`. 5 companions (Fox, Boar, Deer,
Hare, Black Grouse), each with 5-6 animation framesheets
(idle, walk, run, hurt, death; Boar has attack; Black
Grouse has flight).

The WebView reads these via
`file:///android_asset/companions/...` paths (Android
WebView serves the assets folder at the root).

### `arena.html` rewrite

Dropped the entire 438-line canvas. Wrote a clean rewrite
(also ~440 lines) that:

- **Loads the catalog** at boot via
  `fetch('companions/catalog.json')`.
- **Exposes a `window.Arena` API** with `setAgents(list)`
  and `setActive(id)` methods. The React Native side
  drives everything through this API.
- **Multi-companion layout.** Companions are spread evenly
  across the canvas width, all on the same horizontal row.
  Same Y for all (so the row reads as a group).
- **Per-companion idle animation.** Each companion plays
  its idle framesheet at 200ms/frame. Other animations
  (walk, run, etc.) are loaded but not used — the mobile
  arena is a read-only mirror, no state machine, no
  movement.
- **Active companion marker.** The active chat companion
  gets a golden pulsing ring underneath + a brighter name
  label. Inactive companions get a faint grey ring.
- **No toys, no treats, no bubbles, no click handlers,
  no drag, no focus effects.** Read-only mirror, per
  the user's instruction.
- **No "add/remove" — the React Native side rebuilds
  the WebView's companion list on every `agents_list`
  broadcast.** The WebView internally wipes and re-creates
  the companion array. Cheaper than diff-and-update at
  this scale (max 6).

### React Native side

`HomeScreen.tsx`:

- **WebView source URI no longer includes `?companion=...`.**
  It now reads `file:///android_asset/arena.html?platform=mobile`
  — the URI is stable for the lifetime of the component,
  so the WebView mounts once and stays mounted.
- **On every `agents_list` broadcast**, the React Native
  side calls `window.Arena.setAgents(slim)` with the full
  list. The WebView rebuilds its companion sprites.
  This handles the "companion added on desktop" case
  automatically (the next `agents_list` will include the
  new companion).
- **On every tab click**, the React Native side calls
  `window.Arena.setActive(id)`. The WebView updates the
  active marker. No state change in React, no WebView
  reload, no echo loop.

## What's removed

- The `?companion=...` query param. The WebView no longer
  needs it — the React Native side drives the active
  companion through `setActive()`.
- The `companionId` state in `HomeScreen.tsx` is still
  set by the desktop's `companion_id` echo, but it's no
  longer used to drive the WebView. The state is kept
  for the chat-side messages that reference it
  (`agentId` of incoming messages), and the AsyncStorage
  value `cyberclaw-arena-comp` now stores the **active
  agent id** instead of the sprite id (for next app
  start, to remember which tab to highlight).
- The legacy `setCompanion(id)` injection in the
  single-sprite arena — replaced by `setActive(id)` for
  the multi-companion one.

## Files

- `android/app/src/main/assets/arena.html` — rewritten
  (~440 lines) as a multi-companion renderer.
- `android/app/src/main/assets/companions/*` — sprite
  assets copied from `cyberclaw/src/assets/companions/`
  (Fox, Boar, Deer, Hare, Black_Grouse + catalog.json).
- `src/screens/HomeScreen.tsx`
  - `onAgentsList`: now calls `window.Arena.setAgents()`
    on every broadcast (replaces the per-companionId
    reload logic).
  - Tab click handler: now calls `window.Arena.setActive(id)`
    (replaces the `setCompanion(id)` injection).
  - WebView source URI: no longer includes `?companion=...`.
- `package.json` — bumped to 3.1.31
- `android/app/build.gradle` — versionCode 81, versionName
  3.1.31
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.31` and `CyberClaw-Android-3.1.31.apk`

## Verification

- Both files parse cleanly (TS via babel/parser, HTML JS
  via Function constructor).
- After the build, opening the mobile app and connecting
  to the desktop should show all companions from the
  desktop's `agents_list` (max 6) in the arena, evenly
  spread across the row.
- Tapping a companion tab highlights that companion
  (golden pulsing ring + brighter name) without reloading
  the arena.
- Adding a companion on the desktop (re-broadcasts
  `agents_list`) makes it appear in the mobile arena on
  the next sync.
- Resizing a companion on the desktop (resizes get
  reflected via the `scale` field in `agents_list`) makes
  the mobile sprite resize on the next sync.

## Out of scope (not in this PR)

- Multi-row layout when there are 4+ companions and the
  screen is narrow. The current layout puts all
  companions on a single row, which is fine on phones
  with 1-2 companions but cramped with 3+. A
  row-when-needed layout would be a follow-up.
- Animations beyond idle (walk, run, hurt, death). The
  sprite sheets are loaded (so the WebView has them) but
  only idle is played. A "click to pet" gesture could
  trigger walk in a follow-up.
- Background image. The desktop's pixel arena loads a
  forest/horizon background image; the mobile uses a
  procedural gradient + ground band instead. The sprite
  shadows still work.
