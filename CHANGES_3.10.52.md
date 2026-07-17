# v3.10.52 — wake test panel didn't receive wakeword (initOww never called)

Tobe retested wake after v3.10.51. Same diagnostic:

> "Loaded model: hey_jarvis"

So v3.10.51's stale-closure fix on the hook's `start`
function did NOT take effect for the wake sub-page
test button.

## Root cause

There are TWO `useClassifierTest('wake')` calls in the
codebase. v3.10.48's fix added `wakeword` to the
hook call at CompanionSettingsScreen.tsx:213 (the
companion-level destructure) — but the wake
sub-page's "Test wake" button uses
`<ClassifierTestPanel kind="wake" />`, which
internally calls `useClassifierTest(kind)` WITHOUT
passing any options. The panel's hook had
`options?.wakeword = undefined` for the entire
component lifetime.

The companion-level hook's `handleTestWake` (the one
with the right wakeword) was NEVER wired to the
button. It was dead code that LOOKED correct but
wasn't used.

So the actual call chain on Tobe's screen was:

1. `<ClassifierTestPanel kind="wake" />` renders
2. Inside the panel: `useClassifierTest(kind)`
   without options → `start` closure captures
   `options = undefined`
3. User taps "Test wake" → panel's `start` runs →
   `wakewordToScore = undefined` → SKIP
4. `initOww` is never called → detector stays on
   `'hey_jarvis'` (default from HomeScreen's earlier
   init)
5. `scoreWavFile` reads `owwWakeword = 'hey_jarvis'`
   → diagnostic: "Loaded model: hey_jarvis"

v3.10.51's fix added `options?.wakeword` to the
hook's useCallback deps. That fix was correct for
the hook's internals, but it didn't matter because
the panel's hook never RECEIVED options in the first
place. The closure wasn't stale — it was correctly
capturing `undefined` because options was always
`undefined`.

## Fix

Two changes:

1. `ClassifierTestPanel` now accepts an optional
   `wakeword` prop and forwards it to the hook.
2. The wake sub-page's `<ClassifierTestPanel
   kind="wake" />` now passes `wakeword={activeWakeDirect?.phrase}`.

The companion-level hook call at
CompanionSettingsScreen.tsx:213 (the one that was
correct but unused) was deleted. It shadowed the
panel's hook and made the codebase confusingly
duplicated. The panel is now the single source of
truth for the wake test.

## Files

- `src/components/ClassifierTest.tsx` —
  `ClassifierTestPanel` accepts `wakeword?: string`
  prop, forwards to `useClassifierTest(kind, { wakeword })`
- `src/screens/CompanionSettingsScreen.tsx` —
  wake sub-page's `<ClassifierTestPanel kind="wake" />`
  now passes `wakeword={activeWakeDirect?.phrase}`;
  dead companion-level `useClassifierTest` call (with
  correct options but unused start) deleted
- `package.json` — 3.10.51 → 3.10.52
- `android/app/build.gradle` — versionCode 278 →
  279, versionName 3.10.52

## General lessons

### Two call sites for the same hook = only one gets used

The wake test had two `useClassifierTest('wake')`
calls:
- CompanionSettingsScreen.tsx:213 — with options,
  destructured into `handleTestWake` (unused)
- ClassifierTestPanel.tsx:449 — without options,
  destructured into `start` (used by the button)

A future reader (and me, debugging) sees the
companion-level call with the correct wakeword and
thinks "good, that's wired correctly." But the
button's onPress calls the panel's `start`, not
the companion-level `handleTestWake`. The
companion-level call is dead code.

When you extract a hook into a panel AND keep a
parent-level call of the same hook, you have two
hooks running. One of them is dead code. Either
delete the parent-level call OR thread its result
through to the panel. v3.10.52 deletes the
parent-level call because the panel is the single
UI consumer.

This is the same pattern as v3.10.47's "the chat
was loaded into the single `messages` state but
`messagesByAgent` was never populated": two
parallel data structures, one correct and one
empty, the UI uses the empty one. When you
extract a hook, audit call sites and delete
shadowing duplicates.

### Diagnostic info surfaces WHERE the bug lives

v3.10.50's diagnostic said "Loaded model: hey_jarvis".
That immediately ruled out:
- "Mic dead" — RMS > 0
- "Model genuinely doesn't match" — scoreWavFile
  ran, returned 0
- "Wrong file format" — chunks were scored, just
  none crossed threshold

It pointed at: "the detector isn't loading the right
model." That's a state, not a code path. From there
I had to figure out WHICH code path is responsible
for loading. v3.10.51 thought it was the hook's
`start` closure. v3.10.52 finds it's actually the
panel never passing options in the first place.

The diagnostic info (`loadedWakeword`,
`detectorLoaded`) saved several rounds of guessing.
Without it, I'd be playing "which file change
broke wake testing" across multiple versions.

### Two debug rounds to find the right bug is normal

v3.10.50 surfaced the symptom. v3.10.51 fixed the
wrong layer (hook closure) but happened to add a
log entry on initOww failure that would have
caught this if Tobe shared the log. v3.10.52
finally fixes the right layer (panel props).

When the diagnostic points at a state but not a
path, expect 1-2 rounds of "fix the wrong thing,
learn more about the system, find the right
thing." That's not a mistake — it's the
diagnostic working correctly. Each round narrows
the search space. The alternative (jumping
straight to the right fix) requires either luck
or full system knowledge; the iterative path
requires neither and still converges.

## What's NOT fixed

- If the wake-set registry is genuinely missing
  the trained model file, initOww will still fail
  at the native side. v3.10.51's catch now logs
  the error, so the user would see the cause in
  the log tab. If Tobe's next test still shows
  peak=0 with "Loaded model: hey clawsuu", check
  the log for "initOww('Hey Clawsuu', 0.5) failed:
  No model file found" — that's a retraining or
  registry fix needed, not an app code fix.