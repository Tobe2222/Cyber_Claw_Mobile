# v3.10.116 — Dark-mode tab bar: forest, not orange

## The report

Tobe (Discord #cyber-dev 2026-07-31 12:19 GMT+2, screenshot
of v3.10.114 dark mode):

> "the tabs looks bad btw, it needs to match better with color"

The screenshot showed the companion tab bar (Clawsuu /
Lamasuu) in dark mode as a saturated orange `#cc5528` strip
underneath the dark forest arena frame. Bright orange on a
dark page reads as a neon ad, not a tab bar — it fights
with the rest of the chrome for attention.

## What ships

Single style change in `makeStyles(theme).companionTabBar`:

**Before:**
```ts
backgroundColor: t.name === 'light' ? t.bg.ground : t.brand.accentDim,
borderBottomColor: t.name === 'light' ? t.border.brown : t.border.mid,
```

**After:**
```ts
backgroundColor: t.name === 'light' ? t.bg.ground : t.bg.forestDark,
borderBottomColor: t.name === 'light' ? t.border.brown : t.border.strong,
```

Dark mode now reads as: deep forest arena frame (`border.strong`)
→ deep forest tab bar (`bg.forestDark`) → dark chat. The
home-screen dark aesthetic stays cohesive instead of having
one bright orange stripe in the middle of it.

Light mode unchanged from v3.10.115 (warm brown earth).

## Files

- `src/screens/HomeScreen.tsx` — 2-line change in
  `makeStyles(theme).companionTabBar` + comment block updated
  with the v3.10.116 history and Tobe's Discord reference

No changes to:
- `src/theme/tokens.ts` (the scene tokens needed for this
  fix already shipped in v3.10.115)
- `makeStyles` factory shape (still takes `Theme`, still
  rebuilds via `useMemo([t])`)
- Module-scope free-variable rules (this style is inside the
  factory, not at module scope)

## Pre-push checks (all green)

- `npx react-native bundle --platform android --dev false`
  → no parse errors
- `npx tsc --noEmit` → 0 new errors (baseline 79 unchanged)
- Module-scope free-variable grep on bundle → 0
  suspicious references (the v3.10.113 bug class)

## Lesson: dark-mode "don't fix what wasn't broken" is wrong

In v3.10.115 I deliberately kept dark-mode tabs on
`brand.accentDim` with a comment saying "dark earth would
just look like mud". That comment was me projecting my own
preference (dim orange = CyberClaw brand identity) onto what
the user actually wants (a cohesive dark-mode home screen).

The rule I should follow: when the user explicitly asks for
"match better with color", listen. They see the screen,
not the design tokens. The forest-orange vs forest-orange
choice is invisible from inside the design system but
obvious from outside.

Same lesson as the kimi rollback from earlier today: stop
arguing about what I think is right and ship what the user
sees.