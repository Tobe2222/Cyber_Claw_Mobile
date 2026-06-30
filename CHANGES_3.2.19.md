# 3.2.19 — Voice mode plays greeting before first recording turn

## Reported by Tobe

After v3.2.18 (Wake Mode killed), the wake phrase opened
Voice Mode directly but it skipped straight to "Listening..."
without playing the configured greeting. User expected:
"wake, greeting, talk, response..." (the v3.2.17 spec).

The voice log was also almost empty — only the final
"🎤 Listening..." line. Should have shown: greeting → speak
→ cached/uncached → done → listening.

## Root cause

In v3.2.18 I made the wake-listener-start useEffect
early-return when `voiceMode=true`. But the greeting code
was nested INSIDE that same useEffect (it ran after the
listener started, between the listener init and the
recording). So when voice mode early-returned, it also
skipped the greeting.

Voice mode → no greeting → straight to recording.
Wake-mode (now removed) had greeting.

## v3.2.19 fix

Voice-mode-mount useEffect now:
1. Reads `cyberclaw-ready-phrase` AsyncStorage key
2. Tries cached audio first (the v3.1.91 logic)
3. Falls back to native TTS (the v3.1.85 speak() path)
4. THEN starts the first recording turn

The wake-listener-start useEffect still early-returns when
voiceMode=true. The greeting code is now duplicated in both
places — the inline voice-mode copy is small (~20 lines) and
removing it from the wake-listener path would re-introduce
the bug if anyone ever un-earlies the wake listener.

## Files

- `src/screens/WakeModeScreen.tsx` — voice-mode mount
  useEffect now plays greeting before first recording
- `package.json` 3.2.18 → 3.2.19
- `android/app/build.gradle` versionCode 164 → 165,
  versionName 3.2.18 → 3.2.19
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.19

## Lessons

- **"When you delete code, check what else depended on
  the surrounding block, not just the lines you targeted."**
  The greeting was a sibling to the wake listener code;
  removing the wake listener path also removed the
  greeting even though the greeting wasn't logically
  part of wake listening. Splitting it into a separate
  useEffect (or extracting to a `playGreeting()` helper
  called from both places) would have prevented this.
  Failing that, read the entire `useEffect` body before
  adding the `if (voiceMode) return;` early-exit.
- **"Voice log emptiness is its own signal."** When the
  log shows exactly 1 entry on entry to a screen that
  historically showed 3-5 entries, that's a regression
  in the entry path, not just "this version has fewer
  logs." Tobe's empty-void log pointed at the greeting
  code path skipping — would have caught it faster if
  I'd noticed "log went sparse" in the bug report
  without him saying so.
