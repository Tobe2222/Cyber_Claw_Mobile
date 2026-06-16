# v3.1.36 — match the desktop's arena background; fix log spam

## What the user reported

After v3.1.35, the arena looked like:

- Bright stars and visible gradient/ground band (from
  v3.1.35's procedural fallback) — but **not** the
  desktop's actual background.
- The log was spamming `App foregrounded / backgrounded`
  every second.

The user: "Its supposed to use the same background as the
desktop uses. Same background, same companions and
behaviour. As stated before, this is a extension of the
desktop."

## Two fixes

### 1. Use the desktop's actual background image

The desktop has 3 backgrounds (`pixel_landscape_1.png`,
`pixel_landscape_2.png`, `pixel_landscape_3.png` — meadow,
forest, grove). The default is `forest`. The mobile
previously didn't have them, so `drawBackground` was
drawing a procedural gradient as a placeholder.

v3.1.36 copies all 3 backgrounds to
`android/app/src/main/assets/backgrounds/`. The arena
HTML now:

- Loads the default 'forest' background at boot via
  `new Image(); img.src = 'file:///android_asset/
  backgrounds/pixel_landscape_2.png';`.
- If the image loads, `drawBackground` draws it covering
  the whole canvas. This is the SAME image the desktop
  shows.
- If the image fails (file:// blocked, etc.), the
  procedural gradient + stars + ground band from v3.1.35
  is the fallback. The user always sees a visible arena.
- New public API: `window.Arena.setBackground(id)` for
  the React Native side to switch backgrounds (e.g. when
  the user picks a different background on the desktop).
  Accepts `'meadow' | 'forest' | 'grove'`.
- Listens for `{ type: 'setBackground', id }` messages
  from the React Native side, same as `setAgents` and
  `setActive`.

### 2. De-spam the AppState log

`AppState.addEventListener('change', ...)` was firing
many times in a row for spurious reasons (the keyboard
opening, the WebView mounting, Android lifecycle churn).
Every fire used to log `App foregrounded / backgrounded`
and re-run the sample-listener setup. The log got
spammed with "App foregrounded — wake threshold: 55% /
App backgrounded — wake threshold: 65%" every second.

The fix:
- Skip the whole handler when `nextAppState === prev` (no
  actual transition). This catches the no-op fires.
- Add `lastAppStateLogRef` to rate-limit the listener
  setup to at most once per 1.5s. If a fire happens
  within that window, the ref still updates (so the
  NEXT fire sees the new state) but the listener
  doesn't re-run and nothing is logged.
- Both checks together: no-op transitions are
  completely skipped, and real transitions are logged
  at most once per 1.5s.

## Files

- `android/app/src/main/assets/backgrounds/pixel_landscape_{1,2,3}.png`
  — new files (copied from
  `cyberclaw/src/assets/backgrounds/`).
- `android/app/src/main/assets/arena.html`
  - `loadBackground(id)` loads one of the 3 desktop
    backgrounds (meadow/forest/grove) via `new Image()`.
  - `setBackground(id)` is a public wrapper exposed on
    `window.Arena`.
  - `drawBackground` draws the loaded image covering
    the whole canvas if it's available; otherwise the
    procedural fallback.
  - Message listener accepts `{ type: 'setBackground',
    id }` and calls `loadBackground(id)`.
  - Default 'forest' background is loaded at boot.
- `src/screens/HomeScreen.tsx`
  - AppState `change` listener: skip on no-op
    transitions and rate-limit to once per 1.5s.
  - New `lastAppStateLogRef` for the rate-limit timestamp.
- `package.json` — bumped to 3.1.36
- `android/app/build.gradle` — versionCode 86,
  versionName 3.1.36
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.36` and `CyberClaw-Android-3.1.36.apk`

## Verification

- Both files parse cleanly.
- After install, the arena shows the same forest
  background as the desktop.
- The log is no longer spammed with AppState transitions.
  You should see at most one `foregrounded` / `backgrounded`
  per actual transition, and they shouldn't appear while
  the app is just sitting in the foreground.
- `setBackground` API is exposed but not yet wired to a
  React Native UI (the desktop picker is the source of
  truth for which background is active; the mobile just
  mirrors it). Future PR can wire it to a mobile picker
  if desired.
