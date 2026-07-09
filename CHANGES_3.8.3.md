# v3.8.3 — Send-word trainer: progress UI + desktop pipe fix

Tobe: "It needs some padding top and it should
have the same UX as wake training does, the same
process logging etc. And it seems stuck at this
point. Been saying the same for 5 min now."

Two problems rolled into one release:

1. **The trainer stuck at "Uploading samples to
   desktop…" for 5 minutes.** The mobile was
   shipping the request, the desktop was
   receiving it… and dropping it. The desktop's
   `_handleMessage` switch in `src/sync-server.js`
   had no `case 'request_send_training'` (or any
   `send_*` case at all). Every other case hit
   the default arm and silently went nowhere. So
   the mobile sat at "Uploading…" forever, with
   no error and no progress.

2. **The trainer UI showed nothing useful while
   it was stuck.** No progress bar, no stage
   label, no elapsed timer, no last-event
   indicator, no event log — just a status line
   that said "Uploading samples to desktop…"
   and stayed there. Even when the desktop
   *is* working, the user can't tell from the
   mobile whether it's 30% or 95% or hung.

This release fixes both.

## Root cause (problem 1)

The mobile's `SendPhraseTrainer` was wired up
correctly on the phone side — it sends
`request_send_training` over the WebSocket, the
`SyncClient` defaults fire it through the
`_handleMessage` switch, and `send_training_progress`
events back from the desktop reach the listener.
What was missing was the desktop side.

The wake / exit training pipelines all wired up
both halves in lockstep:

- `wake_training_request` on `main.js`
- `request_wake_training` on `sync-server.js`
- same trio for exit (`exit_training_request`,
  `case 'request_exit_training'`, etc.)

The send-word pipeline only wired up half (the
mobile). The desktop's two key files had zero
`sending`-related code:

- `cyberclaw/src/main.js` — no
  `syncServer.on('send_training_request', ...)`
- `cyberclaw/src/sync-server.js` — no
  `case 'request_send_training'`,
  `case 'get_latest_send_training_result'`,
  or `case 'read_send_model'`

(Verified with `grep -rn "request_send_training"
cyberclaw/src` — zero hits.)

Adding the missing three cases on
`sync-server.js` plus the
`syncServer.on('send_training_request', ...)`
handler on `main.js` closes the gap. The send
training now flows through the same shell-out
to `scripts/train_wake_phrase.py` that wake and
exit use — same Python script, same
`PROGRESS::` / `OUTPUT_TFLITE::` parser, just
keyed by phrase (send is user-level, not
per-companion) instead of by agentId.

## UX upgrade (problem 2)

Rewrote `SendPhraseTrainer.tsx` to mirror the
step-by-step UX of `OpenWakeWordTrainer.tsx`.
Same components:

- **Progress card** with a stage label
  (emoji + text), an animated bar, percent
  complete, and the stage's status text
- **Logging card** with elapsed time
  (`mm:ss`), a color-coded "Last event: Ns ago"
  indicator (green if <15s, yellow if <60s,
  red if >60s), and a scrolling event log of
  the last 8 progress events with timestamps
- **Long-stage hint** during `generating_synthetic`
  / `training` that says "This can take 2-10
  minutes… You can close the app and the
  desktop will keep going"
- **Done / Error card** with a clearly
  green-or-red stage label and a Done / Close
  button
