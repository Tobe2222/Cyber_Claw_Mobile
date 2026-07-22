# v3.10.72 — Mobile feed/treats system (mirror of desktop)

Tobe asked on 2026-07-22:

> "@Clawsuu actually i would like to introduce the
> food/treats on the mobile end also. Put that in the
> lower left corner. Just like it is on desktop."

The desktop has a feed button in the lower-left of the
arena (`src/css/layout.css:889`) plus a rich treats +
toys system in `src/js/pixel-arena.js` and `src/js/app.js`.
The mobile stripped both at v3.1.93 ("let's just try to
remove wake mode temporarily") so the mobile arena
currently has no feed functionality.

v3.10.72 brings the food/treats back. Toys are out of
scope for now (no physics in the mobile arena, no
bouncing), but the architecture leaves room to add them
later.

## What ships

### 1. Mobile arena treats system (arena.html)

Ported from the desktop's `pixel-arena.js`:
- `treats = []` array (x, y, type, emoji, age, graceTimer)
- `dropTreat(treatType)` — places a treat at canvas center
  (mobile has no drag-to-place; tap = drop at center)
- `drawTreat(t)` — draws the emoji on the ground (fade-in
  over 200ms)
- Seek-and-eat logic in `update()` — when the active
  companion is within 30px of a treat whose grace period
  has elapsed, walk toward it; on contact, eat it and play
  a 😋 emoji overlay for 2.5s
- 60s treat lifetime (matches desktop)
- `companionEmoji` overlay (DOM-based, positioned above
  companion's head) — used by both the treat-excitement
  emoji (🤩) and the post-eat reaction (😋 → ❤️ after 2.5s)
- `window.Arena.dropTreat(type)` exposed for React Native
  to call via `injectJavaScript`

### 2. Arena feed button

Bottom-left, mirrors the desktop's #arena-feed-btn:
```html
<div id="ctrlBottomLeft">
  <button id="feedBtn" onclick="...">🍖</button>
</div>
```
Hidden in wake/voice mode (the arena is fullscreen
for those).

### 3. React Native treat picker (HomeScreen.tsx)

A bottom-sheet Modal with 7 treats (apple / burger /
meat / fish / cake / cookie / berries) styled like the
desktop's #feed-menu. Tap a treat → `injectJavaScript
('window.Arena.dropTreat("apple"); true;')` + the
WebView emits `treat_placed` back to RN which forwards
to the desktop as `arena_treat_placed`.

### 4. Desktop IPC relay (cyberclaw-desktop)

`src/sync-server.js` accepts the new
`arena_treat_placed` and `arena_treat_eaten` message
types. `src/main.js` wires them to IPC channels
`mobile-arena-treat-placed` and `mobile-arena-treat-eaten`.
`src/js/app.js` listens for those channels and calls
`promptCompanionReaction('I just gave you ' + TREAT_NAMES
[treat] + '. What do you think?')` (placed) or
`'I just ate ' + name + '. Give a short happy reaction
about how it tasted.'` (eaten). This matches the
desktop's own `placeTreatOnArena()` and
`promptCompanionEat()` flows exactly so the AI text
reply is the same whether you tap from mobile or
desktop.

## Files changed

**Mobile:**
- `android/app/src/main/assets/arena.html` — treats
  state, dropTreat, render, seek-and-eat,
  companionEmoji overlay, #ctrlBottomLeft button,
  CSS for new controls
- `src/screens/HomeScreen.tsx` — `feedModalOpen` state,
  `FEED_TREATS` list, `placeTreat()` function, handler
  for `feed` / `treat_placed` / `treat_eaten` WebView
  messages, Modal component, styles
- `android/app/build.gradle` — versionCode 297→298,
  versionName 3.10.71→3.10.72
- `package.json` — version 3.10.71→3.10.72

**Desktop:**
- `src/sync-server.js` — `arena_treat_placed` /
  `arena_treat_eaten` message handlers
- `src/main.js` — IPC relay handlers
- `src/js/app.js` — renderer-side `ipcRenderer.on`
  handlers calling `promptCompanionReaction`
- `package.json` — version 3.2.14→3.2.15

## Lessons

**Mobile-only features can leverage the desktop's AI
infrastructure unchanged.** The desktop already has
`promptCompanionReaction()` which formats the AI text
reply, `TREAT_NAMES` for natural-language food
descriptions, and a place to attach the system log
entry. The mobile doesn't need to invent any of this —
it just needs a thin IPC bridge to ask the desktop
to react.

**Tap-to-place is the natural mobile flow.** The desktop
has drag-to-place because mice can drag. Mobile doesn't
have drag — it has tap. So the mobile treat picker
treats each tap as "place THIS treat at the canvas
center now" instead of "select this treat, then tap the
arena to place it." This is faster (one tap, no two-step
flow) and works with the existing tap-based UI. Lesson:
don't port desktop interaction patterns literally when
the mobile input model is different.

**Architectural seams make ports cheap.** The desktop's
seek-and-eat logic in `pixel-arena.js:636-687` was
already structured around a "treats array on the
companion, gravity-free" model. The mobile arena had
stripped it but the canvas-drawing / state-machine
patterns were unchanged. Porting was ~80 lines of JS
in `arena.html` rather than a rewrite.

**Y-axis bounce matters on small arenas.** The desktop
arena is large enough that treats and companions share
a single ground line. The mobile arena uses a vertical
band (0.70*h to h) for the walkable area, so the
seek-and-eat code uses the same band — placing the
treat at 0.85*h feels like "in front of the companion"
on a small canvas. Without the band, the treat would
land at canvas center which is up in the sky.

## What didn't ship

- **Toys** (⚽ ⚾ 🧶 etc.). Toys need physics (gravity,
  bouncing) and the mobile arena intentionally
  constrains the companion to a single ground line. A
  toy system is a separate ~150-line feature. Not in
  scope for Tobe's "food/treats" request.
- **Are you hungry? reaction on menu open.** The desktop
  calls `promptCompanionReaction('The user just opened
  the treat menu. Are you hungry?')` when the user
  opens the feed menu. The mobile's React Native Modal
  opens on the RN side, not the WebView side, so the
  WebView doesn't know "menu just opened." Adding the
  "are you hungry?" reaction is one extra line in
  `setFeedModalOpen(true)` → `syncClient.send({type:
  'arena_treat_menu_opened'})` if you want it.
  Skipped for v3.10.72 to keep scope tight.