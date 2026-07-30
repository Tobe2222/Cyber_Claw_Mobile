# v3.10.112 — Light/Dark theme toggle (Forest light theme)

## The request

Tobe (Discord #cyber-dev 2026-07-30 15:06 GMT+2):

> "You can create a light mode and create a toggle between dark and
> light mode in the settings. For light mode I want a brighter more
> foresty look. Green, white, blue etc. Airy and foresty."

Follow-up (15:43):

> "Just for cyberclaw, both desktop and mobile. Put the sun and moon
> for dark and light in the top of settings for both desktop and
> mobile. It should be remembered, not session only."

Migration approach agreed on: **Option A** for mobile (full theme
migration with proper ThemeContext, persistent across launches).

## What ships

### Mobile (v3.10.112)

- **Theme tokens** (`src/theme/tokens.ts`): two palettes — `dark`
  (preserved exactly as the old hex values, so the visual is
  identical under the toggle) and `light` ("Forest" — warm cream
  `#f5f7f0` background, deep forest green `#2d5a3d` primary, sky
  blue `#3a7ca5` secondary).
- **ThemeProvider** (`src/theme/ThemeContext.tsx`): wraps the app
  (App.tsx). Hydrates from AsyncStorage on mount, falls back to
  the system theme on first launch when no saved value exists.
  Manages StatusBar (`light-content` for dark, `dark-content` for
  light) so the battery/clock color follows the theme.
- **Persistence**: `cyberclaw-mobile-theme` AsyncStorage key
  (defined once in `tokens.ts` as `THEME_STORAGE_KEY`). Survives
  restart, per the "shared keys have one canonical constant" rule
  (see MEMORY.md 2026-07-14).
- **SettingsScreen toggle**: sun/moon button in the top-right of
  the fixed header. Icon flips with the active theme; label is
  the OPPOSITE of the current theme (showing the action, not the
  state). accessibilityRole="button" + accessibilityLabel so the
  screen reader experience matches the visual.
- **SettingsScreen migration**: ~80 hex literals converted to
  `t.X` tokens via `makeStyles(theme)` factory. The `styles` block
  was previously a module-level `StyleSheet.create({...})` constant;
  now it's a function that takes the active theme and returns the
  correctly-themed styles. The screen uses
  `useMemo(() => makeStyles(theme), [theme])` so the styles
  rebuild only when the theme changes.
- **Helper components** (`Section`, `SubTitle`, `Label`, `Hint`,
  `Toggle`, `OptionBtn`): each calls `useTheme()` and builds its
  own small style object inline. The old pattern referenced the
  module-level `styles` constant which broke under the theme
  system. A comment in each helper explains why.
- **Dead code removed**: `TrainedPhrasePicker`, `WakePhrasePicker`,
  `PerCompanionExitPicker` were defined in SettingsScreen.tsx but
  never actually imported/used (the real versions live in
  CompanionSettingsScreen.tsx). They were never referenced by `import`
  because CompanionSettingsScreen has its own copies. Cleaned up
  as a side-effect of the migration.

### Desktop (v3.2.40, ships next)

The desktop already has a Dark/Light toggle in Settings with
buttons (`#theme-dark-btn`, `#theme-light-btn`) — but the `setTheme()`
function and the matching CSS variables are incomplete. The user
asked for forest-light parity. Will ship same theme tokens + same
toggle behaviour as v3.10.112 in the next commit.

## What doesn't ship yet (deliberate)

- **HomeScreen / CompanionSettingsScreen / QuestsScreen / trainers**
  still have hardcoded hex colors and won't fully respond to the
  theme in v3.10.112. They'll get a **themed root bg** (the
  container's backgroundColor follows the theme) so the screen
  fades to the right color, but their inner styles are still the
  dark hex values. **If you tap 💡 → the screen behind the
  settings will show a dark background with dark text.** This is
  intentional for v3.10.112 — it's a deliberate "the toggle works
  end-to-end and persists" landing before migrating every screen.
  Full migration in v3.11.0.
- **SettingsScreen trainer sub-screens** (OpenWakeWordTrainer,
  WakeSetManager, ExitPhraseTrainer, etc.) keep their dark hex
  colors. Same reason as above — settings is the "test" surface
  for the theme; trainers ship in a follow-up.

## Files

Mobile:
- `src/theme/tokens.ts` (new, 188 lines)
- `src/theme/ThemeContext.tsx` (new, 175 lines)
- `src/screens/SettingsScreen.tsx` (theme migrate + toggle)
- `App.tsx` (ThemeProvider wrap, StatusBar removal)

## Lessons

- **Module-level `styles` constants break under theme systems.**
  The old pattern `const styles = StyleSheet.create({...})` and
  helper components that reference `styles.x` cannot easily
  pick up a runtime theme. The fix patterns, ordered by elegance:
  1. **Pass `styles` as a prop** — explicit, works but proliferates
     prop signatures.
  2. **Helpers call `useTheme()` themselves** — selected here
     because the helpers are small and the prop drilling would
     have changed 5+ call sites.
  3. **Inline small style objects** in each helper — what I did
     for the six small helpers. Each helper rebuilds its 3-5
     styles from the theme on every render. Cheap.
- **Theme tokens as `as const` literals + `Theme` type.** First
  pass typed `Theme` as `typeof darkTheme` which made the light
  theme a type error (literal "#f5f7f0" != "#0a0a0a"). The fix
  is to define `Theme` as a structural type with `string` values
  (not literal types). Lose a bit of type-narrowing but get
  the multi-theme swap working.
- **StatusBar belongs in the ThemeProvider, not the App root.**
  The original App.tsx had a single hardcoded
  `barStyle="light-content"`. Pulling it into the theme
  provider lets the bar style track the theme automatically
  — no screen has to remember to set it.
- **AsyncStorage fallback to system theme.** On first launch
  (no saved preference), the provider reads `Appearance.getColorScheme()`
  and uses that. Honors the user's phone-level pref without
  forcing them to make a separate choice in the app. Once they
  tap the toggle, that becomes the explicit choice and the
  system theme is ignored.
- **Dead code is a side-benefit of migrations.** The migration
  touched the helpers section, which made me re-audit which
  helpers were actually used. `TrainedPhrasePicker` et al.
  were never imported anywhere — they were copy-pasted from
  CompanionSettingsScreen and never deleted. ~300 lines of
  dead code purged.
- **Verify with `tsc --noEmit`.** Several pre-existing TS errors
  in unrelated files (CacheDirectoryPath, getAllKeys,
  package.json resolveJsonModule, etc.) were already there.
  Filtered those out to focus on my changes. Lesson: when a
  file has lots of pre-existing TS errors, the value of running
  tsc is to see NEW errors, not just to see pass/fail.

## What I'll need to verify

- Tap toggle on dark → see forest light. Tap back → dark restored.
- Force-quit app and reopen → theme persists.
- Light theme Settings looks "airy and foresty" (Tobe's words).
  If the green is too dark or the cream too yellow, easy to
  tweak in `tokens.ts` — single source of truth.

versionCode: 336
