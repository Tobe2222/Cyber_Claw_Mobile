# 3.1.50 — Wake mode: no forest background (the actual fix)

## What it fixes
After Tobe pointed out (correctly) that the wake mode visual was still the "old" style, I realized my v3.1.49 fix was wrong. The wake trigger goes through App.tsx → WakeModeScreen (the dedicated screen), but WakeModeScreen renders the arena WebView which shows the forest background. So even though the screen was the new one, the visual was dominated by the forest + the React Native overlays — looking exactly like the old in-home fullscreen mode.

Tobe said: "voice mode is supposed to have the same look as wake mode, just different logic and operation. that fullscreen like that should not be a thing in either modes."

So the wake mode visual should be distinct from the home screen's arena — no forest background. Just the companion on a solid black canvas with the React Native overlays (status, voice log, ✕ button).

## The fix

### arena.html supports `?mode=wake` query param
- When `?mode=wake` is in the URL, the WebView renders WITHOUT loading the background image. `drawBackground()` paints solid black instead.
- The body gets a `wake-mode` CSS class which hides the `#ctrlRight` (Voice Mode / Wake Mode buttons — redundant in wake mode).
- All companion state, animation, drawing logic is unchanged — just no background image, no buttons.

### WakeModeScreen passes `?mode=wake`
- WebView source URI changed from `arena.html?companion=...&platform=mobile` to `arena.html?v=${APP_VERSION}&companion=...&platform=mobile&mode=wake`
- Added the `?v=${APP_VERSION}` cache-buster too (Android WebView caches `file:///android_asset/` aggressively by URI — without the version param, an APK upgrade would serve the old HTML until app data is cleared).

## Files changed
- `android/app/src/main/assets/arena.html` — `?mode=wake` support, solid black background, hidden control buttons
- `src/screens/WakeModeScreen.tsx` — pass `?mode=wake` + cache-buster in WebView URI; import APP_VERSION
- `package.json` — 3.1.49 → 3.1.50
- `android/app/build.gradle` — versionCode 99 → 100, versionName "3.1.50"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.50
- `CHANGES_3.1.50.md` (new)

## What I deliberately did NOT change
- The home screen arena (HomeScreen passes the same `?companion=...&platform=mobile` but NOT `?mode=wake`, so the forest background is preserved on the home screen).
- The React Native overlays in WakeModeScreen (status text, voice log, ✕ button) — they stay on top of the WebView as before, just now over a black canvas instead of the forest.
- The voice log bottom-left format ("Listening/Silence detected/Sent, waiting") in HomeScreen — that's a separate code path and not the user's complaint here.

## Lessons
**Verify the actual screen the user is seeing, not the code path that should be triggered.** I assumed the wake trigger was going to App.tsx → WakeModeScreen and dismissed the user's report as "they must be tapping Voice Mode". I was half-right (the code path was correct) but missed that the WakeModeScreen visual itself looked identical to the OLD in-home fullscreen because of the forest background. The "old look" the user was seeing wasn't a code routing issue — it was a styling issue inside the new screen.

**Distinct visual identity for distinct screens.** When two screens do different things but look the same, users can't tell them apart. The home screen's arena has the forest background (it's the home, you see your companions in their environment). The wake mode has a clean black background (it's a focused mode for triggering actions, the environment is irrelevant). The user wants them visually different. v3.1.50 makes wake mode's WebView render with no background.

**Always wire the cache-buster on every WebView that loads `file:///android_asset/`.** HomeScreen has `?v=${APP_VERSION}`. WakeModeScreen didn't (it was added in v3.1.42 only to HomeScreen). Without it, after an APK upgrade the old arena.html would be served until the user cleared app data. Now both have the cache-buster.