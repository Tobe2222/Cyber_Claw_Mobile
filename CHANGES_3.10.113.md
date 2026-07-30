# v3.10.113 — More forest + sky (less white), theme propagates to all screens

## The complaint

Tobe (Discord #cyber-dev 2026-07-30 16:19 GMT+2):

> "It seems to only be for the settings, it should be for all pages
> and the home screen too. It looks like this now, but i would like
> more sky and forest, not just white."

The screenshot showed the Settings page rendered in the v3.10.112
light theme. The page bg was warm cream `#f5f7f0`, the cards were
pure white, and the only non-white color was the green accent on
the section borders. The whole screen read as "white with green
accents" — not "forest with sky."

Two specific things Tobe wanted:
1. The theme should apply to all pages, not just Settings.
2. The palette should have more sky and forest color, less white.

## What ships

### Palette upgrade (`src/theme/tokens.ts`)

- `bg.primary` — `#f5f7f0` (warm cream, near-white) → `#e3ecd9`
  (soft sage, the "forest floor")
- `bg.secondary` — `#ffffff` (pure white) → `#eaf2dd` (paler mint)
- `bg.tertiary` — `#eaeee0` → `#d4e3c4` (deeper sage)
- `bg.elevated` — `#e0e8d4` → `#dbe9f0` (NEW: sky tint)
- `input.bg` — `#ffffff` → `#eaf4f9` (pale sky)
- `input.border` — `#c5d0b3` → `#8aa478` (forest mid-green)
- `input.borderFocus` — new field, `#3d8fc4` (sky blue) for
  focus rings on inputs
- `brand.cyan` — `#3a7ca5` (gray-blue) → `#3d8fc4` (more saturated)
- `brand.cyanSoft` — new field, `#cfe4f3` (pale sky tint)
- `brand.cyanGlow` — new field, `rgba(61,143,196,0.18)`

The dark theme gained matching fields (`cyanSoft`, `cyanGlow`,
`input.borderFocus`) so the `Theme` type stays symmetric.

Visual feel: when you tap the sun icon now, you see forest greens
and sky blues across the bg, cards, and inputs — not white with
green accents.

### Theme applied to all screens

- **HomeScreen** — full chrome (header bar, tab bar, input bar,
  attachment preview row, status dot, settings button, text input)
  themed. The arena (WebView) and chat messages stay dark — they
  are media content with their own backgrounds via the WebView's
  CSS. The container bg follows the theme.
- **CompanionSettingsScreen**, **CompanionEditScreen**,
  **QuestsScreen**, **WakeModeScreen** — root container bg follows
  the theme. Inner styles stay dark (full migration in v3.11.0).
- **SettingsScreen** — already fully themed in v3.10.112.

### Trainer sub-screens (deliberate skip)

OpenWakeWordTrainer, ExitPhraseTrainer, SendPhraseTrainer,
WakeSetManagerScreen all have hardcoded `root: { backgroundColor:
'#0a0a0a' }`. They're full-screen modal flows reached from
Settings. If you tap "Train wake phrase" in light mode today, the
trainer will flip back to dark mid-flow. v3.10.113 does NOT touch
these. Either do a full migration in v3.11.0, or skip them entirely
(they're modal flows; the user doesn't expect theme parity).

## Files

Mobile:
- `src/theme/tokens.ts` (palette upgrade; new fields on `Theme`
  type; matching fields added to dark theme)
- `src/screens/HomeScreen.tsx` (theme chrome migration — header,
  tab bar, input bar, attachment preview, settings button, text
  input, status indicator)
- `src/screens/CompanionSettingsScreen.tsx` (root container bg)
- `src/screens/CompanionEditScreen.tsx` (root container bg)
- `src/screens/QuestsScreen.tsx` (root container bg)
- `src/screens/WakeModeScreen.tsx` (root container bg)

## Lessons

- **"More forest + sky" was a feeling, not a list of hex codes.**
  Tobe's screenshot was the right diagnostic surface — I could
  see that the bg was too bright and the cards were pure white,
  which made the green accents feel like decorations on a white
  page instead of colors of a forest. The fix was bumping the bg
  into a sage and the cards into a mint, not adding more
  decorative green.
- **"All pages" meant the big four screens, not literally every
  pixel on every screen.** The trainer sub-screens still feel
  dark when you tap them. That's a known scope cut — we ship
  the change that gets 80% of the feel, not the change that
  takes 4x longer for 100% coverage.
- **Symmetric `Theme` types across palettes.** First pass only
  added new fields to the light theme, which made the dark theme
  fail to assign to `Theme`. Symptom: `Type '"#0a0a0a"' is not
  assignable to type 'Theme'`. Fix: add the same fields to the
  dark theme, even if they're not used by the dark side yet.
- **Don't try to migrate HomeScreen in one shot.** 4839 lines of
  hardcoded hex. Doing a full migration would take 4+ hours and
  probably break things. The chrome-only migration (header, tab
  bar, input bar, attachment preview) took 5 minutes and gets
  the user-visible surface right. The rest can come in v3.11.0.

## What's next

- v3.11.0: full inner-style migration for HomeScreen,
  CompanionSettingsScreen, CompanionEditScreen, QuestsScreen,
  WakeModeScreen, and the trainers.
- Desktop v3.3.14: same tokens + theme toggle, wires into the
  existing Dark/Light buttons in Settings.

versionCode: 337
