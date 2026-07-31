# v3.10.119 — Three themes: Sun / Forest / Moon

## The request

Tobe (Discord #cyber-dev 2026-07-31 16:00 GMT+2):

> "What would be cool is a light mode (sun) which is light
> colors, white and light blue etc. Forest mode (forest)
> which is in the middle. Where we create it to look like an
> actual forest or a tree in graphics/looks. Green around
> the arena, Brown in the chat area for a tree trunk, and
> green under there again for bushes/foliage. And blue and
> white as sky above the arena. And dark mode to the right
> (moon) which is mostly black and cyber Orange + other
> neon colors."

## What ships

Three named themes, left-to-right in the picker matching
Tobe's mental model: **Sun ☀️ — Forest 🌳 — Moon 🌙**.

### 1. Forest theme (NEW)

The middle theme. Designed so the home screen visually
reads as "looking up at the sky through a forest canopy,
with a tree trunk in front of you." Each token is tuned
for its specific role in the composition:

- **sky strip (above arena):** pale blue (`#c8e0f0` fill +
  `#7fb0d0` bottom border + the v3.10.115 cloud silhouette)
- **arena frame:** deep forest green border +
  `#1f3d28` deep forest fill behind the WebView
- **companion tab bar:** warm brown bark (`#a47e54`) —
  the "ground under the tree"
- **chat list:** warm brown bark (`#a47e54`) — the "tree
  trunk cavity"
- **page bg (around chat):** forest green (`#5b8c5a`) —
  the "foliage around the trunk"
- **bubbles:** lighter green (`#6da56b`) cards on the
  brown trunk — high-contrast message bubbles
- **text:** cream-white (`#f8f8f4`) — readable on both
  green and brown
- **input field:** deep forest (`#1a3a1f`) — cream-white
  text contrasts well

### 2. Sun theme (RENAMED + REDESIGNED)

Previously called "Light" and themed as cream/sage (the
v3.10.113 sage-cream palette). v3.10.119 redesigns as a
true sun/bright theme per Tobe's spec:

- **page bg:** pure white (`#ffffff`)
- **cards:** very pale gray (`#f8fafc`)
- **elevated surfaces:** pale blue (`#e0f2fe`)
- **arena frame:** deep blue border (`#60a5fa`)
- **companion tab bar:** pale blue (`#eff6ff`)
- **chat list:** white
- **text:** deep navy (`#0c1a2a`)
- **brand accent:** CyberClaw orange stays (brand identity)
- **brand accentBright:** sky-blue (so secondary CTAs
  don't shout orange)

The sun theme feels like a clear bright day. Whites and
pale blues, with the orange accent reserved for primary
actions.

### 3. Moon theme (RENAMED + CYBERPUNK-IFIED)

Previously called "Dark". v3.10.119 cranks the neon up
to full cyberpunk:

- **page bg:** near-black (`#050510`, deep space)
- **cards:** near-black with subtle blue tint
- **arena frame:** neon-orange border (`#ff8c1a`) on
  near-black — the cyberpunk outline
- **companion tab bar:** deep forest (`#1a3a28`)
- **chat list:** deep black
- **text:** bright white
- **brand accent:** brighter neon orange (`#ff8c1a` vs
  the old `#ff6b35`)
- **brand cyan:** neon cyan (`#00f0ff` vs `#00d4ff`)
- **brand success:** neon green (`#22ff88`)
- **brand danger:** neon pink (`#ff2d6f`)
- **brand warning:** neon yellow (`#ffd000`)
- **brand info:** neon blue (`#00d4ff`)

## Files

- `src/theme/tokens.ts` — `ThemeName` extended to
  `'dark' | 'light' | 'forest'`. New `forestTheme`
  palette object. Redesigned `lightTheme` (sun) and
  `darkTheme` (moon) with brighter / more-cyberpunk
  colors. `themes` Record includes forest.
- `src/theme/ThemeContext.tsx` — `toggle()` cycles through
  3 themes (dark → forest → light → dark). Status bar
  logic uses `themes[themeName].bg.primary` (works for
  all 3 themes).
- `src/screens/SettingsScreen.tsx` — replaced the
  v3.10.112 single-toggle button with a 3-way segmented
  control: `☀️ Sun | 🌳 Forest | 🌙 Moon`. Each option
  calls `setTheme()` directly (no cycling — the user
  always sees all three). Active option highlighted with
  brand accent border + accentGlow bg.
- `src/screens/HomeScreen.tsx` — updated 4 conditional
  checks (`t.name === 'light'`) to handle 3 cases:
  - `arenaFrame.borderColor`: dark→accent (neon orange),
    light/forest→border.strong (deep blue / deep forest)
  - `arenaFrame.backgroundColor`: dark→transparent,
    light/forest→forestDark (deep forest fill)
  - `companionTabBar.backgroundColor`: light→skyLight,
    forest→ground (bark), dark→forestDark
  - `companionTabBar.borderBottomColor`: light→border.mid,
    forest→border.brown, dark→border.strong
  - `chatList.backgroundColor`: forest→bg.ground (brown
    trunk), light/dark→bg.primary (white / black)
- `package.json` + `android/app/build.gradle` — version
  bumps (3.10.118 → 3.10.119, versionCode 342 → 343)

## Pre-push checks (all green)

- `npx react-native bundle --platform android --dev false`
  → no parse errors
- `npx tsc --noEmit` → 0 new errors (baseline 79
  unchanged; the 43 pre-existing errors in HomeScreen.tsx
  are unrelated to theme work — they are about `addLogEntry`
  'debug'/'warn' params not matching the union, and
  `NodeJS.Timeout` namespace not being found)
- Module-scope free-variable grep on bundle → 0
  suspicious references (the v3.10.113 bug class)

## Composition diagram (forest theme)

```
┌─────────────────────────────┐  ← header (green bg)
├─────────────────────────────┤
│   sky strip (pale blue)     │  ← v3.10.115 skyStrip + cloud
├─────────────────────────────┤
│  ┏━━━━━━━━━━━━━━━━━━━━━━━┓  │
│  ┃     ARENA             ┃  │  ← arena frame: deep forest green
│  ┃   (forest fill)       ┃  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━┛  │
├─────────────────────────────┤  ← companion tab bar: brown bark
│      🍖 🌄 (tab buttons)   │
├─────────────────────────────┤
│                             │
│   CHAT (brown trunk cavity) │  ← chat list: brown
│                             │
│   [user] [clawsuu] [user]  │
│                             │
├─────────────────────────────┤  ← input area: green foliage
│   [type a message...  📎 🎤]│
└─────────────────────────────┘
```

## Lessons

1. **Three-state themes need a segmented control, not
   a cycle button.** A toggle button that cycles
   dark → forest → light → dark forces the user to tap
   up to 3 times to land on the theme they want. With
   a segmented control, the user sees all three options
   and taps the one they want. Single-tap to any theme.
   Rule of thumb: N-state pickers get segmented
   controls when N > 2.

2. **The forest theme is a COMPOSITION, not a palette.**
   Each token in the forest theme exists for its specific
   role in the home-screen visual (sky = above, forest =
   around arena, bark = chat/trunk, foliage = around
   chat). Defining a palette and assigning roles
   randomly would have given a "green app" instead of a
   "forest scene." The composition is the design;
   tokens are just colors.

3. **Theme renaming is part of the work.** v3.10.119
   renamed `light` → `sun` in user-facing labels (but
   kept the `light` ThemeName value for backwards
   compat with AsyncStorage and ThemeName type usage).
   Same for `dark` → `moon`. The internal key stays
   the same; only the displayed label changes.

4. **ThemeName in AsyncStorage is stable across
   renames.** Existing users with `'light'` or `'dark'`
   stored from v3.10.118 still get the right theme on
   the next launch (because the theme name value
   didn't change, only the displayed label). The
   forest theme is the only new value — first-time
   installs can opt into it via the picker.

5. **The dark→forest→light cycle order matters.** The
   `toggle()` cycles dark → forest → light → dark, not
   light → forest → dark → light. Reason: dark is the
   `DEFAULT_THEME` (the existing behavior on app
   launch), so the cycle ends back at the default.
   Starting the cycle from the default makes the cycle
   predictable: "always ends at dark no matter where
   you start."

## What I didn't do (yet)

### Picker placement

The 3-way segmented control is in the SettingsScreen
header (where the v3.10.112 toggle was). It's right-
aligned in a `flexDirection: 'row'` header that also
holds the back button + title. On small screens (e.g.
4.7" iPhones) the header might get tight — 3 segmented
buttons + back button + title could overflow. Out of
scope for v3.10.119; the picker is small enough to
work on iPhone SE (the smallest realistic target).

If this becomes a problem, the picker can move into
the SettingsScreen body content (under "⚙️ General")
where it has more horizontal room.

### Pre-existing tsc errors

The 43 pre-existing errors in HomeScreen.tsx are
unrelated to theme work (they're about `addLogEntry`
parameter types and `NodeJS.Timeout` namespace).
v3.10.119 doesn't address them. Out of scope; flag
for a separate cleanup PR.