- **SafeAreaView + `useSafeAreaInsets()` +
  paddingTop 60** so the title clears the
  system status bar (the previous `padding:
  20` layout had "Train Send Word" clipping
  into the status bar on Tobe's phone)

The send-word trainer now has identical
informational density to the wake-word trainer,
so anyone who trained a wake word can read the
send-word trainer without learning a new
vocabulary.

## Training-result watchdog

Mirrors the wake trainer's pattern: while the
trainer is in any active stage, poll the
desktop every 20s for the cached send result.
If our WebSocket died mid-training (Android
killed the socket, brief network blip, etc.)
the desktop is still grinding on the GPU and
the next poll catches us up.

Plus an immediate re-poll on every
`authenticated` event, since the re-auth is
the first moment we have a working socket
again.

## What changed

### 1. Desktop `cyberclaw/src/main.js`

New cache state (mirrors the wake/exit pattern):

```
let lastSendResult = null;
let lastSendResultCompletedAt = 0;
let lastSendProgress = null;
function cacheSendResult(result) { ... }
function getCachedSendResult() { ... }
function setLastSendProgress(payload) { ... }
function getLastSendProgress() { ... }
syncServer._getCachedSendResult = ...;
syncServer._getLastSendProgress = ...;
```

Same 15-minute TTL (`WAKE_RESULT_TTL_MS`) as
the wake / exit caches.

New `syncServer.on('send_training_request',
({ ws, phrase, samples }) => { ... })` handler:

- Validates `samples = [{name, data}]` (base64
  audio). Same shape as wake.
- Resolves workDir to
  `~/.openclaw/cyberclaw/send-training/<safePhrase>/`
  (`safePhrase` = the phrase lowercased and
  sanitized to `[a-z0-9_]`).
- Writes the WAVs to `<workDir>/user_samples/`
  with `00_<name>` numeric prefixes.
- Spawns `python3 scripts/train_wake_phrase.py
  --name send_<safePhrase> ...` with the
  same args as wake / exit
  (`--n-samples 10000 --n-samples-val 2000
  --epochs 20`).
- Parses `PROGRESS::` and `OUTPUT_TFLITE::`
  lines from stdout; broadcasts the progress
  to all clients
  (`syncServer._broadcast({type: 'send_training_progress', ...})`)
  and stashes the latest into `lastSendProgress`.
- On process close, resolves the absolute
  `.tflite` path (the script emits the basename
  plus the `OUTPUT_TFLITE::` marker; we
  re-resolve against `outputDir` if it's not
  already absolute), checks it exists, and
  sends `send_training_result {ok, tflitePath}`
  back to the originating socket. Caches the
  result for 15 minutes.

### 2. Desktop `cyberclaw/src/sync-server.js`

Three new `_handleMessage` cases right after
the existing `read_exit_model` case:

- `case 'request_send_training'` — validates
  `phrase` + `samples`, emits
  `'send_training_request'` on the
  `SyncServer` emitter so `main.js` picks it up,
  or sends back `{type: 'send_training_result',
  ok: false, error: 'phrase, samples required'}`
  synchronously if invalid.
- `case 'get_latest_send_training_result'` —
  replays the cached `lastSendProgress` if it's
  <5 min old and the cached `lastSendResult`,
  with a `noResult: true` fallback so the
  mobile's watchdog poll doesn't get stuck.
- `case 'read_send_model'` — reads the
  `.tflite` file from `tflitePath` and sends
  back `{type: 'send_model_data', ok, base64,
  size, tflitePath}`. Same shape as
  `read_exit_model` / `read_wake_model`.

### 3. Mobile `src/components/SendPhraseTrainer.tsx`

Full rewrite, v3.6.0 → v3.8.3:

- `SafeAreaView` + `useSafeAreaInsets()` +
  `paddingTop: max(insets.top + 12, 60)` so the
  title clears the status bar on all phones.
- New progress card with stage label, animated
  bar, percent. Driven by the `stage` field in
  each `send_training_progress` event:
  `setup → uploading; generating_synthetic →
  generating_synthetic; augmenting; training;
  converting; complete → downloading;` then
  own stages for `downloading`, `activating`,
  `complete`, `error`.
- New logging card with `formatElapsed` /
  `formatClock` helpers, `lastEventAt` /
  `now` / `eventLog` state, 1-second tick while
  training is active, color-coded "Last event"
  indicator (green / yellow / red thresholds
  match wake), scrolling event log of the
  last 8 entries (latest at top).
- "You can close the app" hint during
  `generating_synthetic` / `training` (same
  copy as wake).
- Long-running done / error card with a
  colored stage label and a Done / Close
  button that calls `onComplete(true)` /
  `onComplete(false)`.
- Bottom-bar with "Train →" / Cancel buttons.
  Cancel is hidden while training is in
  progress (matches wake).
- `_onProgress` / `_onResult` / `_onModel`
  now attached via `useRef` in a `useEffect`
  with empty deps. Same v3.2.12 lesson from
  the wake trainer: attaching inside
  `trainModel` and removing via cleanup was
  attaching for ~10ms then immediately
  detaching, dropping every progress event.

### 4. Mobile version bump

- `package.json` `"version": "3.8.2" → "3.8.3"`
- `android/app/build.gradle`
  `versionCode 217 → 218`,
  `versionName "3.8.2" → "3.8.3"`

## Files touched

- `cyberclaw/src/main.js` (added cache state +
  `send_training_request` handler)
- `cyberclaw/src/sync-server.js` (added three
  new `_handleMessage` cases)
- `cyberclaw-mobile/CyberClawMobile/src/components/SendPhraseTrainer.tsx`
  (full rewrite)
- `cyberclaw-mobile/CyberClawMobile/package.json`
  (3.8.2 → 3.8.3)
- `cyberclaw-mobile/CyberClawMobile/android/app/build.gradle`
  (versionCode 217 → 218, versionName 3.8.2 →
  3.8.3)

## Not touched

- Desktop `package.json` — no version bump; the
  send-pipeline addition is part of the same
  ongoing 3.1.x line as the wake / exit
  trainers. Desktop is currently 3.1.53 and
  stays there.
- iOS — the iOS project (`CURRENT_PROJECT_VERSION
  = 1;` `MARKETING_VERSION = 1.0;`) hasn't been
  bumped in months and stays at 1.0 / 1. Send
  training doesn't yet exist on iOS so this
  doesn't affect anything there.
- Other trainers — `OpenWakeWordTrainer.tsx`
  (already at v3.2.0+) and `ExitPhraseTrainer.tsx`
  (separate file) were already wired correctly
  on both halves; they keep working unchanged.
- Workflow artifact names
  (`app-debug-3.2.27` in
  `.github/workflows/android-build.yml`) — stale
  but unrelated to this fix. Out of scope.
