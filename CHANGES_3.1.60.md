# 3.1.60 — Wake/Voice mode shows only the active companion, centered, bigger

## What it fixes
Tobe: "Okey updated and tested. Now there is both companions in a very small scale in the wake mode for some reason. Its supposed to be the companion which text channel the user currently has selected. And it should just stay at the center there not walking around. And be much bigger ofcourse. Voice mode should have the same look but not function/process ofcourse."

Two issues:
1. **Wake mode shows both companions** (small, at the bottom of the screen) instead of the active chat companion (centered, big, idle)
2. **Voice mode still uses the in-home fullscreen view** (forest background, both companions in regular layout) instead of the wake-mode-style view

## Fix: `?onlyActive=true&centered=true` URL params on the arena

The arena now supports two new URL params:

### `?onlyActive=true`
After `setAgents` builds the companions, filter to only the one matching `activeId`. The fallback (if `activeId` doesn't match any companion) is to show the first one.

```js
if (ONLY_ACTIVE && activeId) {
  const active = companions.find(c => c.id === activeId);
  companions = active ? [active] : companions.slice(0, 1);
}
```

### `?centered=true`
Position the (only) companion at the canvas center, force it to scale 6 (192px on a 32x32 sprite, much bigger than the typical 1-2 / 32-64px), and set a `_centered` flag that tells `update()` to skip the state machine entirely (no movement, no walking, no ping-pong).

```js
if (CENTERED && companions.length > 0) {
  const c = companions[0];
  c.scale = 6;  // 192px — much bigger than typical mobile 1-2
  const [fw, fh] = c.data.frameSize;
  const dw = fw * c.scale;
  const dh = fh * c.scale;
  c.x = (canvas.width - dw) / 2;
  c.y = (canvas.height - dh) / 2;
  c.vx = 0; c.vy = 0;
  c.state = 'idle';
  c.direction = 0;  // face camera
  c._centered = true;
}

// In update():
if (c._centered) {
  c.animation = 'idle';
  c.frame = 0;  // hold first frame of idle
  c.direction = 0;  // face camera
  continue;  // skip state machine entirely
}
```

## WakeModeScreen URL change
```ts
// v3.1.50:
source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&companion=${companionId}&platform=mobile&mode=wake` }}

// v3.1.60:
source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&companion=${companionId}&platform=mobile&mode=wake&onlyActive=true&centered=true` }}
```

## Voice Mode = WakeModeScreen with `voiceMode` prop

The `WakeModeScreen` component now accepts a `voiceMode` boolean prop. When true:
- The sample-match wake listener does NOT start (`if (voiceMode) return;` at the top of the listener useEffect)
- The recorder does NOT start
- The status overlay shows "🎙️ Voice Mode" instead of "🎧 Listening for wake word..."
- The initial voice log shows "🎙️ Voice Mode ready"

Same visual (centered companion on black background, big, idle) — different behavior (no wake word listening, no recording).

App.tsx now has two routes:
- `screen === 'wake-mode'` → renders `<WakeModeScreen ... />` (default, voiceMode=false)
- `screen === 'voice-mode'` → renders `<WakeModeScreen ... voiceMode />` (no listener)

The Voice Mode button in the arena (`{type:'fullscreen'}` message) now calls `onOpenVoiceMode?.()` which sets `screen = 'voice-mode'`. The wake word (handled by the native bridge) still routes to `screen = 'wake-mode'` for the actual listening.

## Files changed
- `android/app/src/main/assets/arena.html` — new `?onlyActive=true&centered=true` URL params, `_centered` flag in update() to skip state machine
- `src/screens/WakeModeScreen.tsx` — new `voiceMode` prop, URL includes new params, voice status text adapts to mode
- `src/screens/HomeScreen.tsx` — accepts `onOpenVoiceMode` prop, Voice Mode button routes to it
- `App.tsx` — new `'voice-mode'` screen state, renders WakeModeScreen with `voiceMode` for that route
- `package.json` — 3.1.59 → 3.1.60
- `android/app/build.gradle` — versionCode 109 → 110, versionName "3.1.60"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.60
- `CHANGES_3.1.60.md` (new)

## On the "much bigger" size
The default mobile scale is 1-2 (32-64px on a 32x32 sprite). For wake/voice mode, the user explicitly asked for "much bigger", so I hardcoded scale 6 (192px). On a 360x187 canvas, that's 53% of the width — clearly the visual focus. The 6 value isn't derived from anything user-configurable; if you want it bigger or smaller, change the `c.scale = 6` line in the `CENTERED` branch.

## On the voice mode "look but not function"
Tobe: "voice mode should have the same look but not function/process ofcourse." So same visual (centered companion on black), different behavior (no wake listening, no recording). The single component with a `voiceMode` prop is the cleanest way to express this — the visual code path is shared, only the listener and overlay text differ.

If the user later wants voice mode to actually do something (e.g., "tap to start recording"), the `voiceMode={false}` flag is the place to hang that. For now, voice mode is purely visual — useful for "show me who I'm talking to" without the wake word complexity.
