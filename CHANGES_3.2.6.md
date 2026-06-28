# v3.2.6 — recover from dropped WebSocket during wake training

## Bug

After v3.2.5 fixed the "sample not found" wire format, the
trainer successfully sent 6 samples, hit 30% on the progress
bar ("Sending samples to desktop..."), and froze there.
The desktop was actively training on the GPU, but the phone's
WebSocket had dropped — so progress events couldn't reach the
phone, and the final result would be lost.

Tobe saw a frozen 30% bar and a black screen of nothing.

## Fix

Two complementary changes:

**1. Trainer queries for a cached result on mount.**
`OpenWakeWordTrainer` now calls
`sync.requestLatestWakeTrainingResult(companionId)` when it
mounts (in the `idle` state). The desktop caches the most
recent training result per agent for 15 minutes, so if a
previous run completed while the phone was offline, the phone
picks it up automatically — no need to re-record + re-train.

**2. `_onResult` handles the no-result case gracefully.**
The desktop can also respond with `noResult: true` to mean
"nothing in the cache, nothing to do." The trainer treats
that as a no-op and stays on the idle screen instead of
flipping to an error state.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — useEffect on
  mount that queries the desktop; `_onResult` returns early
  on `noResult`
- `src/services/SyncClient.ts` — new
  `requestLatestWakeTrainingResult(agentId)` method
- `package.json` — 3.2.5 → 3.2.6
- `android/app/build.gradle` — versionCode 151 → 152,
  versionName 3.2.6
- `.github/workflows/{build,android-build}.yml` — artifact
  names to 3.2.6

## Desktop counterpart

CyberClaw desktop v3.1.40 added the result cache and the
`get_latest_wake_training_result` WebSocket case.

## Lesson

Long-running jobs on a request/response socket need a polled
status fallback. The training here takes 2-10 minutes — well
beyond the lifetime an Android WebSocket is guaranteed to
hold. The cheap fix is: server caches the last result, client
asks on reconnect. Done.

Mount-time polling is also a good general pattern: any UI
that displays the state of a long-running remote job should
ask for the latest cached state on mount, not just trust
that it was there last time the screen was visible.