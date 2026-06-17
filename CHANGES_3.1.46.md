# 3.1.46 — Mobile Arena: Remove Shadows, Restore Voice/Wake Buttons, Tighten Tabs

## What it fixes
After testing v3.1.45, Tobe reported:

1. **Remove the shadows.** The shadows under the companions looked like blobs on the dirt path, not natural ground shadows.
2. **Voice Mode and Wake Mode buttons are gone from the arena.** They used to be overlay buttons on the WebView; v3.1.43's clean rewrite removed them.
3. **Chat tabs have too much room; remove the robot emoji from them.** The `Chat | Events | Log` tab row had `paddingVertical: 10` and emoji prefixes (💬, 📜, 📋).

## The fixes

### 1. Shadows removed
- Commented out `drawShadow(c)` in `render()`. The function still exists (in case we want to bring shadows back later as a debug option), but it's no longer called.
- Result: companions stand cleanly on the grass without the soft ellipse underneath.

### 2. Voice Mode and Wake Mode buttons restored
- Added back the `#ctrlRight` div with two buttons: `Voice` and `Wake`.
- CSS for the buttons: small (54×24px), semi-transparent black with orange border, matching the original v3.1.14+ design.
- The buttons send `{type: 'fullscreen'}` (Voice Mode) or `{type: 'wakeword'}` (Wake Mode) to React Native via `ReactNativeWebView.postMessage`. The RN side already handles these message types (see `handleArenaMessage` in `HomeScreen.tsx:720+`).
- The buttons are positioned top-right of the arena so they don't overlap the companions.

### 3. Chat tabs tightened
- `tab` style: `paddingVertical: 10` → `paddingVertical: 4` (less vertical space).
- Tab text: removed the emoji prefixes (`💬 Chat` → `Chat`, `📜 Events` → `Events`, `📋 Log` → `Log`).
- Result: the tab bar takes about half its previous height, more compact.

## Files changed
- `android/app/src/main/assets/arena.html` — removed `drawShadow()` call, added Voice/Wake buttons (HTML + CSS)
- `src/screens/HomeScreen.tsx` — removed tab emojis, reduced tab padding
- `package.json` — 3.1.45 → 3.1.46
- `android/app/build.gradle` — versionCode 95 → 96, versionName "3.1.46"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.46
- `CHANGES_3.1.46.md` (new)

## What I deliberately did NOT change
- Arena state machine, animation handling, scale, canvas size — all from v3.1.45.
- The companion list, sprite assets, layout, GROUND_FRACTION.
- React Native handling of the `fullscreen` / `wakeword` messages — it was already in place (HomeScreen.tsx:720+); we just needed the buttons to send them again.

## What to expect on next test
- No shadows under the companions (cleaner look).
- Two small buttons in the top-right of the arena: `Voice` and `Wake`. Tapping them enters Voice Mode or Wake Mode respectively (via the existing RN handlers).
- The `Chat | Events | Log` tab bar takes about half its previous vertical space; no emoji prefixes.