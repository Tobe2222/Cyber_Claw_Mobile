# v3.10.26 — per-page classifier tests (wake / exit / send)

**TL;DR:** "Test wake" lived only on the Wake page; the Exit and Send
sections had no test button. v3.10.26 extracts the test runner into
a shared component (`ClassifierTestPanel`) and adds a "Test exit"
button on the Exit settings sub-page + a "Test send" button on the
Send section in global Settings.

## What's new

### New component: `src/components/ClassifierTest.tsx`

Exports:
- `useClassifierTest(kind)` — hook returning `{running, result, start, abort}`.
- `<ClassifierTestPanel kind="wake" | "exit" | "send" />` — drop-in UI.

The hook listens for the right OWW event per classifier
(`owwWakeDetected` / `owwExitDetected` / `owwSendDetected`) and polls
`getLatestScores()` on the same 80ms cadence as the OWW thread. Test
window is 4 seconds. Result shape is per-classifier:

```ts
type ClassifierTestResult = {
  fired: boolean;       // did the OWW event fire during the window
  firedScore: number | null;
  peak: number;         // 0..1 peak of the relevant classifier's score
  final: number;        // last observed score at window close
  durationMs: number;
};
```

The hook is reusable from any screen. The panel is a one-line
drop-in for the standard layout (button + result card).

### Wired into 3 places

- **CompanionSettingsScreen → Wake sub-page** — replaced the old
  inline wake-test button + result panel with
  `<ClassifierTestPanel kind="wake" />`. Removed the now-unused
  `wakeTestRunning` / `wakeTestResult` / `wakeTestAbortRef` state and
  the 75-line `handleTestWake` callback. Replaced by
  `useClassifierTest('wake')`.
- **CompanionSettingsScreen → Exit sub-page** — added
  `<ClassifierTestPanel kind="exit" />` right after the "Exit
  reply" section description.
- **SettingsScreen → Send section** — added
  `<ClassifierTestPanel kind="send" />` after the trained-send-model
  badge.

### Styling / colors per classifier

Each classifier uses the same color palette as its trainer page:
- **wake** + **exit** — orange (#f7931a), matching the existing
  trainer button colors.
- **send** — blue (#3b82f6), matching the "Train send word" button.

This way the user can intuite "this test button is for the thing
whose trainer is orange/blue". Not strictly required but cheap
visual continuity.

## Why a hook + a component?

The hook is what the wake page actually uses (we still pass
`wakeTestRunning` and `wakeTestResult` to the JSX in case any future
debug surface wants to read them). The component is the
drop-in alternative for places that just want a button + panel
without thinking about it.

In retrospect the wake page could ALSO have used the panel
component directly (it now does — the hook is still used internally
by the panel). Future classifier-test UIs can use either form.

## Why v3.10.26 and not part of v3.10.25?

v3.10.25 was a one-line UI patch ("trim two rows from the wake
test"). Tobe approved the bigger refactor in the same thread but
asked for confirmation first. Splitting the patch from the refactor
keeps the patch small and reviewable; the refactor is its own
reviewable unit.

## Cleanup

- Removed 75-line `handleTestWake` callback in CompanionSettingsScreen.
- Removed `wakeTestRunning` / `wakeTestResult` / `wakeTestAbortRef`
  state.
- Removed orphaned styles: `activeWakeTestRow`, `activeWakeTestBtn`,
  `activeWakeTestBtnRunning`, `activeWakeTestBtnText`,
  `activeWakeTestHint`, `activeWakeTestResult`,
  `activeWakeTestResultTitle`, `activeWakeTestScoreRow`,
  `activeWakeTestScoreLabel`, `activeWakeTestScoreValue`,
  `activeWakeTestNote`. The new panel component owns its own styles.

## Build artifacts

- `package.json`: 3.10.26
- `android/app/build.gradle`: versionCode 253, versionName 3.10.26
- New file: `src/components/ClassifierTest.tsx` (~240 lines)
- Modified: `src/screens/CompanionSettingsScreen.tsx` (-120 lines
  net: removed callback/state/styles, added import + two panel
  uses)
- Modified: `src/screens/SettingsScreen.tsx` (+5 lines: import +
  panel use in the Send section)
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors remain —
  unrelated to this release per the AGENTS.md "pre-existing TS
  errors" rule.

## What's NOT in v3.10.26

- **Why wake did poorly** — Tobe mentioned "it did poorly" in the
  same message; the test panel shows the peak score + fire/not-fire
  status, so the user can see what happened. Diagnostic steps:
  - Peak ≥ 70% + fired=true → model recognizes the voice. If the
    user is experiencing false wakes, lower the threshold in
    Settings → Wake word → Foreground match threshold.
  - Peak < 30% → model doesn't recognize the voice. Retrain.
  - Peak ≥ 30% but fired=false → highScoreFrames not reaching the
    threshold consistently. The user could try lowering the
    threshold, but a retrain with cleaner samples is the right
    answer.
  - Peak ≥ 70% but fired=false with no obvious false triggers →
    could be speaker-gate suppressing the wake (v3.10.23). If the
    profile is locked and the speaker match is < 0.5, wake is
    suppressed. This is a new failure mode introduced by the
    speaker-profile work — will explain this in the v3.10.27
    release notes if Tobe reports it.
- **Speaker-gate diagnostic surface** — would be nice to expose the
  current match score on the wake test result so the user can see
  "the gate is suppressing your wake at 42% match — speak louder
  or retrain your voice profile". Not in v3.10.26 scope; will
  surface in v3.10.27 if Tobe hits this.