# v3.10.140 — Animated sprite view at top of CompanionSettingsScreen (SPIKE)

## What this is

**Spike only.** Adds an animated sprite view window
at the top of the CompanionSettingsScreen — a small
arena.html WebView showing the active companion in
centered mode (idle/walk animations, no wandering).

This is the FIRST step of Tobe's 2026-08-07 redesign
request:

> "Can we just neatly display the skills and xp bar in
> the top of the companions settings?
>
> Actually lets do some redesign.
>
> I want to remove this first image page. And Instead
> i want an expansion of the edit / personalize page and
> pack it all in there.
>
> I want a window to view the companion, how it looks
> on the arena, its animations.
>
> And then i want its behaviour and settings as buttons
> on that same page."

The full redesign also includes:
- Skills grid moved to top (currently below Exit)
- CompanionEditScreen folded INTO this page
  (currently a separate route)
- Wake/Exit/Voice cards collapsed to current-value
  inline view

**This PR only ships the sprite view window.** The
rest of the redesign will land in 3.10.141+ after
Tobe confirms the WebView approach looks good.

## Implementation

### WebView approach (chosen)

- Embed `arena.html` in a small WebView (240×200)
  at the top of CompanionSettingsScreen
- Inject `setAgents([activeCompanion])` + `setCentered(true)`
  on `onLoadEnd` so the companion renders centered
  in the box (no wandering)
- Inject `document.body.classList.add('wake-mode')` to
  hide all arena controls (background picker, treat
  buttons, status text)
- Re-inject on companion change via `useEffect` keyed
  on `companion?.id`

### Why not static image?

Tobe (2026-08-07 13:52): "i want basicly what voice
mode has, the view of the companion, not static but
doing animations in a fixed place."

Voice mode (and Home) renders the pixel-arena's canvas
inside a WebView. The companion's idle/walk animations
are canvas-driven, not GIF-driven — the only way to
get them is to embed arena.html. A static `Image`
would not animate.

### Dimensions: 240×200

- Square-ish fits inside a portrait phone width with
  margins to spare
- arena.html's `ground line` is at 70% of canvas
  height, so the companion's feet sit at ~85% of the
  box — visible with a little headroom

### Cache-buster

`ARENA_HTML_VERSION = '3.10.140'` is appended to the
arena.html URI. This forces Android WebView to fetch
the latest arena.html after an APK upgrade. Same
pattern as HomeScreen.

## Files

- `src/screens/CompanionSettingsScreen.tsx`:
  - Imports `WebView` from `react-native-webview`
  - Imports `Dimensions` from `react-native`
  - New `viewWebViewRef` ref
  - New `VIEW_BOX_W`, `VIEW_BOX_H`, `ARENA_HTML_VERSION`
    constants
  - New `renderCompanionViewWindow()` helper
  - New `useEffect` that re-injects setAgents on
    `companion?.id` change
  - New `viewWindow` style
  - JSX: `<View>{renderCompanionViewWindow()}</View>`
    inserted right after the detail header row
- `package.json`: bump 3.10.139 → 3.10.140
- `android/app/build.gradle`: bump versionCode 363→364,
  versionName 3.10.139→3.10.140

## Out of scope (for 3.10.141+)

- Skills grid moved to top (compact 2-col)
- CompanionEditScreen folded into this page
- Wake/Exit/Voice cards collapsed

## Verification (for Tobe)

1. Install the new APK
2. Open Settings → tap any companion (e.g. Clawsuu)
3. A new box should appear at the top of the page
   showing the companion centered in a fixed-size
   view, with idle/walk animation playing
4. No arena controls visible (background picker,
   treat buttons hidden via wake-mode class)
5. Switching companions (re-tap the same or another
   one in the list) should swap the view to the new
   companion's sprite

## Risks / unknowns

- **WebView perf on older Android**: arena.html
  runs an animation loop. On a 240×200 box the
  workload is small but still a per-frame canvas
  redraw. If Tobe's phone is old, this could
  noticeably drain battery / heat up. Worst case:
  we ship a static image as fallback.
- **Memory**: each time CompanionSettingsScreen
  mounts, a new WebView is created. If the user
  opens/closes companion settings many times in
  a row, memory could grow. WebView itself
  releases on unmount (RN handles this), so it
  should be fine in practice.
- **Switching companions while screen is open**:
  the useEffect re-injects setAgents + setCentered
  on `companion?.id` change. There's a 50ms delay
  between setAgents and setCentered so setCentered
  sees the new agent. If the WebView is slow to
  apply setAgents, the 50ms might not be enough
  → setCentered would filter an empty array → blank
  canvas. Easy fix if it happens: bump delay to
  150ms.

## Lessons

### Voice-mode-style patterns are reusable

The home arena and Wake mode both use a fullscreen
arena.html WebView with setCentered(false) (default,
companions wander). For the settings view, we want
a SMALL fixed-size window with setCentered(true) (no
wandering). The pattern is identical — just different
container dimensions + different init args. Worth
remembering: arena.html's window.Arena API is the
right abstraction for "show me this companion" any
time we want pixel-arena fidelity.

### Function declaration placement matters for TS

I initially placed my `useEffect` above the
`const companion = ...` declaration. TypeScript
flagged it because the effect's dep array references
`companion?.id` before `companion` exists. At
runtime it works (the effect's callback runs AFTER
`const companion` executes), but TS doesn't model
that ordering. Moving the effect below the
declaration fixed the warning.

Same pattern already exists at line 340 in this
file (pre-existing TS error that nobody fixed). The
right fix is to reorder; the lazy fix is to use
`as any` or `@ts-ignore`. I reordered because it
was a fresh effect.
