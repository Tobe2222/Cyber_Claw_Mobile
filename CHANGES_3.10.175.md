# v3.10.175 — Skyrim-style Experience card

Tobe's feedback after installing v3.10.174: the Experience card
was confusing. "Experience · Lv.1" with "No skills earned yet"
inside contradicted itself — a level-1 bar with no XP is
meaningless, and the per-category breakdown was hidden until
the companion earned any XP.

The Skyrim model Tobe wants:
> "It should just be a lvl bar which is driven by the
> different category xp and lvl ups, like skyrim is, when
> you lvl up something like enchanting you get a character
> xp increase. The character/companion exp bar should be
> clickable such that it shows the undercategory levels and
> their xp bars."

## What's new

- **Character XP bar always visible.** The companion's
  overall level + XP-toward-next + lifetime XP now live in
  a single bar at the top of the Experience section, shown
  even when collapsed. The desktop's `getStats()` already
  computes character level from the sum of category XP; the
  mobile just reads `companion.skills.level` /
  `companion.skills.xp` /
  `companion.skills.xpTotal` and renders them.

- **Tap to expand category breakdown.** Header row is
  tappable (whole row including title + chevron). Expanded
  state reveals all 9 category bars (Building / Writing /
  Design / Analysis / Strategy / Research / Communication /
  Game / General), each with its own Lv + XP bar. Same sort
  as the desktop renderer (highest XP first, ties by name,
  General last).

- **All categories always shown.** Previous behavior
  (`v3.10.139`–`v3.10.174`) hid categories with 0 XP. Now
  every category in `SKILL_DEFS` renders as a row, defaulting
  to `Lv.1 / 0xp` if no entry yet. The bar is empty but the
  row is visible — the user sees the full breakdown from
  the start. This matches the desktop's app.js:1137
  renderer which also shows all 9 categories at
  `{ level: 1, xp: 0 }`.

- **Removed "No skills earned yet" empty state.** Replaced
  with a single muted hint row when `companion.skills` is
  null (legacy agent / desktop hasn't run getStats):
  "Stats syncing from desktop…". No more
  "Lv.1 + no skills earned yet" contradiction.

- **Header layout updated.** Title is now `Experience ·
  Lv.N` (left), current XP / XP-to-next is right-aligned
  (e.g. `0 / 100 XP`). Subtitle shows lifetime XP total
  + "tap for categories" hint (or "stats syncing from
  desktop" if no stats yet). Chevron rotates 90° when
  expanded.

## Files touched

- `src/screens/CompanionSettingsScreen.tsx` —
  `experienceExpanded` useState added at the screen level
  (persists across re-renders within the screen, resets
  on remount). `renderSkillsSection` rewritten with the
  collapsible pattern + always-shown char bar. New styles:
  `charBar`, `charBarFill`, `skillsSectionXp`,
  `skillsSectionChevron`, `skillsSectionChevronOpen`.
- `package.json` + `android/app/build.gradle` — version
  bumps to 3.10.175 / versionCode 383.

## Out of scope

- The desktop-side XP/level curve (`100 * 1.5^(level-1)`)
  is unchanged. Mobile just renders what the desktop
  sends.
- No new IPC. Still uses the existing `agents_list`
  broadcast with `companion.skills` populated by
  `cyberclaw.agents.getStats(id)` on the desktop (added
  in desktop v3.2.84).

## Bug-class lesson (for me)

v3.10.174's Experience card was the same code from v3.10.139
(no change to the renderer). The label rename ("Skills" →
"Experience") was the only edit. That was a miss — Tobe
flagged the UX as confusing for a reason: the renderer
contradicts itself. The fix isn't a label rename, it's
making the data model match the user's mental model
(Skyrim-style: character bar drives from category bars,
categories are always visible).
