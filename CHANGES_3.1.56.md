# 3.1.56 — Idle keeps last direction + scale-change logging + position reclamp

## What it fixes
Tobe: "Okey they behave pretty good now. Except that they never idle in other directions than facing the screen. It should just be random walks and randomly directed idling and running."

And: "I noticed a size bug. Lamasuu started out and was the same size for perhaps a minute. Then suddenly it turned big, perhaps twice as big. He was positioned as far right as possible at the time, not sure if that has anything to do with it."

## Bug 1: Idle always faces the screen

### Cause
`pickState()`'s idle branch set `c.direction = 0` (down, facing camera) explicitly. The desktop's `src/js/pixel-arena.js` ~line 825 does NOT set `comp.direction` in its idle branch — it only sets state, vx, vy, stateTimer. The direction stays at whatever it was facing when the state rolled to idle.

The mobile's `c.direction = 0` was a leftover from earlier debugging that survived through every state machine iteration. Result: every time a walk/run ended and the state rolled to idle, the companion was force-flipped to face camera. Tobe: "never idle in other directions than facing the screen."

### Fix
Remove the `c.direction = 0` line from the idle branch. The companion now keeps its last direction when it goes idle. The velocity-based facing in `update()` won't fire while idle (vx=vy=0), so `c.direction` stays at its last value. Idle now happens in all 4 directions, matching the desktop.

## Bug 2: Lamasuu size grows from 1 to 2 mid-session

### Cause (hypothesis)
The `setAgents()` update path allows the desktop to change `c.scale` after the initial build. The mobile logs what the desktop sends but doesn't log the changes themselves. Without logs, the trigger is invisible — could be a forge save, a stale agents_list cache replay, or a sync-server race condition.

The visible effect: the sprite grows from 32px to 64px (2x). This is the "twice as big" Tobe reported. The "as far right as possible" position is the i=1 layout position (x ≈ 2/3 of canvas width), which is where lamasuu starts. The sprite stays anchored at the top-left (`c.x` / `c.y`), so when it grows, it extends both left and right of its previous bounding box.

### Fix
1. **Log every scale change** in the update path. When `newScale !== c.scale`, log to console and emit `notifyRN({ type: 'arena_scale_update', id, from, to, incoming })`. This makes the trigger visible — check the mobile's log tab after the next size jump.
2. **Log every full rebuild**. When the IDs differ and the companion array is replaced, log the old vs new (with scales). This catches the case where the desktop sends a list that forces a rebuild with different scale values.
3. **Re-clamp position to the new band**. The bounce bounds depend on `c.scale` (feet-relative band, v3.1.54). If scale changes mid-walk, the next `update()` will clamp the position, but the visual jump is jarring. Clamp `c.x` / `c.y` in the update path so the transition is immediate and smooth.

## Diagnostic use
After the next time lamasuu "turns big":
1. Open the mobile's log tab
2. Look for `arena_scale_update` events — they show `{id, from, to, incoming}` so you can see what value the desktop sent
3. Or look for `arena_full_rebuild` events — they show the old vs new companion arrays

If the log shows `incoming: 5` (or another large number) at the time of the size jump, the desktop is sending a larger scale value. Check the desktop's `getSpriteConfig(lamasuu)` to see what scale it returns.

If the log shows `arena_full_rebuild` and the new list has `scale: null` for lamasuu, the desktop doesn't have a saved scale and the mobile is using the default 5 → mobile 2. Fix by saving lamasuu's scale in the desktop forge.

If the log is empty at the time of the size jump, the bug is elsewhere — possibly the WebView reloading (e.g., on screen rotation, app backgrounding).

## Files changed
- `android/app/src/main/assets/arena.html` — removed `c.direction = 0` from idle branch, added scale-change logging, added full-rebuild logging, added position reclamp on scale update
- `package.json` — 3.1.55 → 3.1.56
- `android/app/build.gradle` — versionCode 105 → 106, versionName "3.1.56"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.56
- `CHANGES_3.1.56.md` (new)

## On the size bug — possible root causes
1. **User changed the scale in the desktop forge** mid-session. The forge's `saveCompanion` calls `broadcastAgentsListToMobile()` (line 2673 of src/js/app.js), which sends the new scale to the mobile. If Tobe changed lamasuu from 3 to 5 (for example) in the forge, the mobile would update from 1 to 2. The "for perhaps a minute" delay would be the time between app start and the forge save.

2. **Stale cache replay**. The sync server caches the last `agents_list` payload. If a different agent was active when the cache was set, the cached list might have different scales. On reconnect, the cache is replayed and the mobile gets a new list. The `sameSet` check catches this case (same IDs, different scales → in-place update path) and the new logging will show it.

3. **Race between initial broadcast and reconnect**. The renderer's initial `broadcastAgentsListToMobile()` (line 314 of src/js/app.js) happens after `loadAgents()` finishes, but the sync server's cache might be empty at that point. The mobile connects, requests a refresh, gets the cache (empty), then later gets the actual broadcast. Both calls are processed by the mobile's `setAgents()` and the second one (with the real scales) triggers a rebuild.

   The new `arena_full_rebuild` log will catch this case. If the second list has the same IDs but the scales change, it's a race; if the IDs change, it's something else.

Without more data (Tobe's logs), the fix is to **make the trigger visible**. After the next size jump, the log tab will tell us which of these is the cause.
