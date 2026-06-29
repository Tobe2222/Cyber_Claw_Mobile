# v3.2.15 — Wake mode: auto-switch to voice mode when the wake word matches

Tobe reported: "It still says listening for wake after
the greeting. Like the old wake mode did."

The wake word is working correctly — the log on
his screenshot shows:

```
Matching: hey-clawsuu
  greeting cached ✓
  playing cached
  listening for wake word...
  done (cached-play, 1663ms)
```

But the screen stayed in wake mode with the
"Listening for wake word..." header. The previous
behavior was: after the wake word matches and the
greeting plays, the user has to back out and manually
open Voice Mode to actually speak a command. That's
the bug Tobe spotted.

**Fix:** `App.tsx`'s `onWakeMatch` callback now also
calls `setScreen('voice-mode')` so the user lands
in voice mode immediately after the wake word fires.
The greeting plays first; once it finishes, the user
is already in voice mode ready to speak a command.

The fix is one line in App.tsx. The companion-ID
update (the original purpose of `onWakeMatch`) is
preserved.

**Files:**

- `App.tsx` — `onWakeMatch` now also calls
  `setScreen('voice-mode')` after updating the active
  companion.
- `package.json` — 3.2.14 → 3.2.15
- `android/app/build.gradle` — versionCode 160 → 161
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.15

v3.2.14's wake-phrase re-init fix is still in this
build (it was the right fix for the OLD-wake-word
listening bug). v3.2.15 addresses the
"wake-word-matches-but-I-still-have-to-tap-Voice-Mode"
UX bug Tobe spotted.