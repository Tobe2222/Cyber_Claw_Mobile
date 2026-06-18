# 3.1.59 — Fix Voice Mode button + missing companion in wake mode

## What it fixes
Tobe: "Okey good i think we are done with the arena for now. Lets check om the modes. I see the companion is missing from wake mode. And for some reason voice mode says the same as wake mode, listening for wake it says. Perhaps the buttons link is wrong."

Two issues:
1. **Voice Mode and Wake Mode buttons are wired to the same handler.** Tapping Voice Mode opens Wake Mode (the dedicated screen with the wake word listener). Both buttons send `{type:'wakeword'}` to React Native.
2. **The companion doesn't appear in wake mode.** The wake mode WebView is a fresh instance with no companions in its array, so it has nothing to draw.

## Bug 1: Voice Mode button sends 'wakeword' instead of 'fullscreen'

### Cause
In `arena.html` (the WebView's main page), the two buttons in `#ctrlRight` were:

```html
<button id="voiceBtn"
  onclick="...postMessage(JSON.stringify({type:'wakeword'}))">Voice Mode</button>
<button id="wakeWordBtn"
  onclick="...postMessage(JSON.stringify({type:'wakeword'}))">Wake Mode</button>
```

The Voice Mode button was sending the same message as the Wake Mode button. The home screen's handler at `handleArenaMessage`:
- `{type:'fullscreen'}` → `enterVoiceMode('focus')` → in-home fullscreen voice UI
- `{type:'wakeword'}` → `toggleWakeWordMode()` → dedicated WakeModeScreen

So tapping "Voice Mode" always opened the dedicated wake screen (which is what the user saw — the "Listening for wake word..." overlay).

### Fix
Change the Voice Mode button to send `{type:'fullscreen'}`:

```html
<button id="voiceBtn"
  onclick="...postMessage(JSON.stringify({type:'fullscreen'}))">Voice Mode</button>
```

The Wake Mode button is unchanged. Now the two buttons route to different screens.

## Bug 2: Companion missing from wake mode

### Cause
The home screen's WebView is mounted in HomeScreen.tsx and receives `setAgents` on every `agents_list` WebSocket message:

```ts
syncClient.on('agents_list', (msg) => {
  const slim = msg.agents.map(a => ({id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null}));
  webViewRef.current?.injectJavaScript(`window.Arena.setAgents(${JSON.stringify(slim)})`);
});
```

The wake mode's WebView is mounted in WakeModeScreen.tsx and is a **separate instance**. It receives the same `companionId` (e.g. "hare") via the `?companion=<id>` URL param, which sets `activeId` in the WebView. But the WebView's `companions` array is empty because `setAgents` was never called on it. The WebView draws nothing.

The home screen has the `agents` state. WakeModeScreen has no access to it (it's in a different component, the App.tsx router).

### Fix
1. **Lift `agents` to App.tsx.** Add an `onAgentsChange` callback to HomeScreen props. HomeScreen propagates the agents list (from both the WebSocket message and the AsyncStorage cache) to App.tsx, which stores it in state.
2. **Pass `agents` to WakeModeScreen** as a new prop.
3. **Inject `setAgents` on mount** in WakeModeScreen. The new `useEffect` injects `setAgents(agents)` once on mount, and once again after 300ms (in case the WebView wasn't ready for the first inject).

```ts
useEffect(() => {
  const injectAgents = () => {
    const slim = agents.map(a => ({id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null}));
    webViewRef.current?.injectJavaScript(`window.Arena.setAgents(${JSON.stringify(slim)})`);
  };
  if (agents.length > 0) {
    injectAgents();
    const t = setTimeout(injectAgents, 300);
    return () => clearTimeout(t);
  }
}, [agents, webViewKey]);
```

The wake mode WebView now has the same companions as the home mode WebView. The companion (whatever sprite is active) is drawn on the wake screen's black background.

## Files changed
- `android/app/src/main/assets/arena.html` — Voice Mode button now sends `{type:'fullscreen'}` instead of `{type:'wakeword'}`
- `App.tsx` — added `agents` state, accepts `onAgentsChange` from HomeScreen, passes `agents` to WakeModeScreen
- `src/screens/HomeScreen.tsx` — accepts `onAgentsChange` prop, reports agents on both `agents_list` and cache hydration
- `src/screens/WakeModeScreen.tsx` — accepts `agents` prop, injects `setAgents` on mount
- `package.json` — 3.1.58 → 3.1.59
- `android/app/build.gradle` — versionCode 108 → 109, versionName "3.1.59"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.59
- `CHANGES_3.1.59.md` (new)

## On the "missing companion" pattern
The home screen's WebView and the wake mode's WebView are **independent instances** with **independent state**. Any data the WebView needs (agents list, current companion, etc.) must be re-injected when a new WebView mounts. This applies to:
- Wake mode → needs setAgents on mount
- Settings screen → has its own WebView, may have same issue if it shows a companion
- Wake mode ↔ home mode → each has its own WebView, so state doesn't transfer

In the future, if the wake mode ever shows companions in some other way (e.g., bouncing animations, food drops), those states also need to be re-injected on mount.

## Lesson: button wiring bugs are silent
Both buttons sending the same message is the kind of bug that doesn't show up in any test or error log — the user just sees "Voice Mode" open the wrong screen. Two things to look out for:
- **HTML copy-paste errors**: the two button definitions are nearly identical, easy to make a mistake. Consider using a shared `onclick` handler or generating the buttons from a list.
- **Message-type disambiguation**: when adding a new screen, the React Native message types should be distinct (`fullscreen`, `wakeword`, `voiceMode`, etc.) and the buttons should be reviewed in pairs.

Tobe's "the buttons link is wrong" intuition was right.
