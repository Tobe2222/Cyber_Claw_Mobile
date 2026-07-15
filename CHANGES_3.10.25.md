# v3.10.25 — wake test shows wake only

**Symptom:** the "Test wake" panel inside CompanionSettingsScreen's
Wake settings sub-page showed three peak rows: Wake peak, Exit peak,
Send peak. Tobe: "Why does it say exit and send also? Exit test
should be in exit and the same with send."

**Cause:** the test runner tracks all three classifiers because they
share the same melspec+embedding pass — peak tracking is "free" once
you have the score. The wake page was just rendering what was
collected, even though the user only asked for wake.

**Fix:** drop the Exit peak + Send peak rows from the wake test
display. The data collection still tracks them (it's free and useful
for debug), but the wake panel only renders what wake asked for.

**Native side:** unchanged. `getLatestScores` still returns all three.
The display is the only diff.

**Build artifacts:**
- `package.json`: 3.10.25
- `android/app/build.gradle`: versionCode 252, versionName 3.10.25
- Modified: `src/screens/CompanionSettingsScreen.tsx` (removed
  two `<View>` blocks from the wake test result panel)

**Open question for Tobe:** ship "Test exit" on the per-companion
Exit settings page + "Test send" on the global Send section in
SettingsScreen? Symmetric to "Test wake". Would require extracting
the test runner into a shared helper (small refactor). If yes, lands
in v3.10.25 follow-up; if no, stays as-is and the next release is
the exit+send speaker-gating work.