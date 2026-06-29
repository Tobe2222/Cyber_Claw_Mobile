# v3.2.9 — Wake trainer: explicit activity logging (elapsed time, last event, event log)

Tobe asked for better logging twice (after v3.1.43, after
v3.1.44 — both of which had the bar stuck at 30% on his
phone while the desktop was actually working). The
desktop-side fixes made the events reach the trainer; the
trainer UI just didn't surface enough of them.

**The fundamental problem:** the bar at 30% and the bar at
95% look identical if they aren't moving. Even when the
desktop IS emitting progress events every few seconds, a
mobile UI that just shows "30%, Sending samples to
desktop..." gives the user no way to tell "the desktop is
actively working but slowly" from "the desktop has gone
silent and this is stuck". The only diagnostic was the
desktop log file at `/tmp/cyberclaw-desktop.log`, which
isn't visible to the user.

**This release adds an explicit logging card below the
progress bar with three things the user can read at a
glance:**

1. **Elapsed time** — `Elapsed: 3:42` — total seconds
   since startTraining fired. Caps at nothing; just keeps
   counting.

2. **Last event** — `Last event: 8s ago` — seconds since
   the most recent PROGRESS:: message from the desktop.
   Color-coded:
   - **Green** (< 15s): desktop is actively working,
     everything is fine.
   - **Yellow** (15-60s): desktop is between events but
     hasn't gone silent. Augment substep emits events
     roughly every 1-2 seconds; if it goes 15+ seconds
     without one, something is wrong but not necessarily
     stuck.
   - **Red** (60s+): desktop has gone silent. The
     watchdog should have polled by now; if the cached
     result comes back empty AND the bar isn't moving,
     it's probably actually stuck.

3. **Event log** — last 8 progress events with timestamps,
   newest at the top. e.g.
   ```
   [12:55:14] 65% — Augmenting + features (90% complete)
   [12:55:13] 65% — Augmenting + features (89% complete)
   [12:55:12] 65% — Augmenting + features (88% complete)
   ```
   Capped at 50 entries to avoid unbounded memory growth
   on long trainings. The user can scroll through it
   during a long training to confirm progress is actually
   happening.

**Also:** `_onResult` now ALSO bumps `lastEventAt` and
appends an entry to the event log, so a desktop response
to the watchdog's `get_latest_wake_training_result` poll
resets the "Ns ago" counter. Otherwise the user would see
"Last event: 60s ago" with no way to know that the desktop
IS responding, just not to PROGRESS:: events (because it's
in the middle of a long DNN training step that doesn't emit
intermediate events).

**The 1-second tick is a separate `setInterval`** that
runs only while training is in an active stage
(`uploading`, `generating_synthetic`, `augmenting`,
`training`, `converting`, `downloading`). It updates the
`now` state which re-renders the "Ns ago" text. Stops
automatically on terminal stages (`idle`, `complete`,
`error`, `recording`) so it doesn't burn battery when the
screen is idle.

**Lesson (the real one):** when a user complains about
"no logging", they mean "I have no way to distinguish
working from stuck from my phone". Don't fix the symptom
by adding more logs to the server-side log file — the
user can't see that. Add the logging to the SAME screen
they're staring at, in a form they can read at a glance.
A monospace `Ns ago` counter with color-coding is worth
ten pages of server logs.

Also: when the underlying bug takes multiple iterations
to fix (this was the 4th attempt: v3.2.6 → v3.1.41 →
v3.1.42 → v3.1.43 → v3.1.44 → v3.2.9), the user gets
frustrated. Adding diagnostic output to the failing UI
on iteration 2 would have surfaced the real bug
(WebSocket dead → _send no-ops) faster than the
server-side fixes did. Always make the user-visible UI
self-diagnosing when a long-running operation is involved.

**Files:**

- `src/components/OpenWakeWordTrainer.tsx` —
  `lastEventAt` / `trainingStartedAt` / `now` /
  `eventLog` state, 1s `setInterval` tick while training
  is active, `_onProgress` and `_onResult` update the
  new state, progress card gains a logging card with
  elapsed / last-event / event-log. New styles
  (loggingCard, loggingLine, loggingLabel,
  loggingValue, loggingFresh / Aging / Stale,
  eventLog, eventLogEntry, eventLogTs) + two helpers
  `formatElapsed` and `formatClock`.
- `package.json` — 3.2.8 → 3.2.9
- `android/app/build.gradle` — versionCode 154 → 155
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.9