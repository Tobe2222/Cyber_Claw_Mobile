# 3.1.62 — Restore voice mode's actual functionality (VAD + recorder + auto-send)

## What it fixes
Tobe: "why do you say voice mode wake listener? It is no wake listener in voice mode. Their functionality and process has always been correct. Or have you edited it? Its just its visuals that have needed editing. If you have edited either voice mode or wake modes logic and process you need to restore it. Earlier versions did work."

## What I broke
v3.1.60 / v3.1.61 routed the Voice Mode button (`{type:'fullscreen'}` message) through a dedicated WakeModeScreen with a `voiceMode` prop that disabled the wake listener. The intent was "voice mode should have the same look but not function/process of wake mode" — I interpreted "not function/process" as "no wake listener", which was correct. But I also accidentally REPLACED voice mode's own process with the wake-mode process. The dedicated screen only had wake-listener logic (disabled) and a status overlay showing "🎙️ Voice Mode" — it had no VAD, no recorder, no silence detection, no auto-send.

Before v3.1.60, voice mode had its own substantial implementation (~150 lines):
- `setFullscreen(true)` to make the in-home fullscreen UI cover the screen
- VAD (Voice Activity Detection) initialization
- `SimpleAudioRecorder` start with 5-second silence timeout
- `recorder.once('silence')` listener that triggers a 3-second countdown
- Auto-stop and auto-send on silence
- 30-second max-duration fallback
- Audio detection timer for visual feedback ("recording" status)
- Voice status overlay ("Listening for audio..." / "Recording..." / "Sending in Ns..." / "Transcribing...")
- Voice log overlay with live updates

The wake listener was never in voice mode's process — voice mode was always about manual voice input (tap → speak → auto-send), distinct from wake mode (always-listening for the wake word).

## The fix
1. **Restore the Voice Mode button routing.** `{type:'fullscreen'}` from arena → `enterVoiceMode('focus')` (the in-home fullscreen with VAD/recorder), NOT `onOpenVoiceMode` (which routed to a dedicated screen).
2. **Remove the `voiceMode` prop from WakeModeScreen.** It was the wrong abstraction. WakeModeScreen is now ONLY for wake mode (its original purpose).
3. **Remove the `'voice-mode'` route from App.tsx.** Voice mode lives entirely in HomeScreen's fullscreen mode again.
4. **Add `setCentered(enabled)` to `window.Arena` API.** Runtime version of the `?onlyActive=true&centered=true` URL params, called when `fullscreen` state changes via `useEffect([fullscreen])`. This gives voice mode the same centered-companion visual as wake mode without remounting the WebView.

## What stays the same
- Wake mode is unchanged. Dedicated WakeModeScreen with the sample-match wake listener, recorder, and the `?onlyActive=true&centered=true` URL params (which still work via the URL — WakeModeScreen's WebView is a separate instance).
- The state machine, idle direction fix, scale bug fix, log sticky-bottom, scale diagnostic events — all unchanged.

## Files changed
- `android/app/src/main/assets/arena.html` — added `setCentered(enabled)` to `window.Arena` (filters to active companion, centers it at scale 10, sets `_centered` flag, and reverses on disable)
- `src/screens/HomeScreen.tsx` — reverted `{type:'fullscreen'}` handler to call `enterVoiceMode('focus')`; added `useEffect([fullscreen])` to inject `setCentered`
- `src/screens/WakeModeScreen.tsx` — removed `voiceMode` prop, reverted initial state to always-listening, removed early-return in wake listener
- `App.tsx` — removed `'voice-mode'` from screen union, removed `onOpenVoiceMode` prop, removed voice-mode route
- `package.json` — 3.1.61 → 3.1.62
- `android/app/build.gradle` — versionCode 111 → 112, versionName "3.1.62"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.62
- `CHANGES_3.1.62.md` (new)

## Lesson: "look but not function" means "same visual, different process"
Tobe: "voice mode should have the same look but not function/process of wake mode." I interpreted "not function/process" as "no wake listener" (correct) AND as "no separate process" (wrong — voice mode has its OWN process). The right interpretation: voice mode has a different process (VAD + recorder + auto-send), wake mode has a different process (always-listening for wake word). Both happen to share the same VISUAL.

When the user says "X should look like Y but not function like Y", they mean the visual is shared, the function is different. Reusing the implementation is a bug unless the implementation is purely visual.

## What I should have done in v3.1.60
The right move for voice mode's visual:
1. Add `setCentered(true)` to `window.Arena` API (so we can toggle the visual without remounting)
2. Call `setCentered(true)` when `fullscreen` becomes true in HomeScreen
3. Call `setCentered(false)` when `fullscreen` becomes false
4. Leave voice mode's process (VAD + recorder + auto-send) untouched

That would have been 4 lines of code, not 150+. The wake listener doesn't need to be in the visual layer at all — the WakeModeScreen is its own thing with its own dedicated WebView.

The mistake: when I saw "voice mode should have the same look but not function/process", I reached for the same component (WakeModeScreen with a prop). But the processes are different enough that they need different implementations. Sharing the visual via `setCentered` is the right abstraction, not sharing the component.