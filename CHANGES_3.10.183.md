# v3.10.183 — Local-LLM status pill (mirror desktop CyberClaw v3.3.5/v3.3.6)

Pairs with the desktop's per-companion local-LLM pill feature. The
desktop pushes `llm_status` events over the sync-server WebSocket;
the mobile renders a matching pill above the chat input, and can
trigger warm / unload / start actions on the desktop with a tap.
Net effect: a phone user who restarts their machine (or just boots
the desktop) can start Ollama from the phone without needing to
touch the desktop.

## What the user sees

In the chat input area (above the existing TextInput), a small
rounded pill appears when the active companion's primary model
points at a local server (any provider whose baseUrl is
`localhost` or `127.0.0.1` — covers Ollama, LM Studio, llama.cpp
server, vLLM, etc.):

- 🟢 green — model loaded in VRAM, tap **Unload** to free GPU
- 🟡 amber — model not loaded, tap **Warm up** (5-15s)
- 🔴 red — local server down, tap **Start** (spawns `ollama serve`)
- ⚠ orange — model too big for available VRAM (no action; user
  must change the model in Settings → LLM Endpoints on desktop)

The pill is hidden when the active companion uses a cloud API
(Anthropic, GitHub Copilot, MiniMax, etc.) — there's nothing
to start, so showing it would be noise.

## How the pieces fit together

1. **Desktop renderer** — when a chat opens, queries the local
   LLM endpoint and pushes the status to mobile via the
   `sync-broadcast-llm-status` IPC → sync-server `broadcastLlmStatus`.
   Wire format: `{ type: 'llm_status', agentId, model, state,
   baseUrl, providerName, modelId, vram, ts }`.
2. **Sync server** — new `broadcastLlmStatus(status)` method that
   `_broadcast`s the payload to all authenticated WS clients.
   Mobile-initiated actions (`llm_action`) are routed to the
   desktop's `onLlmAction` handler which runs the action and
   re-broadcasts the new status so the phone's pill updates.
3. **Mobile** — new `LlmStatusPill.tsx` component. Subscribes to
   `syncClient.on('llm_status', ...)` to receive state pushes.
   Tap handler calls `syncClient.sendLlmAction(model, action)`,
   which the desktop runs and echoes the result back via the
   same `llm_status` broadcast.

## Files changed

Mobile:
- `src/components/LlmStatusPill.tsx` (new, 220 lines) — the pill
  component. Mirrors the desktop's pill semantics exactly: same
  state names (`running`/`cold`/`down`/`too-big`/`unsupported`),
  same action set (`start`/`warm`/`unload`), same color theme.
  Returns `null` when there's no signal yet or when the active
  companion doesn't use a local model — so the pill is invisible
  when it has nothing useful to say.
- `src/services/SyncClient.ts` — new `sendLlmAction(model, action)`
  public method that fires the WS message, and a new
  `case 'llm_status'` in `_handleMessage` that emits a typed
  event for the pill to consume.
- `src/screens/HomeScreen.tsx` — imports `LlmStatusPill`, adds
  `llmStatus` state, subscribes to the `llm_status` event in
  the existing useEffect, renders the pill above the chat input
  row (not inside it, so the keyboard doesn't shift it), and
  wires the pill's `onAction` callback to `syncClient.sendLlmAction`.

Desktop (paired with CyberClaw v3.3.6 — must ship together):
- `src/sync-server.js` — new `broadcastLlmStatus()` method +
  `case 'llm_action'` in `_handleMessage` that calls
  `this.onLlmAction(model, action, meta)`.
- `src/main.js` — refactored the inline IPC handler bodies into
  reusable `ollamaStatusImpl` / `ollamaWarmImpl` /
  `ollamaUnloadImpl` / `ollamaStartImpl` functions so the
  mobile-initiated `onLlmAction` handler can call them directly.
  New `sync-broadcast-llm-status` and `llm:ollama-action` IPC
  handlers. Renderer calls `broadcastLlmStatusToMobile()` after
  every pill state change.
- `src/preload.js` — exposes `cyberclaw.llm.ollama.action()` and
  `cyberclaw.sync.broadcastLlmStatus()`.

## What this does NOT fix

The actual root cause of "lamasuu doesn't reply" is hardware: an
RTX 2070 with 8GB VRAM cannot run qwen2.5-coder:32b (18.9GB).
The pill detects this (`too-big` state) but cannot fix it — that's
a model-pull + config-change operation (`ollama pull
qwen2.5-coder:7b` + change lamasuu's `model.primary`). The
desktop's `too-big` state surfaces this directly with a hint
pointing the user to Settings → LLM Endpoints.

The mobile `too-big` state is informational-only — we don't
expose a "switch model" action because it's a
deliberate user decision and the model picker lives on desktop.

## Lessons from this round

1. **Cross-cutting sync-server changes need IPC handlers on both
   ends of the bridge.** The desktop already had
   `cyberclaw.llm.ollama.{status,warm,unload,start}` — when adding
   mobile-initiated actions, the right move was to extract the
   handler bodies into named `*Impl` functions and call them
   from both the existing IPC and the new `onLlmAction` callback.
   Trying to call `ipcMain.listeners('llm:ollama-warm')[0]` from
   inside another handler is fragile (depends on listener
   registration order, doesn't survive IPC refactors).

2. **Mobile `case '...'` handlers should emit events, not run
   logic directly.** `SyncClient` is the transport layer; the
   pill component is the UI layer. Having `_handleMessage` just
   re-emit a typed event (like `arena` and `chat` already do)
   keeps the two decoupled and lets future components subscribe
   without touching SyncClient.

3. **The version bump dance on mobile:** package.json, build.gradle
   `versionName`, build.gradle `versionCode`. All three need to
   move together. versionCode is monotonically increasing per
   Play Store upload — bumping from 389 → 390 in the same commit
   as the versionName bump keeps the two in sync. The mobile
   repo convention is annotated tags, so I used `git tag -a` not
   lightweight.

4. **The `llm_status` broadcast payload is intentionally redundant
   with the desktop IPC status response.** Both shapes have
   `{state, model, modelId, baseUrl, providerName, vram}` so the
   mobile component doesn't need a separate adapter. If the
   desktop IPC shape changes, the broadcast needs to change too —
   they're a coupled pair, kept in sync by the same code path
   (`renderLlmPillState` → `broadcastLlmStatusToMobile` → IPC →
   `broadcastLlmStatus`).
