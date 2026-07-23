# v3.10.91 — mobile activity heartbeat so companions stay awake while user is engaged

Tobe reported on v3.10.90 (2026-07-23 23:28):

> "@Clawsuu also. The companions should sleep on the
> mobile also like they do on desktop. And wake up
> when engaded with"

## What was there before

- The desktop had `scheduleAutoSleep()` (v3.1.4) that
  flips sleepState to 'sleeping' after 12 min of
  inactivity (`AUTO_SLEEP_AFTER_MS`).
- The mobile READS sleepState from the desktop's
  agents_list broadcast and renders the sleeping
  visual (v3.10.43: opacity dim + "💤 sleeping" overlay).
- The mobile could SEND wake requests (`sendWakeAgent`)
  on chat submit and voice mode entry.

What's missing:
- A mobile-only user (just viewing chat, no sending
  / no voice / no treats) had their companion fall
  asleep after 12 min, even though they were actively
  engaged with the chat on mobile. The desktop's
  `lastInteractionTs` only bumped on actual desktop-side
  or chat-submit events, not passive viewing.

## Fix

Mobile-side activity heartbeat. Every 30s while the
chat tab is open + app is foregrounded + WS is
connected, the mobile sends `mobile_activity_ping` to
the desktop. The desktop bumps `lastInteractionTs` on
the active companion via the existing
`bumpCompanionInteraction()` function.

### New SyncClient method

```ts
sendActivityPing(agentId: string = 'companion') {
  this.send({ type: 'mobile_activity_ping', agentId });
}
```

### New useEffect in HomeScreen.tsx

```ts
const activityPingRef = useRef<ReturnType<typeof setInterval> | null>(null);
useEffect(() => {
  const tick = () => {
    try {
      if (
        activeTabRef.current === 'chat' &&
        appStateRef.current === 'active' &&
        isConnected
      ) {
        syncClient.sendActivityPing(activeChatAgentIdRef.current || 'companion');
      }
    } catch (_) {}
  };
  if (activityPingRef.current) clearInterval(activityPingRef.current);
  activityPingRef.current = setInterval(tick, 30 * 1000);
  tick(); // immediate ping on connect / tab change
  return () => { /* cleanup */ };
}, [isConnected, activeTab]);
```

Three conditions gate the ping:
- `activeTab === 'chat'` — user is viewing chat (not
  Events / Log)
- `appState === 'active'` — app is foregrounded
- `isConnected` — WS is open

If all three hold, ping every 30s. Otherwise skip.

## Desktop-side changes (v3.2.24)

- `sync-server.js`: `case 'mobile_activity_ping'`
  handler added
- `main.js`: `onMobileActivityPing` SyncServer callback
  forwards to renderer via `mobile-activity-ping` IPC
- `app.js`: `ipcRenderer.on('mobile-activity-ping', ...)`
  handler calls `bumpCompanionInteraction(id)` on the
  targeted agent

## Why ping doesn't wake a sleeping companion

The ping is for "I'm still here, don't auto-sleep me."
It only resets the timer; it doesn't flip sleepState.
Waking a sleeping companion requires actual engagement
(chat / voice / treat / explicit wake button). Passive
viewing shouldn't have side effects.

If the companion is ALREADY sleeping when the user
opens the chat on mobile, the ping won't wake it. The
user has to send a message (or use the wake button)
to wake it. This is intentional.

## Files changed

- `src/services/SyncClient.ts`:
  - Added `sendActivityPing(agentId)` method
- `src/screens/HomeScreen.tsx`:
  - New `activityPingRef` + useEffect that runs the
    30s ping loop with three-condition gate
- `package.json` — version 3.10.90 → 3.10.91
- `android/app/build.gradle` — versionCode 314→315

## Lessons

**Asymmetric platforms need symmetric state.** The
desktop tracks activity via its own events. The
mobile has its own events. `lastInteractionTs` is a
SHARED state but only updated by desktop-side +
chat-submit events. A mobile-only engagement pattern
(read chat, don't send) didn't fit. The heartbeat
closes the gap.

**Ping intervals are budgets.** 30s × 24 = 12 min
budget — at the edge but still safe given the
desktop's auto-sleep check runs every minute. Don't
ping less than ~1/12 of the auto-sleep window.

**Reset timers don't wake things.** Tempting to have
the ping also flip sleepState to 'awake' (so opening
the chat wakes a sleeping companion). But that's a
side effect — passive viewing shouldn't have side
effects. The ping only delays auto-sleep; it doesn't
override it.

**Three-condition gates reduce false positives.**
Gating on three conditions (activeTab, appState,
isConnected) means the ping fires only when the user
is actually looking at chat on a foregrounded mobile
with a live WS connection. False positives (wasting
battery pinging when user is on the Events tab or in
another app) are eliminated.