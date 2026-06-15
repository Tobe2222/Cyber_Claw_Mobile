# v3.1.21 — Agents list delivery: log the dropped sends + auto-request on auth

## The problem

v3.1.20 confirmed the bar **renders** correctly (decoupling worked — we
could see the "🐾 Clawsuu" fallback tab on the device). The bar just
stayed on the fallback, which meant the `agents` state on the mobile
was never populated.

v3.1.20 also added a 5x retry of `requestAgentsList()` on HomeScreen
mount and on every reconnect, plus AsyncStorage caching. Still no
agents list. So either:

- The `request_state` message was being sent but never reaching the
  desktop, or
- It was reaching the desktop but the desktop's `_sendFullState` reply
  was being lost, or
- The reply was arriving but the mobile's `onAgentsList` listener
  wasn't registered yet, or
- The listener was registered but `setAgents` wasn't actually
  updating state.

We couldn't tell from the device, and the desktop log only showed
the broadcast at boot, no `Mobile requested full state` line.

## v3.1.21 — make the failure mode visible + close the timing gap

Two small changes that, together, both **fix the most likely root
cause** and **guarantee the next failure is observable**.

### 1. `SyncClient.send()` warns on dropped messages (diagnostic)

Before:
```ts
private send(obj: any) {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    try { this.ws.send(JSON.stringify(obj)); }
    catch (e: any) { this.emit('send_error', { type: obj.type, reason: e?.message }); }
  }
  // else: silently drop. No log. No way to know.
}
```

After:
```ts
private send(obj: any) {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    try { this.ws.send(JSON.stringify(obj)); }
    catch (e: any) { this.emit('send_error', { type: obj.type, reason: e?.message }); }
  } else {
    // v3.1.21: visible diagnostic. State 0=CONNECTING, 1=OPEN,
    // 2=CLOSING, 3=CLOSED.
    if (obj.type && obj.type !== 'ping') {
      const state = this.ws ? this.ws.readyState : 'no-ws';
      console.warn(`[SyncClient] Dropped '${obj.type}' — WS not open (readyState=${state}, state=${this._state})`);
    }
  }
}
```

Now when a message is dropped because the WS isn't open, we get a
`console.warn` with the message type, the WebSocket readyState, and
the SyncClient's logical state. The Log tab surfaces
`console.warn`/`console.error` as `debug`/`error` entries, so we'll
see exactly which messages aren't getting through.

### 2. `SyncClient.auth_result` also requests the agents list

Before: on successful auth, we auto-requested chat history (300ms
delay) but **not** the agents list. The agents list was only
requested by the HomeScreen mount useEffect (with its 5x retry) and
on every reconnect. The mount useEffect's retry capped at 4 seconds,
which is barely enough for a slow first connect.

After:
```ts
// Auto-request chat history from desktop
setTimeout(() => this.requestChatHistory(), 300);
// v3.1.21: Also request the agents list on every successful auth.
setTimeout(() => this.requestAgentsList(), 400);
```

This guarantees that **every** auth success — first connect, every
reconnect, every resume — triggers a `request_state` from the
mobile. The desktop's `_sendFullState()` replies with the cached
agents list (and any recent chat/audio). No more dependence on
HomeScreen mount timing.

## What this should fix

If the agents list was failing because the request was silently
dropped (WS not open), Fix 1 makes it visible. If it was failing
because the request was simply never sent, Fix 2 closes that gap.
Combined, the bar should populate with both companions in normal
use.

## What this still doesn't fix (deliberately)

- The desktop's `request_state_from_main` IPC ping is still a no-op
  in the renderer (no `ipcRenderer.on('request_state_from_main', ...)`
  handler). That's a pre-existing design hole — the renderer was
  supposed to respond by re-emitting the current state, but the
  wire got cut at some point. Fixing it requires desktop changes
  which are out of scope for v3.1.21. The cache replay in
  `_sendFullState` covers the agents list regardless, so it's not
  blocking the tab bar.

## Files

- `src/services/SyncClient.ts`
