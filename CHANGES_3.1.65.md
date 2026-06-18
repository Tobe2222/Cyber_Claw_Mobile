# 3.1.65 — Voice mode: use the same dedicated screen as wake mode

## What it fixes
Tobe: "Wake mode looks good, just copy the style of wake mode. It should look exactly the same 🤷 Why are you screwing so much about it? I have stated that same look many times."

Tobe is right. After three attempts to make voice mode use the in-home fullscreen with a `setCentered` runtime call (v3.1.62, v3.1.63, v3.1.64), the visual kept being subtly different from wake mode. The simplest fix is to use the SAME component for both modes.

## The actual fix
1. **Re-add the `voiceMode` prop on WakeModeScreen.** When `voiceMode={true}`:
   - Skip the wake listener (the v3.1.61 code)
   - Start the VAD + recorder (the in-home voice mode process from v3.1.59)
   - Show "🎧 Listening..." status text instead of "🎧 Listening for wake word..."
2. **Add a `'voice-mode'` route in App.tsx** that renders `<WakeModeScreen ... voiceMode />`.
3. **The Voice Mode button** in the arena now routes to the dedicated screen, not the in-home fullscreen.
4. **Remove the `setCentered` injection from HomeScreen** — voice mode is no longer in-home fullscreen.

## What was wrong with v3.1.62 / v3.1.63 / v3.1.64
The v3.1.62 approach was correct: dedicated screen for visual consistency. The problem was that I removed voice mode's process (VAD + recorder) along with the wake listener, when I should have kept the voice mode's own process.

v3.1.62 was the right architecture, but I disabled the wake listener without adding back the voice process. The fix is to do BOTH: dedicated screen (visual consistency) + the voice mode's own process (VAD + recorder, started on mount).

The in-home fullscreen with `setCentered` injection (v3.1.62-v3.1.64) was a workaround that introduced three bugs (silent fallthrough, lost companions on exit, gigantic companion due to canvas size). The dedicated screen approach doesn't have those bugs.

## Files changed
- `src/screens/WakeModeScreen.tsx` — re-added `voiceMode` prop, early-return in wake listener when voiceMode, start VAD + recorder when voiceMode, voice status text adapts to mode
- `App.tsx` — added `'voice-mode'` route that renders WakeModeScreen with `voiceMode`
- `src/screens/HomeScreen.tsx` — Voice Mode button routes to `onOpenVoiceMode` (new prop), removed setCentered useEffect (no longer needed)
- `package.json` — 3.1.64 → 3.1.65
- `android/app/build.gradle` — versionCode 114 → 115, versionName "3.1.65"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.65
- `CHANGES_3.1.65.md` (new)

## Lesson: when the user says "just copy X", copy X
Tobe said "just copy the style of wake mode. It should look exactly the same" — multiple times. I tried to be clever by sharing the visual layer via `setCentered` (a runtime API call) instead of the entire component. The visual stayed subtly different (background color, font, layout math), and I spent three versions fixing the gaps.

The simpler path: use the SAME component for both modes. The component is designed to be reusable (it's just a fullscreen with overlays). The only difference between wake mode and voice mode is the LISTENER — wake mode listens for the wake word, voice mode starts the recorder immediately. A boolean prop captures that exactly.

When in doubt, copy the user's request literally. Don't try to be clever by abstracting — the abstraction can introduce subtle bugs that are hard to diagnose.
