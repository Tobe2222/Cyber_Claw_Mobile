# v3.10.115 — Home screen scene zones: sky above, forest arena, earth below

## The request

Tobe (Discord #cyber-dev 2026-07-30 21:45 GMT+2) followed up on
v3.10.114 with a deeper scene spec:

> "I want it to look like a scene — sky above the arena,
> forest green around the arena, then a brown ground strip
> between the arena and the chat, then the chat itself.
> Make the home screen feel like a place."

After v3.10.114 the home screen had a forest-green arena
border and a forest-green companion tab bar, but there was no
visual separation between "above the arena" (header) and
"the arena", and the tab bar still read as a second
forest zone rather than its own scene element.

## What ships (light mode)

### 1. Sky gradient strip above the arena

A 14dp-tall strip sits between the header bar and the arena
frame. Solid `bg.skyLight` (#e3f0f6 — pale sky) with a
2dp `bg.skyDeep` (#6fa3c4 — mid sky) bottom border to fake
a gradient without pulling in a `LinearGradient` dependency.

A small 28×7dp cloud silhouette sits top-right of the strip
(white at 65% opacity). One cloud for v3.10.115 — Tobe can
ask for more if it feels empty.

### 2. Arena frame: deep forest border, dark forest fill

The arena frame border changes from `brand.accent` (orange)
to `border.strong` (deep forest #5b7a4a) in light mode.
Dark mode keeps the orange (the dark-mode frame is meant
to be a neon-accent outline on black).

The arena frame also gets a `bg.forestDark` (#1f3d28)
background fill in light mode. Visible briefly while the
WebView loads (the WebView itself is dark; the fill
prevents a white flash before arena.html paints).

### 3. Companion tab bar: warm brown ground

Was `brand.accentDim` (#cc5528 — orange-dim). Now
`bg.ground` (#a47e54 — warm brown earth) in light mode.
Border becomes `border.brown` (#7a5635). Reads as
"ground under the trees" — the visual bridge between
the forest (arena) and the cream (chat).

Dark mode keeps the dim-orange forest-green because
dark-mode earth would just look like mud.

### 4. Chat list bg unchanged (cream)

The chat list bg stays at `bg.primary` (sage cream). Tobe's
v3.10.114 spec said "chat can be more of the White" — the
white bubbles on the cream bg already deliver that. Adding
more sky tint here would muddy the bubble contrast.

## What ships (dark mode)

Dark mode tokens added in this version are all subtle
dim-navy / dim-forest / dim-brown variants. They exist for
type symmetry with light mode (so the same code works in
both modes) but the visual change is mostly cosmetic —
dark mode still feels like CyberClaw dark mode, just
slightly more cohesive.

The arena frame in dark mode is unchanged (orange neon).

## Scene token summary (new in this version)

Light theme:
- bg.sky:       #bdd9e8 — pale sky
- bg.skyDeep:   #6fa3c4 — mid sky (gradient bottom)
- bg.skyLight:  #e3f0f6 — lightest sky (gradient top)
- bg.ground:    #a47e54 — warm brown earth
- bg.groundDark: #5b3e1f — deep earth
- bg.groundLight: #d4b896 — pale brown (lit areas)
- bg.forest:    #3d6b4a — canvas forest green
- bg.forestDark: #1f3d28 — deep forest
- border.brown: #7a5635 — earth border
- border.brownDark: #4a2f15 — deep earth border

Dark theme:
- Same key names, all dark-mode-friendly values
  (sky: navy, ground: dark earth, forest: deep forest, etc.)

## Files

- `src/theme/tokens.ts` — added scene tokens (sky/ground/
  forest) to both themes + extended `Theme` structural type
  to declare the new keys (TypeScript was failing at the
  new token references before this addition — the type
  doesn't auto-grow from `darkTheme`/`lightTheme`)
- `src/screens/HomeScreen.tsx` — new `skyStrip` /
  `skyStripCloud` styles, updated `arenaFrame` borderColor
  + bg, updated `companionTabBar` bg + borderColor

## Migration notes

The v3.10.112 `Theme` structural type has to be updated
by hand when adding new token keys. Don't try to infer
the type from `darkTheme`/`lightTheme` — the `as const`
on those objects produces literal types that don't unify
across themes (the v3.10.112 lesson). Always add new
keys to the explicit `Theme` type at the same time you
add them to the palette objects.

## Pre-push checks (all green)

- `npx react-native bundle --platform android --dev false`
  → no parse errors
- `npx tsc --noEmit` → 0 new errors (baseline 79, same
  after changes; 43 of those 79 are pre-existing in
  HomeScreen.tsx unrelated to v3.10.115)
- Module-scope free-variable grep on bundle → 0
  suspicious references (the v3.10.113 bug class)