# v3.1.34 — debug empty-arena + add draw fallback

## The bug

v3.1.33 loaded the catalog successfully (status shows
"ARENA READY", `arena_loaded` is in the log) but the
arena was empty — no companions rendered. The status
text is the only thing visible. The desktop's
`agents_list` is being received and React Native is
sending it to the WebView, but the WebView's `setAgents`
either isn't running, is throwing silently, or its
draw is bailing out (most likely the sprite image
loads are failing — Android WebView's file://
restriction is the same one that broke fetch()).

## The fix

Two coordinated changes to surface the bug and
guarantee visible output even when sprites fail to load:

### 1. Diagnostic logging in setAgents

The WebView's `setAgents` now:
- Emits `arena_set_agents_start` before building
  companions (so we can see the call was received).
- Wraps `Promise.all(list.map(buildCompanion))` in
  try/catch. On failure: shows the error in the status
  bar AND posts `arena_set_agents_failed` to the
  React Native log.
- Emits `arena_set_agents` AFTER building, with a
  per-companion `details` array showing `{id, name,
  hasIdle, hasShadow, scale}`. If `hasIdle` is false,
  the sprite for that companion failed to load — which
  is exactly the diagnostic we need to tell "sprite
  path is wrong" from "setAgents never ran".

React Native side: the `injectJavaScript` call for
setAgents now logs either `→ Injected setAgents to
WebView (N agents)` (success) or `✗ Failed to inject
setAgents: <error>` (failure). It also logs
`⏳ Skipped arena inject: webViewRef not ready` if
the WebView ref is null, so we can see if the inject
was just timing-racy.

### 2. Draw fallback for failed sprite loads

`drawCompanion` no longer silently returns when the
sprite image hasn't loaded. It now draws a colored
rectangle (orange for active, grey for inactive) with
the companion's initial in the center. This way, if
the sprite path is wrong (or the WebView blocks file://
images for some reason), the user sees SOMETHING in
the arena — not an empty void.

The next debug pass will tell us which case it is:
- If you see two orange/grey boxes with initials: the
  sprite path is the issue (look at the log for
  `hasIdle: false` in the details).
- If you see nothing: the inject is the issue
  (look for the `→ Injected setAgents` log line — if
  it's missing, the WebView ref wasn't ready and the
  inject was skipped).

## Files

- `android/app/src/main/assets/arena.html`
  - `setAgents` now logs start, per-companion details,
    and any build errors.
  - `drawCompanion` draws a colored rectangle with
    initial when the sprite fails to load, instead
    of returning silently.
- `src/screens/HomeScreen.tsx`
  - `injectJavaScript` for setAgents now logs success
    or failure.
  - New `⏳ Skipped arena inject: webViewRef not
    ready` log when the WebView ref is null, so we
    can see timing-racy injects.
- `package.json` — bumped to 3.1.34
- `android/app/build.gradle` — versionCode 84,
  versionName 3.1.34
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.34` and `CyberClaw-Android-3.1.34.apk`

## Verification

- JS syntax clean (`node --check`).
- After install, the Log tab will show `→ Injected
  setAgents` (if the inject ran) and the WebView's
  `arena_set_agents` response with per-companion
  details. If the sprite path is wrong, the
  `hasIdle: false` in the details will be the smoking
  gun.
- If the sprite path is fine, the arena shows
  Clawsuu and Lamasuu with their idle animation.
- If the sprite path is broken, the arena shows
  colored boxes with the companion initials instead
  of being empty.
