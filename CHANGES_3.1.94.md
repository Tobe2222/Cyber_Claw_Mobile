# v3.1.94 — remove redundant audio beep on wake detection

## Why

v3.1.93 added an 880Hz beep when the wake word was detected, intending it as audible confirmation. Tobe: "we dont need audio beep on wake detection. the wake greetings is that function." He's right — the spoken greeting ("Greetings master Toby") already serves as the audio cue, and it's far more useful than a generic tone. A beep on top of the greeting would just be noise.

## What changed

### `WakeModeScreen.tsx`
Removed the `WakeWordModule?.playBeep?.(150, 880)` call and the 180ms post-beep pause from `handleWakeWordInner`. The wake-match flow now goes straight to the parent notification + listener cleanup, then recorder start.

### `WakeWordModule.kt`
Removed the `playBeep(durationMs, frequencyHz)` method entirely (no callers now). Code-only removal — no runtime behaviour change beyond the beep not playing.

## Files
- `src/screens/WakeModeScreen.tsx` — beep call removed
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — playBeep method removed
- `package.json` — 3.1.93 → 3.1.94
- `android/app/build.gradle` — versionCode 143 → 144
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.94

## Lessons
- **A user-confirmation feature can be redundant if the underlying flow already has the cue.** I added the beep to fix a perceived UX gap, but the wake greeting (which was already spoken on match) was already providing that cue. Listen before adding — the feature might already be there in a different form.
- **Don't ship code nobody asked for.** v3.1.93 shipped with the beep on my initiative. Tobe caught it in the same release cycle and asked for it gone. This is the "be conservative, ship what was asked for" lesson — when the user requests "fix X" and you notice an opportunity to also add Y, ask first.