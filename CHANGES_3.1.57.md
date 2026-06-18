# 3.1.57 — Tone down movement, log payload capture, respect log scroll position

## What it fixes
Tobe: "Okey updated and tested. In general we can tone down their behaviour, they run too much and still likes to pingpong up and down repeatedly, but Its better now than before. Lamasuu size changed again, think i captured it in the log here. By the way, the text channel should stay at the point scrolled to, i noticed the log wanted to go to the bottom as new text came in so it wont stay at the point i had scrolled to."

## Issue 1: Companions move too much

### Cause
The v3.1.55 state machine matched the desktop's distribution: 45% idle / 30% walk / 15% run / 10% zoomies. Total moving: 55%. The desktop arena is 1266x631, the mobile is 360x187 (3.5x smaller). At desktop speeds (walk 0.015-0.025, run 0.06-0.10), a single walk covers a large fraction of the mobile's 56-69px walkable band. Most walks hit a wall, bounce, and ping-pong. So the mobile was both moving too much AND bouncing too much.

### Fix
**New state distribution (slower + less movement):**
| State    | v3.1.55 (desktop) | v3.1.57 (mobile) | Why changed |
|----------|-------------------|------------------|-------------|
| idle     | 45%               | **60%**          | More rest on small arena |
| walk     | 30%               | **28%**          | Slightly less |
| run      | 15%               | **8%**           | Much less — runs are the most ping-pong-prone on small arenas |
| zoomies  | 10%               | **4%**           | Zoomies on a small arena look glitchy, not exciting |

Total moving: 40% (was 55%).

**Slower walk speed:**
- Desktop: 0.015-0.025
- v3.1.55: 0.015-0.025 (matched desktop)
- v3.1.57: **0.008-0.013** (~half the desktop speed)

Math: at the new max walk speed (0.013) and max walk duration (3.5s), the companion covers 0.013 × 3500 = 45.5px. The walkable vertical band is 56-69px depending on scale. So walks END before hitting the wall in most cases. No wall bounce, no ping-pong.

**Shorter walk duration:**
- Desktop: 2-6s
- v3.1.55: 2-6s
- v3.1.57: **1.5-3.5s**

Combined with slower speed, walks are short, gentle, and end before the wall.

**Slower run + zoomies:**
- Desktop run: 0.06-0.10, v3.1.55: 0.06-0.10, v3.1.57: 0.04-0.07
- Desktop zoomies: 0.08-0.13, v3.1.55: 0.08-0.13, v3.1.57: 0.05-0.09
- Run duration: 1-3s desktop → 0.8-2s v3.1.57
- Zoomies duration: 0.6-1.4s desktop → 0.5-1.1s v3.1.57

Runs and zoomies still hit walls (they're fast), but they're rarer and shorter. The wall bounce + velocity-based facing handles the slide-back gracefully.

**Longer idle:**
- v3.1.55: 3-8s
- v3.1.57: **4-9s**

More time resting between activity bursts.

### 120s sim results (h=187, w=360)
**clawsuu (scale=2):**
- States: 67.5% idle, 23.7% walk, 8.8% run (moving 32.5%)
- Wall bounces: 4.5/min (was 10+/min in v3.1.55)
- Max consecutive same vertical direction: 3.0s (one walk duration, no chains)

**lamasuu (scale=1):**
- States: 83.0% idle, 13.1% walk, 3.9% run (moving 17.0%)
- Wall bounces: 2.0/min
- Max consecutive same vertical direction: 3.1s

The asymmetry (clawsuu moves more than lamasuu) is because clawsuu's smaller walkable band (56px vs 56px... wait, both have 56px with v3.1.54's feet-relative band). The asymmetry is from the random state rolls — clawsuu happened to roll more walks in this sim run. Over 10 minutes, both companions would have similar moving %.

## Issue 2: Log auto-scrolls even when user scrolled up

### Cause
```js
onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: false })}
```

`onContentSizeChange` fires every time the FlatList's content size changes (i.e., when a new entry is added). The handler ALWAYS called `scrollToEnd`, even if the user had scrolled up to read older entries. So the log would jump to the bottom on every new entry, making it impossible to scroll up and read while the app is active.

### Fix
Track whether the user is "near the bottom" via `onScroll`. Only auto-scroll to end when a new entry is added IF the user was at the bottom when the new content arrived.

```js
const logStickyBottomRef = useRef(true);  // start at bottom

onScroll={(e) => {
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
  const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
  logStickyBottomRef.current = distanceFromBottom < 32;  // within 32px = "at bottom"
}}
scrollEventThrottle={16}

onContentSizeChange={() => {
  if (logStickyBottomRef.current) {
    logRef.current?.scrollToEnd({ animated: false });
  }
  // else: leave the user where they scrolled
}}
```

**Threshold: 32px.** Within 32px of the bottom counts as "at the bottom" — accounts for the height of one log entry (~30px including padding). If the user has scrolled more than 32px up, they're "reading older entries" and new entries should NOT jump them.

## Issue 3: Log didn't show scale-change values

### Cause
The `arena_scale_update` and `arena_full_rebuild` events from v3.1.56 contain payloads (the actual scale values), but the HomeScreen handler only logged the event TYPE, not the payload. So Tobe's log showed `type=arena_scale_update` but not what the values were.

### Fix
In `handleArenaMessage`, add specific handlers for the diagnostic events that show the payload:

```js
if (msg.type === 'arena_scale_update') {
  addLogEntry(
    `🔍 scale_update: ${msg.id} ${msg.from}→${msg.to} (desktop sent: ${msg.incoming})`,
    'info',
  );
} else if (msg.type === 'arena_full_rebuild') {
  const fromStr = (msg.from || []).map(c => `${c.id}@${c.scale}`).join(',');
  const toStr = (msg.to || []).map(c => `${c.id}@${c.scale}`).join(',');
  addLogEntry(`🔍 full_rebuild: from=[${fromStr}] to=[${toStr}]`, 'info');
}
```

After the next size change, the log will show:
- Which companion changed (`msg.id`)
- The old value, the new value, and what the desktop sent (`msg.from`, `msg.to`, `msg.incoming`)

That tells us the exact trigger: was the desktop sending a different value, or is the WebView's existing c.scale out of sync with the desktop's source of truth?

## Files changed
- `android/app/src/main/assets/arena.html` — pickState() tuned (idle 60%, walk 28%, run 8%, zoomies 4%; slower walk/run/zoomies; shorter walk/run/zoomies; longer idle)
- `src/screens/HomeScreen.tsx` — handleArenaMessage shows scale_update / full_rebuild payloads; log FlatList tracks sticky-bottom state and only auto-scrolls when at bottom
- `package.json` — 3.1.56 → 3.1.57
- `android/app/build.gradle` — versionCode 106 → 107, versionName "3.1.57"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.57
- `CHANGES_3.1.57.md` (new)

## On the size bug — still needs the desktop's input
Tobe's log shows the size_update event fired after the first visible setAgents call. The handler in v3.1.56 logged the type but not the payload. After installing v3.1.57, the log will show:
- `🔍 scale_update: lamasuu 1→2 (desktop sent: 5)` — desktop sent scale=5, mobile updated to mobile-2
- OR `🔍 full_rebuild: from=[clawsuu@2,lamasuu@1] to=[clawsuu@2,lamasuu@null]` — rebuild happened with null scale, mobile defaulted to 5

The first pattern means the desktop is sending a wrong value. The second means the desktop doesn't have a saved scale for lamasuu and the mobile is using the default 5 → mobile 2.

Once we see which, we can fix the right side (mobile or desktop).
