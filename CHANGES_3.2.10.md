# v3.2.10 — Wake trainer: log every wire message to the Log tab so we can see what's reaching the phone

After v3.2.9 added the in-screen activity logging, the
phone showed "Last event: 24s ago" but the desktop log
showed PROGRESS events being broadcast. We don't know
*which* of the seven layers (desktop emit → parent stdout
→ main.js handler → broadcast → phone WS → SyncClient
parser → trainer handler) is failing on the phone side.

This release adds `console.log` to every step of the
wake-training data path on the mobile side, so the Log
tab surfaces everything:

- `[SyncClient] default-case msg: type=wake_training_progress`
  — every wake_training_progress message that arrives
  on the phone's WebSocket
- `[Trainer] _onProgress: stage=augmenting pct=62` —
  every time the trainer's `_onProgress` handler fires
- `[Trainer] watchdog poll (stage=uploading connected=true)`
  — every 20s while training is active, the watchdog
  polls the desktop
- `[Trainer] sending requestWakeTraining agentId=clawsuu
  samples=6` — when the user presses Train

When the user re-tests, they can open the Log tab and
see exactly which messages are reaching the phone. If
they see `default-case msg: type=wake_training_progress`
but no `_onProgress`, the handler is broken. If they
see no `default-case` at all, the message isn't
reaching the phone's WebSocket. If they see no
`watchdog poll`, the trainer's setInterval isn't
running.

**Why console.log instead of the trainer card:**
the trainer card only shows the LAST event. We need
the full sequence to diagnose where the message
flow stops.

**Files:**

- `src/components/OpenWakeWordTrainer.tsx` — console.log
  in `_onProgress`, the watchdog setInterval callback,
  and `startTraining` (just before `requestWakeTraining`).
- `src/services/SyncClient.ts` — console.log in the
  default case of `_handleMessage`, so every message
  the phone receives that doesn't have a dedicated case
  shows up in the Log tab.
- `package.json` — 3.2.9 → 3.2.10
- `android/app/build.gradle` — versionCode 155 → 156
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.10