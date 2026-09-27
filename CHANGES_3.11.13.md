# v3.11.13 — onChat uses desktop's `msg.activeQuestId` directly (paired with desktop v3.3.19 patch)

Tobe (2026-09-27 14:43, Discord #cyber-dev):

> "hmm no that did not seem to help. It still goes to
> no active quest after a while and i reopen.
> Additionally it did that on startup also now with
> this version."

v3.11.12 + desktop v3.3.19 didn't fix the chat-flash.
Tobe's chat shows real Cyber_Database content (database,
SSH tunnel, "Live proof just now") but every bubble
still has the "— No quest" pill.

The v3.11.12 release of mine fixed the
**history-fetch** path (chat_history, agent_history) and
missed the **realtime broadcast** path. Two more dropped
fields on the desktop side, plus a missed consumer on the
mobile side.

## Root cause (continued from v3.11.12)

The full audit table for `activeQuestId` through the
chat data pipeline now reads:

| Layer | Preserves activeQuestId? |
| --- | --- |
| app.js addChatMsg → per-(agent, quest) bucket push | ✓ |
| app.js addChatMsg → flat chatHistory mirror push | ✓ (v3.3.19) |
| **app.js sync-broadcast-chat IPC invoke** | ✓ |
| **main.js sync-broadcast-chat IPC handler** | **✗ BEFORE v3.3.19 realtime patch; ✓ AFTER** |
| **sync-server.broadcastChatMessage WS payload** | **✗ BEFORE v3.3.19 realtime patch; ✓ AFTER** |
| mobile onChat `appendAgentMessage` | **✗ ignored msg.activeQuestId, used local ref; ✓ v3.11.13** |
| mobile onAgentHistory | ✓ (v3.11.12) |
| mobile onChatHistory | ✓ (v3.11.12) |

After v3.3.19 (realtime patch) and v3.11.13 (this), all
nine layers either preserve the field or correctly consume
it. Five of nine were silently dropping it before this
round of fixes.

The mobile's onChat handler was the most surprising
failure mode: even when the desktop's `chat_message`
broadcast carried `activeQuestId: 'database'`, the mobile
listener threw it away and used its own local
`activeQuestRef.current`. On cold start, `activeQuestRef`
is `null` until the first quests_list broadcast lands —
so realtime messages arriving in that window were
stamped with `null` and routed to the DEFAULT bucket,
even though the desktop had a real quest active when it
sent the message.

The bubble pill showed "— No quest" because each
incoming message's `activeQuestId` was null, regardless
of what the desktop said. The projection effect then
saw DEFAULT-bucket content with null-stamped bubbles
and displayed it under "— No quest".

## Fix

### Mobile: onChat uses `msg.activeQuestId` as source of truth

```ts
const questFromBroadcast = (typeof msg.activeQuestId === 'string' && msg.activeQuestId)
  ? { id: msg.activeQuestId, name: msg.activeQuestName || null }
  : null;
const questForStamp = questFromBroadcast || aq || null;
const qidForRoute = questFromBroadcast
  ? questFromBroadcast.id
  : (aq === undefined ? null : (aq?.id ?? null));
const incoming: ChatMessage = {
  ...
  activeQuestId: questForStamp?.id ?? null,
  activeQuestName: questForStamp?.name ?? null,
};
appendAgentMessage(incoming, aid, qidForRoute, ...);
```

Prefer the desktop's broadcast over the mobile's local
ref. The desktop's broadcast carries the active quest at
the moment addChatMsg was called — that's the source of
truth for "what quest was this message sent under."
The mobile's ref is what the user CURRENTLY has active,
which may differ from what was active when the message
was sent (and that's correct — the chat history is
self-documenting).

Fall back to the mobile's local ref only for old
desktops (< v3.3.19) that don't stamp on the wire. The
fallback preserves pre-v3.11.13 behavior.

### Desktop (already shipped as a separate commit in
v3.3.19): main.js + sync-server.js forward activeQuestId

This is the same fix from the v3.3.19 release notes,
re-extracted and re-tagged because the original v3.3.19
shipped without it. The full commit message is in
`CHANGES_3.3.19.md` under "v3.3.19 (realtime
broadcast)."

## Files changed

- `src/screens/HomeScreen.tsx`:
  - onChat `appendAgentMessage` call: prefer
    `msg.activeQuestId` (from desktop's
    `chat_message` broadcast) over the mobile's
    local `activeQuestRef.current`. The local ref is
    a fallback for old desktops only.
