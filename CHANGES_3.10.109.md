# v3.10.109 — Buffer outgoing messages across WS reconnects

**What changed:** `SyncClient.send()` no longer silently
drops messages when the WebSocket is between
`CONNECTING` and `OPEN`. Messages are now buffered in
`_sendBuffer` (capped at 50) and flushed immediately
after the auth round-trip completes (`setState
'connected'` fires after the `pair_result` or
`auth_result` ack).

**Why:** Tobe's 2026-07-29 15:51 report: "now i dont
get any clawsuu is thinking, nor reply". The screenshot
showed two user bubbles on the mobile ("Sup" at 15:48
PM and "Hey" at 15:49 PM) but the desktop log had
neither. The desktop logged 9 separate `Mobile
requested full state` (reconnect) events in the
preceding minutes, with no chat messages arriving in
between.

**The bug.** Before this fix, `send()` did:
```ts
if (this.ws && this.ws.readyState === WebSocket.OPEN) {
  this.ws.send(JSON.stringify(obj));
} else {
  console.warn(`Dropped '${obj.type}'`);
}
```
On every WS reconnect (which fires every few seconds
when the desktop's mid-pipeline IPC wedge clears,
per v3.2.37), `this.ws.readyState` cycles through
`CONNECTING` (0) → OPEN (1). Between the
`onopen` event and the `auth_result` ack from
the desktop, the WS is OPEN but `_authenticated ===
false`. After, anything fired during the
`CONNECTING` window (the ~50-200ms between
`onclose` and `onopen`) was **dropped** — only
`console.warn`, not visible to the user in the Log
tab, and not retrievable.

Critically, the SyncClient's `get connected() { return
this._state === 'connected' || this._state === 'reconnecting'; }`
treats `reconnecting` as connected, so the UI's green
dot stayed up, the user pressed Send thinking the
message would go through, and it silently vanished.

**The fix.** Three changes in `SyncClient.ts`:
1. `_sendBuffer: any[]` field with `_maxBufferSize = 50`.
2. `_attemptSend(obj)` — the actual send-or-drop
   helper that knows the WS is currently OPEN.
3. `send(obj)` — when WS isn't OPEN, buffer the
   message (for non-ping types) instead of dropping.
4. `_flushSendBuffer()` — drains the buffer, called
   from `pair_result` and `auth_result` handlers
   right after `setState('connected')` fires.

The buffer is bounded at 50 messages to cap memory if
the desktop is permanently unreachable. Beyond 50, the
old `console.warn + send_error emit` behavior kicks in
so the user still sees the problem in the Log tab.

**Side effect of the fix.** Any chat / attachment /
tool message fires during a reconnect cycle now
flushed within ~50ms of auth completing, instead of
being silently dropped. The user's local bubble
appears immediately (unchanged behavior from the
existing `appendAgentMessage` line), but the actual
delivery to the desktop is now deferred to the next
stable WS window. This means **the user might notice
their message takes 1-2 seconds longer to get a
reply** during reconnect cycles — but the reply WILL
come. Tobe can confirm by typing "test" and watching
the desktop log; the message should land within a
second even during a reconnect storm.

**Where:**
- `src/services/SyncClient.ts`: new `_sendBuffer`,
  `_flushSendBuffer`, `_attemptSend`; `send()` now
  buffers instead of dropping; `pair_result` /
  `auth_result` handlers flush.

**Was NOT changed (because out of scope):**
The visual feedback for "your message is buffered,
waiting for connection" — currently the user sees no
indication that a message is mid-flight to the
desktop. If this is annoying, v3.10.110+ can add a
"queued" badge on the local bubble.

versionCode: 333
