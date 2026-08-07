# v3.10.144 — fix the empty view + traits as wrap chips

## Two things in this release

### 1. Fix the empty sprite view (the "flash then black" bug)

**What was happening (3.10.140–3.10.143):**
Tobe (2026-08-07 15:19): "I saw the whole arena for a
brief milli second, then it went black."

**Root cause:** race condition in the WebView injection.

The injection sequence in 3.10.143 was:
1. `onLoadEnd` fires when arena.html finishes loading
2. Inject IIFE that calls `setAgents([comp])`
3. setTimeout 80ms, then `setCentered(true)`

But `setAgents` is ASYNC — it awaits `loadImage` for
each animation sprite. The 80ms timeout was shorter
than the image load time, so:
- `setAgents` started loading the sprite
- 80ms later `setCentered(true)` fired
- `setCentered` saw an empty `companions` array
  (sprite not yet loaded) and filtered to nothing
- Tobe saw the empty `setCentered` viewport = black

**Fix (3.10.144):**
- `setCentered` now AWAITS `setAgents` finishing
- Single async IIFE: `setActive → await setAgents → setCentered`
- This guarantees the sprite is in the array when
  setCentered runs

**Also changed:** the source URI now uses
arena.html's URL params (`?mode=wake&centered=true&onlyActive=true`)
to set initial state at boot. URI is STATIC (no
companion ID) so the WebView doesn't re-mount on
companion switch — we just re-inject setActive +
setAgents when companion.id changes.

### 2. Traits as wrap chips (Tobe: "make better use of the space")

**What was happening:** traits were rendered as a
comma-separated string that got truncated:
"Curious, Foodobsessed, Dramatic, Stoic, A..."

**Fix (3.10.144):** traits are now individual chips
with their emoji, wrapping to the next line when
they overflow the available width.

Layout per row:
```
Traits  [😏 Sassy] [🔍 Curious] [🍖 Food-obsessed]
        [🎭 Dramatic] [🗿 Stoic] [⚔️ Adventurous]
        [👺 Goblin]
```

Up to 3-4 chips fit per row on a typical phone width.
All traits stay visible regardless of how many are
selected (no more truncation).

The TRAIT_LABELS map is local to this file for now,
mirroring the TRAITS table in CompanionEditScreen.tsx.
Both must be kept in sync (the id values are the
canonical strings; the labels are display-only). A
future refactor could move TRAITS to a shared module
(e.g. `src/services/traits.ts`) so both screens
share one source of truth.

## Files

- `src/screens/CompanionSettingsScreen.tsx`:
  - `renderCompanionViewWindow`: static source URI
    with URL params (no companion ID), onLoadEnd
    re-injects setActive + setAgents (awaiting
    setCentered)
  - `useEffect` re-injects setActive + setAgents
    (awaiting setCentered) on companion.id change
  - `renderBehaviourCard`: traits now rendered as
    chips via local `TRAIT_LABELS` map
  - New styles: `traitsChips`, `traitChip`,
    `traitChipText`, `traitsEmpty`
- `package.json`: bump 3.10.143 → 3.10.144
- `android/app/build.gradle`: bump versionCode
  367 → 368, versionName 3.10.143 → 3.10.144

## Lessons

### Async APIs + post-load injection is a race condition factory

`window.Arena.setAgents([...])` returns a Promise
that resolves when the sprite assets are loaded.
But RN's `injectJavaScript` is fire-and-forget —
you can't await a Promise across the bridge. So
I had to write an ASYNC IIFE inside the injected
code and chain the next call inside that IIFE's
continuation.

Pattern for injecting async chains into a WebView:
```js
injectJavaScript(`
  (async function(){
    const result = await window.SomeAPI.doThing(args);
    window.SomeAPI.doNextThing(result);
  })(); true;
`);
```
The `true;` at the end is important — it makes
the IIFE statement return a truthy value, which
prevents RN from logging "evaluateJavaScript
returned null" warnings.

### URL params ≠ setAgents

I keep tripping over this. arena.html's URL params
(?companion=, ?centered=, ?onlyActive=) set FLAGS
at boot. They do NOT trigger a setAgents call.
You still need to inject setAgents to add
companions to the array. The URL params just tell
setAgents HOW to filter when it runs.

### Static source URI = no re-mount on prop change

If the source URI changes, react-native-webview
treats it as a new WebView (browser-level reload).
For a fast-switching list (changing companionId
rapidly), this is slow. Keep the source URI static
and re-inject JS for prop changes instead.

Trade-off: the WebView is "wasted" memory for the
first render's data (we overwrite it on first
injection), but switching is instant.

### The chip layout pattern (flex:1 + flexWrap)

```jsx
<View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
  {items.map(item => <Chip />)}
</View>
```
The `flex: 1` on the parent (after a fixed-width
label sibling) makes the chips container take the
remaining space. `flexWrap: 'wrap'` lets chips
flow to the next line when they don't fit. `gap: 4`
spaces them out.

This is the same pattern I used for the skills grid
in 3.10.142. Reusable for any "show all items with
their visual style, wrap if too many" UI.
