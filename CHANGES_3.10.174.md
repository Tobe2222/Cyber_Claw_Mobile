# v3.10.174 — Skills reachable + "less Clawsuu"

Tobe's feedback after installing v3.10.173: "I don't see any of
the updates." Two honest problems:

1. **Skills library was unreachable.** v3.10.173 built the
   `SkillsScreen` but the only path to it was an `'skills'` IPC
   message from `arena.html`, which has no Skills button. The
   screen existed in the APK but had no UI entry point.
2. **"Less Clawsuu" duplicate-name fix was diagnosed but never
   shipped.** I told Tobe about the canvas name + RN caption
   overlap but never actually edited anything in v3.10.173.

This release fixes both.

## What's new

- **Skills library entry point on the companion settings page**
  (`src/screens/CompanionSettingsScreen.tsx`). New
  `📚 Skills library` card sits between the Behaviour card and
  the SETTINGS separator. Tap → opens `SkillsScreen` pre-bound
  to the current companion (`activeCompanionId={companionId}`,
  `activeCompanionName={companion.name}`), so the per-companion
  toggle pills work immediately with no companion picker.
  Back button on `SkillsScreen` pops back to the originating
  companion settings page, NOT home. `App.tsx` got a
  `skillsCtx` state for the new route + companion-scoped
  navigation.

  **Per Tobe's instruction "Skills in the companion settings,
  nowhere else":** the only Skills entry point on the mobile
  is now this card. Removed the `HomeScreen.onOpenSkills`
  IPC handler that v3.10.173 added (was a dead prop — no
  arena button sends the message). The `onOpenSkills` prop
  on HomeScreen remains optional so adding an arena button
  later doesn't need to change the type.

- **"Less Clawsuu" — duplicate name suppression in the
  companion view box.** The view box had two `Clawsuu`
  labels stacked: one drawn by `arena.html` `drawName()` in
  big orange text above the centered boar, plus the
  `viewWindowLabel` React Native caption underneath
  (`Clawsuu · boar sprite`). The caption was a v3.10.145
  fallback for when the WebView fails to load (black-box
  case). Now:
  - Track an `arenaReady` state in CompanionSettingsScreen,
    flipped to true on receipt of the `arena_loaded` event
    from `arena.html` via WebView `onMessage`.
  - Hide the RN caption when `arenaReady` is true (canvas
    name is sufficient).
  - Caption reappears during the boot window (until
    `arena_loaded` arrives) as the graceful fallback for
    WebView load failure.
  - Companion switching doesn't reset `arenaReady` — the
    WebView source URI is static (no companion ID), so
    `arena_loaded` fires once per WebView lifetime, and the
    canvas name follows the active companion via
    `setActive`. Re-showing the caption on every companion
    switch would just cause a one-frame flash.

- **XP widget renamed "Skills" → "Experience"**. The
  v3.10.139 widget on the companion settings page used the
  label "Skills · Lv.1" (it shows XP earned by the companion
  over chats — a fun stat). With the Skills library now
  reachable, two "Skills" labels in the same view was
  confusing. Renamed to `⭐ Experience · Lv.1` to free up
  the "Skills" label for the library. The widget itself
  (XP grid, level number, fill bars) is unchanged.

## Files touched

- `App.tsx` — added `skillsCtx` state, wired
  `onOpenSkills` on CompanionSettingsScreen, removed
  `HomeScreen.onOpenSkills` (now a no-op), updated
  SkillsScreen route to use skillsCtx for back + active
  companion props.
- `src/screens/CompanionSettingsScreen.tsx` — added
  `onOpenSkills` prop, `arenaReady` state, WebView
  onMessage handler, conditional caption rendering,
  Skills library card markup + styles, XP widget label
  rename.

## Out of scope

- `arena.html` still doesn't show a Skills button. Per
  Tobe's "nowhere else" rule, that's the desired state.
  If he later wants the button, add it to the arena's
  `notifyRN({ type: 'skills' })` flow (HomeScreen already
  has the prop type ready).
- The Skills library still uses the same
  `request_skills_list` / `set_enabled_skills` sync
  protocol from v3.10.173 — no server-side changes.

## Bug-class lesson (for me)

v3.10.173 was the second mobile release in a row that
shipped "feature in code, no UI entry point" — the
SkillsScreen was added but unreachable. The CHANGES doc
even called this out as a follow-up, which I should have
treated as a "this is part of the same release, not a
follow-up" item. Rule: if a CHANGES doc lists an
"Out of scope" item that's directly required for the
shipped feature to be visible, the tag is incomplete.
