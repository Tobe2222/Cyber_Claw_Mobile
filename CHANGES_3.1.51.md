# 3.1.51 — Roll back the v3.1.50 mistakes, fix the reset

Tobe reported: "we are creating new issues faster than we fix them." Right. v3.1.50 fixed the wake mode forest background but introduced two regressions and missed the actual reset bug. v3.1.51 undoes the mistakes and fixes the reset properly.

## What v3.1.50 broke

1. **Voice/Wake buttons gone in the home screen.** I added `style="display:none"` to `#ctrlRight` in the HTML to hide it in wake mode. But inline styles always apply — the CSS rule that was supposed to scope it (`.wake-mode`) never got a chance. The buttons were hidden in BOTH the home screen and wake mode.

2. **Wake mode missing the companion.** I made the wake mode use the arena WebView with a black background. But arena.html only shows companions if `setAgents` is called. WakeModeScreen doesn't call `setAgents` (it has no agent list). So the WebView has no companions → blank middle.

3. **Companions still reset to starting position every 30s.** I didn't fix this in v3.1.50. The actual cause: the desktop sends `agents_list` periodically (every reconnect, every desktop change, etc). On every arrival, HomeScreen calls `injectJavaScript('setAgents(...)')` which REBUILDS the companions array and calls `layout()`. So every 30s the companions get teleported home. The `c._positioned` flag I added in v3.1.48 doesn't help because the companions are NEW objects each time.

## The fixes

### 1. Voice/Wake buttons back in the home screen
Removed the inline `style="display:none"`. The CSS rule `body.wake-mode #ctrlRight{display:none!important}` already handles the wake-mode case correctly (only hides when body has the wake-mode class). Home screen buttons are back.

### 2. Wake mode shows the companion
arena.html now reads `?companion=<id>` from the URL on boot and sets it as the active companion. WakeModeScreen passes `?companion=boar` (or whatever's the current companion) — the WebView shows that companion without needing a setAgents call. Combined with the existing `?mode=wake` from v3.1.50, the wake mode now shows the companion on a black background, with the React Native overlays on top.

### 3. setAgents is now idempotent
When the desktop broadcasts `agents_list` (which it does periodically), the WebView receives `setAgents`. The new logic:
- Compute the new list's IDs and the current companions' IDs.
- If the sets are the same (same companions, just a refresh), UPDATE METADATA IN PLACE — don't rebuild, don't call `layout()`. Preserves positions, state, animation.
- If the sets differ (new companion added, removed, etc), do a full rebuild.

This is the actual fix for the "reset to starting position every 30s" bug.

### 4. State distribution tuned + direction bias
Tobe said the companion was "running up and down 10 times plus before he stops" — this was the walk state rolling with 60% probability and 25% chance of each direction, so it kept alternating between up and down.

New state distribution: **50% idle / 47% walk / 3% zoomies** (was 35/60/5).

Added a "direction bias": 60% chance the walk state continues in the same direction as the previous walk state. So if the companion was walking left, the next walk state has 60% chance of being left again. This stops the up/down alternation.

Walk duration also extended: 2-5s → 3-7s. Idle: 1.5-4s → 2-5s. Zoomies: 0.6-1.4s → 0.4-0.8s.

## Files changed
- `android/app/src/main/assets/arena.html` — fixed #ctrlRight, URL ?companion= parsing, setAgents idempotency, state distribution + direction bias
- `package.json` — 3.1.50 → 3.1.51
- `android/app/build.gradle` — versionCode 100 → 101, versionName "3.1.51"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.51
- `CHANGES_3.1.51.md` (new)

## Lessons
**Inline styles override CSS rules.** `style="display:none"` in HTML applies regardless of media queries, classes, or selectors. If you want conditional visibility, use a CSS class and toggle it. The v3.1.50 mistake was that I conflated "hide always" with "hide in wake mode" and only the inline approach was obvious in the moment.

**Idempotency matters for periodic broadcasts.** When a message arrives periodically (every 30s, every reconnect, every change), the handler needs to be idempotent. If a refresh of the same data causes a side effect (like rebuilding a sprite array), the side effect happens every 30s, which users perceive as a bug. Compare incoming data to current state; only do the side effect when the data actually changes.

**Read the user's "and another thing" lists carefully.** Tobe reported four issues in v3.1.50 testing. I fixed one (wake mode background) and broke two (buttons gone, missing companion) while missing the most important one (the reset). When the user lists multiple things, don't fix them serially — read them all, plan, then fix in one cohesive pass.