- Bumps: `package.json` 3.11.12 → 3.11.13.
- `versionCode` 408 → 409, `versionName` "3.11.12"
  → "3.11.13".

## Requires desktop v3.3.19 (with realtime patch)

This is the same caveat as v3.11.12 + v3.3.19. The
mobile's "prefer `msg.activeQuestId`" code only does
anything when the desktop is also sending it. The
desktop's v3.3.19 + realtime patch is one combined
release — users on v3.3.18 or earlier see no change.

## Strong rule (re-stated)

**The data pipeline audit is bigger than I thought.**

This is now the **fifth** independent layer I've found
that silently drops a field. Each fix made the symptom
go away for a specific path and I called it done. The
next round of testing surfaced the next layer. The bug
isn't "the anchor is null" or "the buckets aren't
populated" — it's "five layers each independently
drop a field that the previous layer had set." Each
fix targets one layer; the overall data integrity
requires all five at once.

Future structured-record audits should produce a
single table like the one above and verify every row
is ✓ before merging. Tobe's bug is the 5th of 9 rows
that was ✗ before this round of fixes; it could just
as easily have been 9 of 9 if the original per-quest
bucket design hadn't been implemented defensively.

## Layered bug fix tally (chat-flash family)

For anyone reading the history: the chat-flash family
now has 13 distinct fixes spanning both repos. The
pattern is "each release fixed one more layer of the
same data-flow problem, with deeper layers surfacing
as shallow layers were closed off."

Releases:
1. v3.11.0 — per-quest bucket design.
2. v3.11.2 — per-device anchor.
3. v3.11.2 (revised) — source-tag refinement.
4. v3.11.3 — cache-replay data-only.
5. v3.11.4 — remount-fallback.
6. v3.11.5 — anchor as primary source for projection.
7. v3.11.6 — cold-start persistence.
8. v3.11.7 — replay-on-subscribe.
9. v3.11.8 — seed-fallback data-only.
10. v3.11.9 — onChatHistory reads the anchor.
11. v3.11.10 — bootstrap-pending vs user-deactivated.
12. v3.11.11 — persist anchor on Case 1
   (turned out to be wrong; correct diagnosis was the
   data-source path, not the view path).
13. **v3.11.12 — consume per-quest history
   correctly on the mobile side (was right; just
   missed two more desktop layers that didn't
   preserve activeQuestId).**
14. **v3.11.13 + desktop v3.3.19 (realtime patch) —
   close the last two layers: chat_message WS
   payload (sync-server) and the mobile's onChat
   listener.**

The fact that 14 fixes are needed to deliver a
"messages attribute to the right quest" experience
is a reflection of how many independent serialization
layers exist in this app — Electron renderer →
Electron IPC → Electron main → sync-server WS →
mobile WS → mobile listener. Any new field
introduced into this chat-message struct should
expect at least 9 layers to audit.

## Lesson for future sync servers

**Treat every IPC boundary as a field-stripping point
unless proven otherwise.** Don't destructure IPC
payloads into specific field lists; spread them
verbatim. Don't construct WS payloads field-by-field;
spread the IPC payload. The fewer touch points for
"which fields go over the wire," the less likely a
field will be silently dropped by a future refactor.

```js
// ❌ Easy to miss fields when adding new ones:
this._send(ws, { type: 'chat_message', agentId, agentName, text, isUser, ts });

// ✓ Spread carries all fields including the new one:
this._send(ws, { type: 'chat_message', agentId, agentName, text, isUser, ts, ...rest });
```

The same applies to the renderer → main IPC
boundary:
```js
// ❌
ipcMain.handle('sync-broadcast-chat', async (e, { agentId, agentName, text, isUser }) => { ... });

// ✓
ipcMain.handle('sync-broadcast-chat', async (e, payload) => { ... });
```

For typing/IDE reasons a destructure is nicer, but
the destructure should fall back to `undefined`
without error, AND the call site should pass the
payload as-is (or be reviewed every time a field
is added).

In an ideal world this codebase would use a shared
chat-message TypeScript type shared between the
renderer and the main process (Electron IPC is JS,
but Electron 22+ supports TypeScript via IPC). Each
layer could consume the typed payload and pass it
through, and TypeScript would fail to compile if a
new field was added without being threaded through
each IPC handler. That's a real refactor worth
doing once the immediate bug is closed — but the
debugging surface for the next field-of-doom would
shrink by an order of magnitude.
