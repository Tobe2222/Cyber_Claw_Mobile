# v3.10.186 — Companion editor: split into Looks + Behaviour pages

Tobe (2026-09-04 16:08, Discord #cyber-dev, screenshot):
"@Clawsuu Okey cool. But I meant a looks section in the editor, not
inside the behaviour."

## Context

The v3.10.185 fix added inline `🎨 LOOKS` and `🎭 BEHAVIOUR` group
labels inside the editor scroll, but the parent
`CompanionSettingsScreen` still had a single Behaviour card
holding Sprite + Scale + Chattiness + Traits under one heading.
Tobe's screenshot showed the card layout clearly: he wants each
section group to be its own card with its own Edit button, not
visual sub-groups inside one giant editor page.

## Fix

### 1. Two editor screens, one per scope

`CompanionEditScreen` now takes a `mode` prop:

```tsx
mode?: 'looks' | 'behaviour';
```

- `mode='looks'` — renders Name + Sprite + Size
  (everything about visual identity)
- `mode='behaviour'` — renders Chattiness + Personality Traits
  (everything about how the companion acts)

Both modes share the same backing state (the `spriteConfig` patch
in refs) and the same auto-save-on-unmount path. The patch sent
to the desktop on unmount is always the full set of fields the
screen touched; the desktop's `sprite_config_sync` merges
idempotently so partial-mode edits never clobber the other side.

The read-only Soul and Memory sections are visible on both modes
(they're informational, not mode-specific).

### 2. Two parent cards, one per scope

`CompanionSettingsScreen` now renders two cards where it used to
render one Behaviour card:

- **🎨 Looks** — Sprite + Scale rows
  Edit button → opens the Looks editor
- **🎭 Behaviour** — Chattiness + Traits rows
  Edit button → opens the Behaviour editor

The card layout matches Tobe's screenshot exactly: same
border-radius, same padding, same Edit button styling.

### 3. App.tsx routes

Two new top-level routes:
- `'companion-edit-looks'` — wires to the Looks editor
- `'companion-edit-behaviour'` — wires to the Behaviour editor

The legacy `'companion-edit'` route is kept as an alias — it
renders the Behaviour editor (the dominant section) so any
in-flight deep links still work.

### 4. Backward-compat

The legacy `onOpenCompanionEdit` callback is preserved on
`CompanionSettingsScreen`. Each card's Edit button uses the new
`onOpenCompanionLooks` / `onOpenCompanionBehaviour` callbacks
when available, and falls back to `onOpenCompanionEdit` (which
routes to the Behaviour editor) if App.tsx hasn't wired the new
callbacks yet. This means a half-deployed build (new App.tsx +
old CompanionSettingsScreen, or vice versa) still has working
Edit buttons.

## Files changed

- `src/screens/CompanionEditScreen.tsx` — added `mode` prop,
  split section rendering with `{mode === 'looks' ? <>...</> :
  null}` / `{mode === 'behaviour' ? <>...</> : null}` gates,
  updated the screen header to show the mode suffix
  ("Edit Clawsuu — Looks" / "Edit Clawsuu — Behaviour"),
  removed the inline group labels (they're no longer needed
  since the page only shows one section group now).
- `src/screens/CompanionSettingsScreen.tsx` — split
  `renderBehaviourCard` into `renderLooksCard` (Sprite + Scale)
  + `renderBehaviourCard` (Chattiness + Traits), added the two
  new callback props with destructuring, render both cards in
  place of the single card.
- `App.tsx` — added two new screen types to the
  `useState` union, two new callback props on
  `CompanionSettingsScreen`, two new routes that branch on
  `screen === 'companion-edit-looks'` vs
  `screen === 'companion-edit-behaviour'`. The legacy
  `'companion-edit'` route still works as a Behaviour alias.
- `package.json` (3.10.185 → 3.10.186), `android/app/build.gradle`
  `versionName` and `versionCode` (392 → 393).

## Verification

- TypeScript: `tsc --noEmit` produces zero new errors in the
  three touched files. The two pre-existing errors
  (`App.tsx:770` exit-trainer prop mismatch and
  `CompanionSettingsScreen.tsx:473` companion shadowing) are
  unrelated to this change.
- Manual flow: open a companion → Looks card → tap Edit ›
  → land on Looks editor (Name + Sprite + Size only).
  Back swipe → return to companion settings. Tap Behaviour
  Edit › → land on Behaviour editor (Chattiness + Traits
  + Soul + Memory).
- The auto-save-on-unmount handler runs the same in both
  modes. The patch sent to the desktop on unmount includes
  the latest values from refs (which mirror state via the
  useEffect chain) so both modes write to the same
  `spriteConfig` on the desktop.

## General lesson

When you split a single screen into multiple focused screens,
make the "scope" prop explicit (`mode`, `tab`, `step`) rather
than adding parallel routes to parallel components. The split
screen reuses all the same state, refs, and effects; the
differences are pure render-time decisions. Two screens with
~95% shared code is a clear signal that they should be one
component with a discriminator, not two components.

The visual separator (group label) inside the v3.10.185
editor was a hint at the real split. When a user pushes back
on a grouping like "this should not be inside X", the answer
is usually "yes, this is its own page" — not "make the
separator more prominent".
