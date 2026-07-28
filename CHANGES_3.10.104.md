# v3.10.104 — Companion soul + memory viewer on Personalize

## Overview

The mobile's Personalize screen (reached via the ✏️ Edit /
Personalize card in Companion Settings) now shows the
companion's soul.md and memory.md as read-only panels, plus
a Clear Memory button. The desktop remains the source of
truth — the soul editor and presets are desktop-only. The
mobile just mirrors the file content so the user can see
what their companion is "made of" without opening the
desktop.

## What's new

### 1. `src/services/SyncClient.ts` — three new wire calls

- `requestCompanionSoul(agentId)` → sends `{ type: 'read_companion_soul', agentId }`
- `requestCompanionMemory(agentId)` → sends `{ type: 'read_companion_memory', agentId }`
- `clearCompanionMemory(agentId)` → sends `{ type: 'clear_companion_memory', agentId }`

Three new inbound cases in `onmessage`:
- `companion_soul` → emits `'companion_soul'` event with the full payload
- `companion_memory` → emits `'companion_memory'` event
- `companion_memory_cleared` → emits `'companion_memory_cleared'` event (used by the viewer to refresh + show "Memory cleared" toast)

### 2. `src/screens/CompanionEditScreen.tsx` — two new Sections

- **📜 Soul (read-only)** — appears after the Behaviour Traits section. Loads on mount, shows the soul.md content as monospace text in a `#0a0a1a` panel matching the desktop forge's textarea. Hint: "Character definition for {companion}. Edit on the desktop Companion Forge."
- **🧠 Memory (read-only)** — same panel pattern. Loads on mount. Hint: "Auto-written by {companion} on the desktop. Clear to start fresh." Below the panel: a destructive 🗑 Clear Memory button. Tapping it shows an Alert.alert confirm (matches the rest of the app's destructive-action pattern); on confirm, the screen sends `clear_companion_memory` and waits for the ack to refresh + toast.

State management:
- `soulContent`, `soulLoading` (defaults to `true`; flips on the first `companion_soul` event)
- `memoryContent`, `memoryLoading` (same pattern)
- `clearingMemory` (button spinner + double-tap guard)

Event listeners subscribe on mount and unsubscribe on unmount (mirrors the existing `sprite_config_sync_ok` / `sprite_config_sync_failed` pattern).

## Patterns and lessons

- **Read-only mobile, writable desktop.** Soul editor stays on the desktop because: (a) the desktop forge has presets + Apply preset button, (b) the desktop is where the chat pipeline actually runs (so memory gets auto-written there too), (c) the soul is the character definition — a single source of truth is cleaner than bi-directional sync for a file the user rarely touches on mobile.
- **Destructive action confirm is non-negotiable.** Clear Memory wipes everything the companion has remembered. The Alert.alert confirm is the same pattern as Delete Quest from the QuestsScreen — one tap is too easy to lose context.
- **Filter events by agentId in the listener.** The desktop broadcasts companion_* responses to the whole WS, but our screen is only interested in the active companionId. The `if (msg?.agentId !== companionId) return;` guard keeps other companions' responses from updating our viewer.
- **Loading state defaults to true.** The viewer shows "Loading from desktop…" until the first response arrives, so the user gets immediate feedback that something is happening. Otherwise the empty-state copy ("companion has not remembered anything yet") would flash before the response arrives.

## Files changed

- `src/services/SyncClient.ts` (+~50 lines: 3 new methods + 3 new inbound cases)
- `src/screens/CompanionEditScreen.tsx` (+~120 lines: 2 new state fields × 3, soul/memory useEffect, onClearMemory callback, 2 new Section blocks, 5 new style entries)
- `package.json` 3.10.103 → 3.10.104
- `android/app/build.gradle` versionCode 327 → 328

## Deployment

Requires desktop v3.2.35. If the mobile connects to an older
desktop, the desktop responds with `{ ok: false, error:
'Desktop does not support companion soul yet' }` and the
mobile shows "(error: …)" in the viewer panel (graceful
degradation rather than a crash).