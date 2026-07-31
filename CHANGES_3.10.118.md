# v3.10.118 — Companion tab fix + arena background picker

## What ships

Two distinct changes in this version:

### 1. Companion tab: forest theme, not orange

Tobe (Discord #cyber-dev 2026-07-31 15:45 GMT+2) reported
that v3.10.116's dark-mode tab fix (forest instead of
orange) wasn't enough — the **active companion tab** still
shows bright orange:
- background: `rgba(247,147,26,0.18)`
- border: `#f7931a`
- text: `#f7931a`

That fights the home-screen forest palette even after
v3.10.114-117's scene-zone migration.

**Fix:** `companionTabActive` and `companionTabNameActive`
moved to theme tokens:
- `companionTabActive` bg: `t.bg.forestDark`
  (`#1f3d28` — deep forest green)
- `companionTabActive` border: `t.border.strong`
  (`#5b7a4a` — deep forest)
- `companionTabNameActive` color: `t.text.primary`
  (white in dark, charcoal in light)

The active tab still pops (deeper green against the dark
forest tab bar bg) but matches the home-screen palette
instead of shouting brand-accent orange.

Light mode is also fixed (was already using the same
orange-active treatment, which looked just as off against
the warm-brown-earth tab bar from v3.10.115).

### 2. Arena background picker (mobile-only, not synced)

Tobe (same Discord message, 15:45 GMT+2):
> "Lets add the arena backgrounds into the mobile end
> also. These dont need to be synced. Put it in the
> bottom right of the arena."

The mobile arena already had `setBackground(id)`,
`loadBackground(id)`, and `bgImage` rendering baked
into `arena.html` (added v3.1.50 when the wake-mode
visual was introduced). v3.10.118 just adds the UI
to pick one:

- New `#ctrlBottomRight` container in the bottom
  right of the arena (mirrors `#ctrlBottomLeft`)
- New `🌄` button that opens a local picker menu
  (`#bg-menu`)
- Picker shows 4 options: None / Forest / Meadow /
  Grove — each with a small thumbnail of the
  background
- Selection calls `setBackground(id)` and persists
  to `localStorage['cyberclaw-mobile-arena-bg']`
- The "None" option clears `bgImage` directly (bypasses
  `loadBackground` which always tries to load an
  image)
- Auto-close menu after selection
- The two pickers (`#feed-menu` from v3.10.75 and
  `#bg-menu`) are mutually exclusive — opening one
  closes the other

**Not synced:** the selection lives in
`window.localStorage` inside the WebView. No WebSocket
message to the desktop, no companion-state propagation.
Tobe explicitly said "These dont need to be synced."

**Hidden in wake/voice mode** (matches the existing
`#feed-menu` behaviour — the arena is fullscreen for
those modes and the picker would be visual noise).

## Files

- `src/screens/HomeScreen.tsx` — `companionTabActive` and
  `companionTabNameActive` styles migrated to theme tokens
  with v3.10.118 comments explaining the v3.10.116 oversight
- `android/app/src/main/assets/arena.html` — added
  `#ctrlBottomRight` CSS + HTML + `🌄` button, `#bg-menu`
  CSS + HTML + JS (`toggleBgMenu`, `selectBg`,
  `refreshBgMenuSelection`, `wireBgMenu`), localStorage
  read at boot for the saved background selection
- `package.json` + `android/app/build.gradle` — version
  bumps (3.10.117 → 3.10.118, versionCode 341 → 342)

## Pre-push checks (all green)

- `npx react-native bundle --platform android --dev false`
  → no parse errors
- `npx tsc --noEmit` → 0 new errors (baseline 79
  unchanged; arena.html is a static asset, not touched
  by tsc)
- Module-scope free-variable grep on bundle → 0
  suspicious references

## Lessons

1. **v3.10.116 was a partial fix.** The dark-mode
   `companionTabBar` style (the bar holding the tabs)
   was correctly switched to `bg.forestDark`, but the
   individual `companionTabActive` and
   `companionTabNameActive` styles (the active tab
   itself) were left on the orange brand-accent
   treatment. The orange ACTIVE state was the louder
   visual issue — fixing the bar was necessary but
   not sufficient. v3.10.118 completes the work.

2. **Both light and dark modes get the orange-active
   issue.** My v3.10.115/116 design review said
   "dark mode orange on dark is loud; light mode
   orange on warm-brown is fine." That was wrong —
   the screenshot Tobe sent shows light mode would
   have the same problem (orange active tab on
   warm-brown earth tab bar = orange shouting on
   warm earth). The fix doesn't gate on `t.name`
   for that reason.

3. **Existing infra is often the right starting
   point.** The mobile arena had `setBackground(id)`,
   `loadBackground(id)`, `bgImage`, and
   `drawBackground()` since v3.1.50. The 3 background
   images were already bundled in
   `android/app/src/main/assets/backgrounds/`. v3.10.118
   is ~100 lines because none of the plumbing had to
   be built — just the picker UI + localStorage
   persistence. **Always check for existing
   half-implementations before designing new infra.**

4. **The bg-menu and feed-menu should be mutually
   exclusive.** Both live in the same screen space
   (bottom of arena) and both open on button-tap.
   Without explicit "close the other when opening
   this" logic, the user could end up with both
   menus visible at once, looking like a bug. v3.10.118
   adds the cross-close in `toggleBgMenu`.

## What I didn't do

### Quest refresh "didn't fetch the quest clawsuu allegedly created"

Tobe also reported (same message) that tapping the
v3.10.117 refresh button on the Quests page "did not
fetch the quest clawsuu allegedly created". Investigation
found:

- The refresh button itself works correctly —
  `syncClient.requestQuestsList()` sends
  `{type: 'request_quests_list'}`, the desktop's
  `onRequestQuestsList` callback calls
  `broadcastQuestsList(loadQuests())`, and the
  `quests_list` broadcast lands on mobile.
- The desktop's `quests.json` at
  `~/.openclaw/cyberclaw/quests.json` contains
  3 quests: Cyber_School, CYBERHIVE_WEBSITE V3,
  HIVE_CONTROL. **Cyber_Music is NOT in the file.**
- The directory Tobe was told about
  (`/media/humpsuu/CYBERDRIVE/2B/work/cyber_music`)
  also does not exist.

The agent (clawsuu) said "Cyber_Music exists, it's
active" — that was confabulation. The mobile's empty
Quests page is correct: the quest was never created on
the desktop. The fix isn't on the mobile side; it's
either:
- tell clawsuu to actually call the `create_quest`
  tool with `name: "Cyber_Music"` and a valid
  directory, or
- create the quest manually in the desktop's 📜
  Quests panel

Then it will appear on mobile (either via the
broadcast from the desktop, or by tapping the refresh
button).

This is an agent behavior issue, not a sync bug. Worth
noting but out of scope for v3.10.118.