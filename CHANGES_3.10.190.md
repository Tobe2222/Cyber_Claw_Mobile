# v3.10.190 — Quests screen: deactivate button + remove middle dashed card

Tobe (2026-09-07 07:18, Discord #cyber-dev, post-v3.10.189 screenshot):
"I dont need a pill for the active quest. I need a button
to deactivate current in the top, the 'pill'. And remove the
superflous no active quest in the middle of everything there."

## What changed (vs v3.10.189)

### 1. Pill → Button (when active)

The v3.10.189 green `✓ {quest name}` pill was just an info
chip. Tapping it didn't do anything useful (the only way to
deactivate was to scroll down to the dashed "No active quest"
card).

Now the green pill is a **TouchableOpacity** that calls
`handleSetActive(null)` on tap. Visual change: added a `✕`
icon at the right edge of the pill so the destructive action
is obvious. Tap → set_quest_active(null) → desktop broadcasts
→ green pill swaps to the red `● No active quest` pill, the
previously-active quest moves down into the inactive list,
the active card is removed from the pinned-top position.

`accessibilityLabel` set to `Deactivate quest {name}` so
screen-reader users get a clear label.

### 2. Removed the dashed "No active quest" card from the middle of the list

The dashed card was redundant once the green pill at the top
became a real deactivate button. There were two ways to do
the same thing in different parts of the screen, which made
the middle of the list visually busy.

List order is now:
- `[active quest pinned at top]` (when active)
- `[all other quests]`

No more middle card. Cleaner visual hierarchy. The red pill
in the header (when nothing is active) tells the user the
default state.

Dead styles removed: `noQuestCard`, `noQuestCardActive`,
`noQuestCardDesc`, `noQuestCardHint`.

### 3. Visual tweaks to the pill → button transition

The green button is now a row layout (flexDirection: row +
gap: 8) so the quest name and the ✕ icon sit cleanly
side-by-side with a small gap. The pill's `maxWidth` bumped
from 90% to 92% to fit the ✕ without truncating the quest
name. `paddingVertical` 5 → 6 to keep the touch target
comfortable (now it's a real button, not just a chip).

## Files changed

- `src/screens/QuestsScreen.tsx` — pill → TouchableOpacity
  button with ✕ icon, removed dashed card + 4 dead styles.
- `package.json` (3.10.189 → 3.10.190),
  `android/app/build.gradle` `versionName` (3.10.189 →
  3.10.190) and `versionCode` (396 → 397).
- `CHANGES_3.10.189.md` — superseded; this file describes
  what actually shipped (v3.10.189 was the same code as
  v3.10.190 plus the middle card and the non-tappable pill).

## Verification

- TypeScript: `tsc --noEmit` introduces zero new errors.
  The pre-existing `insets.top` possibly-undefined warning
  (line ~1407) is unrelated and was already on v3.10.188.
- Manual mental test:
  1. Quest `HIVE_CONTROL` is active → green button "✓
     HIVE_CONTROL  ✕" visible at the top. Cards below:
     [HIVE_CONTROL] → [Cyber_Database] → [Cyber_Repair].
     No middle dashed card.
  2. Tap the green button → handleSetActive(null) fires →
     desktop broadcasts → header swaps to red pill "● No
     active quest", HIVE_CONTROL moves into the inactive
     list (no longer pinned at the top, no purple border,
     no ACTIVE banner).
  3. Tap "☆ Set active" on Cyber_Database → green pill
     reappears with "✓ Cyber_Database  ✕", that card
     pins to the top with the purple border + ACTIVE
     banner, HIVE_CONTROL sits below in the orange
     inactive list.

## UX lessons

- **Status pills should either be info-only OR actionable
  buttons — never both ambiguously.** v3.10.189's pill
  looked tappable (pill shape + green active styling) but
  only opened a detail modal that wasn't the action you
  wanted. Now the green pill IS the action, with a ✕
  icon to make it obvious.
- **Don't keep redundant toggles when you consolidate one
  into a header affordance.** The dashed card and the
  pill both said "deactivate the active quest." Once the
  pill became a real button, the dashed card had no role.
  The page now has ONE way to do each thing.
