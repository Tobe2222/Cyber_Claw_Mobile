# 3.1.61 — Voice mode actually disables wake listener, idle animates, bigger companion

## What it fixes
Tobe: "Okey wake mode looks like this now. Companion should be perhaps 1.75 times bigger and have the idle animations. Voice mode seems to be confused again thinking its wake mode according to its texts."

Three issues from the screenshots:
1. **Voice mode still shows "Listening for wake word..."** — the `voiceMode` prop wasn't actually disabling the wake listener. v3.1.60 added the prop to App.tsx and HomeScreen.tsx wiring, but the v3.1.60 edits to WakeModeScreen.tsx (early return in wake listener, initial state values, prop addition) were LOST in a failed multi-edit batch. Only the URL and voice status text changes made it to the commit.
2. **Companion is frozen on the first frame of idle** — v3.1.60 set `c.frame = 0` to "hold the first frame of idle", but that actually stops the animation. Need to let the idle animation cycle naturally.
3. **Companion should be 1.75x bigger** — current scale 6 (192px). 1.75x linear = scale 10 (320px).

## Bug 1: voice mode still shows wake UI

### Cause
v3.1.60 attempted to add a `voiceMode?: boolean` prop to WakeModeScreen and use it to:
- Early-return from the wake listener useEffect
- Set initial `voiceStatus` to `'ready'`
- Set initial `voiceLogs` to `['🎙️ Voice Mode ready']`

But the multi-edit batch had a validation error and the edits were not all applied. Only the URL change and voice status text update made it to the commit. The prop addition and the early return in the wake listener were missing — so when `voiceMode={true}` was passed from App.tsx, the WakeModeScreen component still started the wake listener and showed the wake UI.

### Fix
Re-applied the v3.1.60 edits that were lost:

```ts
interface WakeModeScreenProps {
  companionId: string;
  agents: ...;
  onExit: () => void;
  voiceMode?: boolean;  // NEW
}

export default function WakeModeScreen({ companionId, agents, onExit, voiceMode = false }: WakeModeScreenProps) {
  const [voiceStatus, setVoiceStatus] = useState<string>(voiceMode ? 'ready' : 'listening');
  const [voiceLogs, setVoiceLogs] = useState<string[]>(voiceMode ? ['🎙️ Voice Mode ready'] : []);

  useEffect(() => {
    if (voiceMode) return;  // NEW: skip wake listener in voice mode
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    // ... rest of wake listener setup
  }, [voiceMode]);
}
```

Now `voiceMode={true}` actually does what the prop name says — it makes the screen visual-only, no wake listening, no recording.

## Bug 2: Companion frozen on first idle frame

### Cause
v3.1.60 centered mode had:
```js
if (c._centered) {
  c.animation = 'idle';
  c.frame = 0;  // hold first frame of idle
  c.direction = 0;
  continue;  // skips frame advance code
}
```

The `continue` skipped the rest of the loop body, which included the frame advance code at the end. So the companion was frozen on frame 0 of idle.

### Fix
Restructured the update() loop so the frame advance is shared between centered and non-centered companions:

```js
for (const c of companions) {
  if (c._centered) {
    c.animation = 'idle';
    c.direction = 0;
  } else {
    // ... state machine, position update, bounce, velocity-based facing
  }

  // Frame advance — runs for both centered and non-centered
  const animData = c.images[c.animation];
  if (animData) {
    c.frameTimer += dt;
    if (c.frameTimer >= animData.frameInterval) {
      c.frameTimer = 0;
      c.frame = (c.frame + 1) % animData.frames;
    }
  }
}
```

Now centered companions cycle through their idle frames naturally. The boar in the screenshot was frozen because frame 0 was held; now it'll breathe / blink / animate.

## Bug 3: Companion should be 1.75x bigger

### Cause
v3.1.60 set `c.scale = 6` (192px on a 32x32 sprite). Tobe said "1.75 times bigger" compared to that. 6 × 1.75 = 10.5, so scale 10 (320px).

### Fix
Bumped from scale 6 to scale 10:

```js
if (CENTERED && companions.length > 0) {
  const c = companions[0];
  c.scale = 10;  // 320px on a 32x32 sprite — 1.67x the previous scale 6
  // ...
}
```

At 320px on a 360x187 canvas, the companion fills almost the full width. The sprite extends past the top/bottom edges, which is fine for a centered focus view — the name label above and the status overlay below are still visible.

## Files changed
- `android/app/src/main/assets/arena.html` — centered mode: scale 6 → 10, frame advance shared between centered/non-centered (idle animates), no more `c.frame = 0` freeze
- `src/screens/WakeModeScreen.tsx` — added `voiceMode` prop, initial state values use it, wake listener useEffect early-returns when `voiceMode`
- `package.json` — 3.1.60 → 3.1.61
- `android/app/build.gradle` — versionCode 110 → 111, versionName "3.1.61"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.61
- `CHANGES_3.1.61.md` (new)

## On multi-edit batches
The v3.1.60 commit lost several edits in a failed multi-edit batch. I should have verified the diff after the commit to catch this. Lesson: always diff the staged commit to confirm all the intended changes made it. A failed multi-edit batch is a known failure mode of the edit tool — a single failing edit invalidates the whole batch.

## Lesson: "1.75 times bigger"
User said "1.75 times bigger" without specifying linear or area. I interpreted as linear (scale × 1.75). If they meant area, that would be scale × √1.75 = scale × 1.32 (so scale 8, not 10). At 1.32 linear = 256px on a 360x187 canvas, the companion would fit vertically (256 > 187, so it still extends 34px above and below). At 1.75 linear = 320px, it extends 66px above and below. The user can adjust `c.scale = 10` to `c.scale = 8` if they want the smaller size.
