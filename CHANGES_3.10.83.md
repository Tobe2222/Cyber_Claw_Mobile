# v3.10.83 — prominent "Set as active" button (v3.10.82 follow-up)

Tobe reported on v3.10.82 (2026-07-23, ~12:21):

> "@Clawsuu I still dont see a set as active button
> on the right side of the quests here. That star is
> it perhaps but thats not intuitive. Create a bigger
> set as active button on the right side of each as
> i asked for"

Screenshot showed the v3.10.82 layout: ☆ on the
right side of the Cyber_School card next to ✕, both
as small icon-only buttons. Tobe correctly identified
that the star was the new toggle — but at the same
visual weight as ✕ (same icon size, same button
size, similar positioning), it didn't read as a
primary action.

## Root cause

v3.10.82 moved ☆ from the left to the right but kept
it as a small icon-only button (`cardActionBtn`
style: 16pt icon, 8dp/4dp padding, no border, no
label). At that size, it visually competed with ✕
(both 16pt icons, similar weight) and the user's
eye didn't pick it up as "the action I need".

Two compounding issues:
1. **No label** — the star icon doesn't read as
   "set as active" to anyone who hasn't seen the
   pattern before. Icons that mean "active" are
   ambiguous (★? ✓? ☆? ⊙?) and dependent on context
   the user may not have.
2. **Same visual weight as the delete button** —
   ☆ and ✕ are both small icons in the same row.
   They're treated as equals; the user has no signal
   that ☆ is the primary action and ✕ is destructive.

## Fix

Replace the small icon-only ☆ with a **prominent
labeled pill button** on the right side:

```
[ ✏️ Edit ]    [ ☆ Set active ]  [ ✕ ]
```

(✏️ stays as a small icon-only button on the LEFT —
it's a secondary action that opens the editor. ✕
stays as a small icon-only button on the FAR RIGHT
edge — destructive actions belong on the edge and
should be small enough not to invite accidental
taps.)

### Button states

**Inactive quest** (the common case):
- Star icon (☆) + "Set active" text
- Gold border (`#f7931a`)
- Soft gold background (`rgba(247,147,26,0.15)`)
- Gold text
- Pill shape (`borderRadius: 18`)

**Active quest:**
- Check icon (✓) + "Active" text
- Green border (`#10b981`)
- Soft green background (`rgba(16,185,129,0.18)`)
- Green text
- Same pill shape

The green state confirms the active state at a
glance without making the user look up to the ACTIVE
banner at the top of the card. The two visual cues
(gold banner + green button) are deliberately
different colors — gold says "this is the active
quest", green says "this button shows the active
state" — so they don't compete.

### Bonus behavior: tap active to deactivate

Tapping the green "✓ Active" button deactivates the
quest (sets `id: null`, jumping to the "no active
quest" default). Mirrors the no-quest card's
behavior — gives the user a way to clear the active
quest without scrolling back to the top of the list.

## Files changed

- `src/screens/QuestsScreen.tsx`:
  - Replaced the `!isActive` `<TouchableOpacity>☆</TouchableOpacity>`
    with a labeled `<TouchableOpacity>` that switches
    between "☆ Set active" (gold) and "✓ Active" (green)
    based on `isActive`
  - Tap-on-active now deactivates (calls
    `handleSetActive(null)`)
  - Bumped `cardActions.gap` from 4 to 6 for breathing
    room around the bigger button
  - Bumped `cardActionBtn.paddingVertical` from 4 to 6
    for visual consistency with the new button height
  - Added new styles: `cardSetActiveBtn`,
    `cardSetActiveBtnActive`, `cardSetActiveBtnIcon`,
    `cardSetActiveBtnText`,
    `cardSetActiveBtnTextActive`
- `android/app/build.gradle` — versionCode 306→307,
  versionName 3.10.82→3.10.83
- `package.json` — version 3.10.82→3.10.83

## Lessons

**Visual weight matters more than position.** Moving
☆ from the LEFT to the RIGHT (v3.10.82) put it in
the right place. But the user still couldn't find it
because the visual weight was wrong — a small
icon-only button competes with other small
icon-only buttons regardless of position. The fix
wasn't about position, it was about giving the
button more visual prominence via size + border +
background + label.

**Icon-only buttons are an anti-pattern for primary
actions.** When an action is the primary thing the
user wants to do on a screen, it needs a label. Icon
+ text reads faster than icon alone, especially when
the icon is ambiguous (☆ could mean favorite, rate,
star, set-active, etc.). Save icons for secondary
actions (edit, delete) where the user has already
decided what they want to do and just needs the
control to be there.

**Color is a state indicator, not decoration.**
Using green for "this is currently the active state"
and gold for "tap to make active" creates a clear
read: green = current/correct, gold = action
available. The two states are visually distinct
without needing the user to read the text. The user
can scan cards quickly and find the active one
because it's the only green button in the row.

**Two-stage UX fixes are common.** v3.10.82 fixed
the structural issue (position); v3.10.83 fixes the
visual prominence issue (weight). Both fixes are
needed — position alone wasn't enough. When the user
says "still don't see it" after a position fix, the
issue isn't position anymore, it's weight.