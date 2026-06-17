# 3.1.49 — Wake threshold settings, OLD wake mode fix, polish

## What it fixes (from v3.1.48 test)
1. **Wake trigger fires accidentally and brings the OLD wake mode.** The OLD in-home fullscreen mode (forest bg + "Transcribing..." + voice log bottom-left) shows up when the user taps the **Voice Mode** button in the arena, because the RN handler routes that button's `fullscreen` message to the legacy `enterVoiceMode('focus')` path. The new dedicated `WakeModeScreen` is the one that matches the user's reference image.
2. **Add a foreground wake threshold setting.** User asked for a tunable threshold (matching the existing background threshold) so they can tighten wake detection without retraining.
3. **Companions run up/down too fast, too often.** The 10% zoomies probability felt like 50% in practice. Reduced to 5% with a shorter dash.
4. **Companion name font is too big, should be orange.** Tobe asked for smaller font and orange color for both active and inactive companions.

## The fixes

### 1. Voice Mode button now goes to NEW WakeModeScreen
The Voice Mode button in the arena was sending `{type: 'fullscreen'}` to RN, which routed to the OLD in-home fullscreen mode (`enterVoiceMode('focus')` → `setFullscreen(true)`). Now it sends `{type: 'wakeword'}` which routes to the dedicated `WakeModeScreen` (same as the Wake Mode button). Both buttons now show the new wake mode UI.

### 2. Foreground wake threshold is now user-configurable
- `SettingsScreen.tsx`: added a "Foreground match threshold" slider (40-90% in 5% steps) that writes to `cyberclaw-wake-fg-threshold` in AsyncStorage. Default 55% (matches the previous hardcoded value).
- `HomeScreen.tsx`: both `startSampleMatchListener` calls now read the threshold from AsyncStorage before starting the listener. If unset, falls back to 0.55.
- `WakeModeScreen.tsx`: same change for its `startSampleMatchListener` call.

### 3. Zoomies state reduced from 10% to 5%
- Idle: 40% → 35%
- Walk: 50% → 60%
- Zoomies: 10% → 5%
- Zoomies dash duration: 0.8-2s → 0.6-1.4s (shorter dashes, less visual noise)

### 4. Companion name styling
- Font: 10px → 8px (smaller)
- Color: `c.isActive ? '#f7931a' : '#aaa'` → always `#f7931a` (orange)
- Y position: 4px above sprite → 3px above sprite (tighter)

## Files changed
- `android/app/src/main/assets/arena.html` — Voice Mode button routes to new wake, smaller orange name, fewer zoomies
- `src/screens/SettingsScreen.tsx` — new foreground threshold slider
- `src/screens/HomeScreen.tsx` — load FG threshold from AsyncStorage in 2 places
- `src/screens/WakeModeScreen.tsx` — load FG threshold from AsyncStorage
- `package.json` — 3.1.48 → 3.1.49
- `android/app/build.gradle` — versionCode 98 → 99, versionName "3.1.49"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.49
- `CHANGES_3.1.49.md` (new)

## What I deliberately did NOT change
- The Chat/Events/Log tab spacing (already tightened in v3.1.46)
- The companion tab spacing (already tightened in v3.1.48)
- The state machine structure (idle/walk/zoomies), the canvas size init, the scale handling
- The existing background threshold setting (it was already there; we just didn't use the value in the listener before — still using the hardcoded 0.65 for now, the new FG threshold is the priority)

## Lessons
**Read the code paths carefully.** The wake trigger goes through App.tsx → WakeModeScreen, but the OLD in-home fullscreen can be triggered by:
- Tapping the Voice Mode button in the arena (routes to `enterVoiceMode('focus')`)
- The fallback in `toggleWakeWordMode` if `onOpenWakeMode` is missing

Either of these can show the OLD style. Both need to be fixed (or the buttons removed) for the new style to be the only wake entry point.

**Settings must actually be read.** The foreground wake threshold was hardcoded to 0.55 in two places. Adding a SettingsScreen slider is useless if the runtime code ignores the saved value. Always wire the new setting to the runtime.