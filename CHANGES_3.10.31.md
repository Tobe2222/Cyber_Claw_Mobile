# v3.10.31 — wake listener auto-start + bigger bar

**Two issues from v3.10.30 testing:**

1. Bar is too small in both voice mode and settings.
2. Wake test still 0% across 4 tries (Tobe), even
   though the v3.10.30 diagnostic said "mic heard
   almost nothing". The diagnostic was right, but
   the cause was wrong.

## The root cause of issue 2

Tobe's screenshot from v3.10.30 showed:
```
Wake peak    0%
Average      0%
Mic RMS (avg) 0
⚠️ Mic heard almost nothing. Check mic permission,
speak louder, or hold the phone closer.
```

The "mic heard almost nothing" tip is technically
correct — the OWW detector received RMS=0 audio. But
the *cause* was not the mic being dead. It was that
the OWW listener was never started in the first
place.

`initOww()` is called once at app mount (App.tsx
~1.5s delay) — that loads the TFLite model. But
`startOwwListening()` is only called when the user
enters voice mode (WakeModeScreen on mount). If the
user opens CompanionSettings → Wake settings → Test
wake WITHOUT going through voice mode first, the
listener is initialized but the mic is OFF.

The result: `latestWakeScore` stays at its default
(null), `getLatestScores` returns 0.0 for wake,
no `owwVad` events fire, `avgRms` stays at 0, and
the v3.10.30 diagnostic said "mic dead". The mic
wasn't dead — it was just never turned on.

## What shipped

### 1. Bigger bar (voice mode + settings)

**`src/components/VoiceEnrollmentBar.tsx`:**
- Pill `paddingHorizontal`: 10 → 16
- Pill `paddingVertical`: 5 → 8
- Icon `fontSize`: 11 → 14
- Label `fontSize`: 10 → 12
- Text wrap `minWidth`: 60 → 140
- Internal track `width`: 60 → 140
- Internal track `height`: 2 → 3

Same color/pulse/look, just bigger and more readable.
The pill takes ~170px wide × ~30px tall, easily
visible at the top of voice mode or in the settings
list.

### 2. Wake listener auto-start in test

**`src/components/ClassifierTest.tsx`:**
- New `owwWasRunning` field on `ClassifierTestResult`
- Test runner now calls `WakeWordModule.startOwwListening()`
  before polling for the wake test. The method is
  idempotent (no-op if already running) per the
  native comment. The await ensures the listener is
  up before the first poll.
- If no `owwVad` events arrived during the test
  window, `owwWasRunning` is set to false in the
  result — this catches the edge case where the
  listener failed to start (mic permission denied,
  AudioRecord init failed, etc.) so the user gets
  a correct diagnostic.
- New "Wake listener" row in the result panel
  showing "running" (green) or "not running" (red).
- Updated `diagnosticTip()` to handle the
  `!owwWasRunning` case as a distinct tip: "Wake
  listener wasn't running — opened the mic for
  this test, but the detector never produced audio.
  Try entering voice mode first (it primes the
  listener), then re-run the test."

For exit/send tests, the listener auto-start is
skipped (exit/send run on the chunk-side detector
that's already wired up to whatever mic path is
active). The diagnostic tip handles the "no events"
case the same way.

## How the diagnostic tip now works

The 4-tier diagnostic from v3.10.30:
1. `!owwWasRunning` → "listener wasn't running"
2. `avgRms < 0.005` → "mic heard almost nothing"
3. `peak < 0.05` → "model never matched"
4. `peak < 0.30` → "model saw something but not enough"
5. `peak < 0.70` → "below the 70% fire threshold"
6. otherwise → "aim for 70%"

After the v3.10.31 fix, the user should NEVER see
tier 1 (the auto-start should keep the listener up).
If they do, the next-level diagnostic is the same:
"the listener isn't running, even though the test
tried to start it — something is wrong at a deeper
level (mic permission, native init failure, etc.)".

## How the user would have known this earlier

Two ways:
1. The Mic RMS row in the result panel is already
   red when < 0.005. The user can see "0" but the
   color is the same. A more obvious signal could
   be "—" (em dash) or "—" plus a "?" indicator.
2. A "Mic is OFF" message could be rendered in the
   test button itself before the test runs. But
   that requires querying `isOwwListening` from
   JS, which the native module doesn't expose.

The v3.10.31 fix is the right one: just start the
listener when the test starts. The "Wake listener"
row in the result panel is a belt-and-suspenders
diagnostic for the edge case where starting fails.

## Build artifacts

- `package.json`: 3.10.31
- `android/app/build.gradle`: versionCode 258, versionName 3.10.31
- Modified: `src/components/VoiceEnrollmentBar.tsx` —
  bigger pill sizes
- Modified: `src/components/ClassifierTest.tsx` —
  startOwwListening on wake test start, owwWasRunning
  field, "Wake listener" row, updated diagnostic tip
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors
  remain — unrelated to this release per the AGENTS.md
  "pre-existing TS errors" rule.

## What's NOT in v3.10.31

- **A native getter for `isOwwListening`**: a
  `getOwwListeningState()` ReactMethod that the JS
  side could call to check the listener state
  without having to run a test. Useful for showing
  a "Wake listener: OFF — say wake word to start"
  indicator in the Wake settings page when the
  listener is off. Deferred; the test itself is
  the right entry point.
- **Auto-start the wake listener at app mount**:
  always-on wake would mean the mic is always
  active, which has battery + privacy implications.
  The current "open voice mode to prime" is the
  right default. The v3.10.31 test-time auto-start
  is a local opt-in.