# v3.1.29 — stop falling back to Vosk, scan AsyncStorage for any training samples

## The bug

The Log tab on the user's test showed:
```
[5:16:06 PM] No training data for sample mode, falling back to Vosk
[5:16:09 PM] 🎧 Vosk listening: "Listening for 'hey claw'"
[5:16:30 PM] sample match: 51% (thr: 55%)
[5:16:32 PM] sample match: 31% (thr: 55%)
```

The user has 3 training samples recorded. But the settings
say `wakeWord = "hey claw"`, not `"hey clawsuu"` (the
training data is keyed by phrase). So:

1. The mobile looks for samples under
   `cyberclaw-wake-samples-hey-claw` → not found.
2. The "no training data" path fires Vosk as a fallback
   (which downloads a 50MB model and tries to listen for
   "hey claw").
3. The sample matcher ALSO starts (from a different code
   path) with the training data for "hey clawsuu" (the
   actually-trained phrase), but the audio doesn't match
   the training well enough to cross the 55% threshold.
4. Both paths run in parallel, the Vosk log spam is
   confusing, and the sample matcher never fires.

The user asked: "are we even using vosk anymore?" The
answer was: yes, as a fallback. It shouldn't be.

## The fix

Two coordinated changes:

### 1. Scan AsyncStorage for any training samples

Added a `findAnyWakeSamples()` helper at the top of
HomeScreen.tsx. It walks `AsyncStorage.getAllKeys()` for
any `cyberclaw-wake-samples-*` entry, parses the first one
with valid `features.length`, and returns the training
data plus the phrase it was trained for (decoded from
the key slug).

The wake-detection setup in HomeScreen and WakeModeScreen
now:

1. First tries the specific phrase the settings ask for.
2. If that's empty, calls `findAnyWakeSamples()` to fall
   back to any trained phrase.
3. If THAT is also empty, logs a useful message:
   "No wake-word samples found. Open Wake Mode and tap
   'Train wake phrase' to record 3 samples."

The same fallback is applied in all four wake-listener
restart paths:
- Initial setup (HomeScreen)
- Foreground restart (HomeScreen AppState listener)
- Background restart (HomeScreen AppState listener)
- Post-TTS restart after a wake trigger (HomeScreen)
- WakeModeScreen mount (the "Wake listening..." UI)

### 2. Removed the Vosk fallback

The mobile used to fall back to Vosk (Android-side
`WakeWordModule.start(phrase)`, which downloads a 50MB
speech-recognition model) whenever the sample matcher
couldn't find training data. This was a heavy, slow,
sometimes-failing fallback that the user doesn't need —
they have the sample matcher, and they can re-train if
they need to.

The v3.1.29 code:
- "no training data" path: log a warning, don't start
  any wake detection
- "Porcupine failed" path: log the error, don't fall
  back to Vosk
- "unknown wake mode" path: log a warning, don't start
  Vosk

The Android-side `WakeWordModule` still has the Vosk
integration (it can be enabled via `WakeMode === 'vosk'`
in settings, which doesn't exist). The native code is
intact; the JS side just no longer calls it. If you
ever want to re-enable Vosk as a deliberate choice, you
can — the code path is there.

## What's still open

- The arena is still single-sprite. The mobile's
  `arena.html` is a simplified one-companion pixel
  canvas; the desktop uses a multi-sprite `pixelArena`
  that the mobile doesn't have. To show Clawsuu and
  Lamasuu in the same arena, we need to either port
  the desktop's pixelArena to the mobile, or render
  the two sprites side-by-side in the existing
  `arena.html`. That's a real PR; not in this hotfix.
  (Tracked separately.)

## Files

- `src/screens/HomeScreen.tsx`
  - Added `findAnyWakeSamples()` helper at the top of
    the file (next to `getWakeSamplesKey`).
  - Initial wake-listener setup: scan for any samples
    if the specific phrase has none; log and skip if
    none anywhere (no more Vosk fallback).
  - Foreground restart (AppState listener): same
    fallback.
  - Background restart (AppState listener): same
    fallback + dropped Vosk fallback.
  - Post-TTS restart: same fallback.
  - The two `WakeWordModule?.start?.(phrase).catch()`
    calls (Vosk) are removed.
- `src/screens/WakeModeScreen.tsx`
  - The wake-listener effect: same fallback logic.
    Inlined the AsyncStorage scan (couldn't import
    the HomeScreen helper because it's not exported).
- `package.json` — bumped to 3.1.29
- `android/app/build.gradle` — versionCode 79,
  versionName 3.1.29
- `.github/workflows/*.yml` — bumped artifact names
  to `app-debug-3.1.29` and
  `CyberClaw-Android-3.1.29.apk`

## Verification

- `node` parse of both TSX files is clean.
- Bumped to v3.1.29 and pushed; debug + release builds
  will run on push.
- Manual reproduction after install:
  1. Open the app, the Log tab should NOT show "Vosk
     listening" or "downloading Vosk model".
  2. If the user has training samples for any phrase,
     wake detection should start and the log should
     say "Starting sample-match wake detection, phrase:
     \"<the-trained-phrase>\"".
  3. If the settings phrase is different from the
     trained phrase, the log should warn about the
     mismatch (and still use the trained phrase).
  4. If there are NO training samples, the log should
     say "No wake-word samples found. Open Wake Mode
     and tap 'Train wake phrase' to record 3 samples."
     No Vosk, no 50MB download.
