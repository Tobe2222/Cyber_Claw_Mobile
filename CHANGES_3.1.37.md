# v3.1.37 — fix the silent onLoadEnd / useEffect inject, so companions appear at boot

## What was wrong

After v3.1.36, the forest background loaded but the
companions didn't appear in the arena until up to 30
seconds after app open. And when the user changed a
companion's size in the desktop's forge, the mobile
didn't reflect the new size until the next 60s periodic
sync.

## Root cause

The mobile had THREE code paths that tried to push the
agents list to the WebView:

1. `onAgentsList` (v3.1.31) — calls
   `window.Arena.setAgents(slim)` directly. ✅ Worked.
2. `useEffect([agents])` (v3.1.15) — used
   `window.dispatchEvent(new MessageEvent('message',
   { data: '{"type":"agentsList","agents":[...]}' }))`.
   ❌ The WebView's message listener only handles
   `setAgents`, `setActive`, `setBackground`. The
   `agentsList` type was silently dropped.
3. `onLoadEnd` (v3.1.15) — same dispatchEvent pattern
   with `type: 'agentsList'`. Same broken.

So path #1 worked when `agents_list` arrived via the
desktop's sync server. Paths #2 and #3 (the ones
designed to catch the "WebView loaded before the agents
list arrived" race) were silent no-ops.

The "30 sec delay" was just the user waiting for the
WebSocket connection + first agents_list broadcast.
The useEffect[agents] hook fired correctly when the
list arrived, but it was using the broken path so the
WebView never got the data — only the onAgentsList
handler actually worked.

## The fix

v3.1.37 rewrites paths #2 and #3 to use the same
working API as path #1: call
`window.Arena.setAgents(slim)` directly via
`injectJavaScript`, not via the message bus with a
type the WebView doesn't handle.

```js
webViewRef.current.injectJavaScript(
  `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
);
```

The message-bus path (path #1, the original onAgentsList
handler) is unchanged. It also uses
`window.Arena.setAgents()` directly — the WebView was
designed with that API as the canonical one.

The background load in onLoadEnd had the same bug —
it used `dispatchEvent` with `type: 'loadPrefs'`, which
the WebView also doesn't handle. Switched to
`window.Arena.setBackground(bgId)` directly.

## Desktop companion: re-broadcast on saveCompanion

`cyberclaw` v3.1.20 (paired with this): saveCompanion
in the desktop's forge was saving the new sprite
config (size, sprite id, name) but NOT re-broadcasting
the agents_list to the mobile. The mobile would only
see the new size on the next 60s periodic sync or on
reconnect. Now saveCompanion calls
`broadcastAgentsListToMobile()` after a successful
save, so the mobile sees changes immediately.

The broadcast logic was factored out of
`initArenaCompanions` into a reusable
`broadcastAgentsListToMobile()` function so
saveCompanion and any other code that mutates the
agent list can call it.

## Files

### `cyberclaw` v3.1.20

- `src/js/app.js`
  - Factored `broadcastAgentsListToMobile()` out of
    `initArenaCompanions`.
  - `saveCompanion` now calls
    `broadcastAgentsListToMobile()` after a successful
    save, so mobile sees sprite / scale / name changes
    immediately instead of waiting up to 60s.
- `package.json` — bumped to 3.1.20

### `CyberClawMobile` v3.1.37

- `src/screens/HomeScreen.tsx`
  - `useEffect([agents])`: switched from
    `dispatchEvent({type:'agentsList'})` (no-op) to
    `window.Arena.setAgents(slim)` (working). Now the
    inject fires the moment `agents` updates.
  - `onLoadEnd`: same fix for the agents re-inject at
    WebView load. Also fixed the background prefs
    message which had the same bug.
- `package.json` — bumped to 3.1.37
- `android/app/build.gradle` — versionCode 87,
  versionName 3.1.37
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.37` and `CyberClaw-Android-3.1.37.apk`

## Verification

- TS / JS parses clean.
- After install + restart of the desktop at v3.1.20:
  - App opens → forest background appears immediately
    (no "empty arena" pause).
  - Within 1-2 seconds of WS connection, the boar and
    hare sprites draw in the arena.
  - Change a companion's size in the desktop forge →
    save → the mobile's companion resizes within
    ~500ms (the time for the IPC round-trip), not 60s.
  - Change a companion's sprite in the desktop forge →
    save → the mobile's companion swaps sprites
    immediately.
