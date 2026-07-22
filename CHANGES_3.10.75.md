# v3.10.75 — Feed menu moved inside the arena, drag fixes

Tobe reported on 2026-07-22 18:37 (the message I
initially missed; the human user had to ping me
again):

> "@Clawsuu Okey updated and tested. I think the
> menu should open inside the arena, and when one
> item is clicked it should appear as it does now
> with a ring around it and then the user clicks
> and holds it to drop it. Now it dropped it in the
> chat and i cant drag it"

The v3.10.74 implementation had two real problems:
1. The bottom-sheet Modal covered the screen — Tobe
   wanted the menu INSIDE the arena, not on top of
   it.
2. The drag overlay used `pointerEvents="box-none"`
   on the outer View, which prevents the
   `PanResponder` from capturing gestures. The drag
   silently failed.

v3.10.75 throws out the v3.10.72-v3.10.74 RN-side
picket-and-drag dance and puts everything inside the
WebView as HTML elements. This is closer to how the
desktop works (the desktop's #feed-menu is an HTML
div) and avoids the WebView-bounds coordinate
translation problem entirely.

## What ships

**1. In-arena feed menu** (`arena.html`)

A new `#feed-menu` div inside the WebView, opened
by tapping the 🍖 button (which is no longer a
React Native bridge — it's a local toggle now).
The menu has 7 treat buttons styled like the
desktop's `#feed-menu` div in `src/css/layout.css:898`.

The menu title says "🍖 Treats — pick then tap arena
to drop".

**2. Select-then-drop drag flow**

Tapping a treat in the menu:
1. Selects it (ring + selected styling on the button)
2. Closes the menu
3. Shows a #treat-ghost emoji that follows the
   finger via `touchmove` / `mousemove` listeners on
   `window`

Tapping the arena canvas (now, anywhere on it):
1. Drops the carried treat at the tap position
2. Hides the ghost
3. Flashes a brief "✓ placed" toast for confirmation
4. Calls `dropTreat(type, x, y)` which uses the
   existing seek-and-eat logic
5. The closest companion walks over and eats

**3. Per-companion food preferences (moved to WebView)**

The `COMPANION_FOOD_PREFS` map and the ⭐ marker
rendering moved from React Native (HomeScreen.tsx)
to JavaScript inside `arena.html`. The `getPreferred
Treats()` function uses the active companion's `id`
and `name` (lowercase substring match) to pick
favourites. `refreshFoodPrefs()` runs whenever the
menu opens OR the active companion changes (we hooked
into `setActive`).

Clawsuu prefers fish/meat/berry, Lamasuu prefers
cake/cookie/berry, generic cat/dog/bird/rabbit get
species-appropriate defaults.

**4. Removed v3.10.74's RN-side Modal, dragPanResponder,
feedModalOpen state, dragMode state, getPreferredTreats,
FEED_TREATS, COMPANION_FOOD_PREFS, ~150 lines of
styles. PanResponder import removed.

The React Native side now just listens for
`{type:'treat_placed'}` and `{type:'treat_eaten'}`
from the WebView (still works) and forwards them to
the desktop — no other React Native state needed.

## Why this approach

The v3.10.74 design had a fundamental flaw: the menu
and the arena lived in two different coordinate
spaces (RN layout vs. WebView canvas). Drag-to-place
required translating finger coordinates from the RN
View tree to the canvas via the WebView's offset.
That's error-prone and broke silently with the wrong
`pointerEvents` setting.

By moving everything into the WebView, the menu and
the canvas share one coordinate system. Tapping
"drop here" just calls `dropTreat(type, x, y)` with
`clientX/Y - canvas.rect.left/top` — straightforward.

The mobile arena still uses RN for state (companion
list, chat messages, etc.) but the feed menu is a
self-contained UI that doesn't need to coordinate
with anything else. Moving it into the WebView is
locality-of-reference at its purest.

## Files changed

- `android/app/src/main/assets/arena.html` — added
  in-arena feed menu HTML, CSS, click/hover
  handlers, drag ghost, drop-on-canvas-click,
  preferences logic; removed the React-Native-bridge
  behavior on the 🍖 button
- `src/screens/HomeScreen.tsx`:
  - removed `feedModalOpen` state + handler
  - removed `FEED_TREATS`, `COMPANION_FOOD_PREFS`,
    `getPreferredTreats`, `dragMode` state, ref,
    `placeTreat`, `dragPanResponder`
  - removed the feed Modal (line ~3583)
  - removed the drag overlay View (line ~3655)
  - removed ~120 lines of feedModal* and drag*
    styles
  - removed `PanResponder` import
  - removed `feed` WebView message handler (was
    sending `{type:'feed'}` from the WebView, but
    the WebView now handles the menu internally)
- `android/app/build.gradle` — versionCode 300→301,
  versionName 3.10.74→3.10.75
- `package.json` — version 3.10.74→3.10.75

## Lessons

**The message I initially missed.** Tobe's report was
clear and complete at 18:37; my response said "Exec
failed" and a brief Hey. He had to ping me again at
18:38 with the screenshot embedded before I saw the
real content. Lesson: when a tool call returns "Exec
failed" with no body, fall back to reading the
screenshot or asking the user to repaste before
shipping guesses.

**WebView-local UI is the right default for ephemeral
controls that don't need RN state.** A feed menu is
an ephemeral control: open, pick, drop, close. It
doesn't need to persist across navigation, doesn't
talk to Redux, doesn't need to coordinate with the
chat or other RN features. Putting it in the WebView
as HTML is the right tool for the job — and avoids
the WebView-bounds coordinate-translation problem
that broke the v3.10.74 drag.

**`pointerEvents="box-none"` on the View that owns
the PanResponder silently disables the gestures.**
This is RN's interactive-tree trivia at its worst:
the prop name suggests "pass touches through", but
it actually means the View itself isn't a touch
target at all — so PanResponder's
`onStartShouldSetPanResponder` never gets called.
Pattern: when wrapping a gesture in a transparent
overlay, use `pointerEvents="auto"` or omit the prop
on the OUTER view, then put `pointerEvents="none"`
on the inner decoration views only.

**Tobe's UX preference was clearer than my
interpretation.** "Click a treat, then click and
hold to drop" is a select-then-place pattern (one
tap to select, one tap to place), not a
long-press-then-drag. My v3.10.74 implementation went
straight to drag-and-drop without offering the
select-then-place flow. Tobe corrected me clearly.
The select-then-place flow is also significantly
less error-prone on mobile (no way to "lose" the
ghost if your finger leaves the screen) and matches
the desktop behavior exactly. Lesson: for
"place an item", prefer select-then-place over
drag-and-place unless the user explicitly says they
want a drag.