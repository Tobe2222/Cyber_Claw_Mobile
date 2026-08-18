# v3.10.171 — fix the action row that v3.10.170 broke

## What Tobe reported (2026-08-18)

> "@Clawsuu you little goblin. Now you put all of it on the left side."

Screenshot showed `[✏️] [Set active] [✕]` all crammed against the left edge of each quest card, with the right half of the row empty.

## Why v3.10.170 broke the layout

I removed **both** flex spacers in v3.10.170, reasoning "tight `gap: 6` between the three buttons will group them naturally." Wrong. The `cardActions` row is `flexDirection: 'row'` with no `justifyContent` set, so without spacers the row left-aligns all three buttons together with just the inter-button `gap`. The user wanted the **prominent** Set-active pill visually centered, not crammed next to Edit.

## What changed

One line addition: a second `<View style={{ flex: 1 }} />` spacer **after** SetActive, mirroring the one that already exists before it. With the row now `[✏️] [<flex 1>] [⭐ Set active] [<flex 1>] [✕]`:

- Edit anchors to the **left edge**.
- Set-active floats in the **middle** (centered between the two equal-flex spacers regardless of label width — works for "Set active" English, "Aktivér" Norwegian, or "✓ Active" when the quest is already active).
- Delete anchors to the **right edge**.

No style changes. No new components. Same `cardActions` container, same `gap: 6` between adjacent siblings, same three buttons.

## Files touched

- `src/screens/QuestsScreen.tsx`
  - Added one `<View style={{ flex: 1 }} />` spacer between the SetActive button and the Delete button.
  - Updated the action-row comment block to document the new spacer pattern and to call out the v3.10.170 mistake so the next person doesn't make the same wrong call.
- `android/app/build.gradle`: versionCode 380 → 381, versionName "3.10.170" → "3.10.171".
- `package.json`: version "3.10.170" → "3.10.171".

The first spacer (between Edit and SetActive) was always present — v3.10.170 just deleted it along with the complete-toggle. The single-spacer version puts SetActive somewhere in the right half of the row but not centered; the two-spacer version is what Tobe actually wanted.

## General lesson

When you have a row of N visually-different-width items and want one of them **centered**, the right tool is two flex spacers bracketing it (`[a] [spacer] [center] [spacer] [c]`), not `<justifyContent: 'center'>` (which centers the *group*, leaving dead space on both edges) and not removing all spacers (left-aligns everything). Two equal-flex spacers give you a true center anchor for the middle item regardless of its width.

## Verification

- `tsc --noEmit`: no new errors in `QuestsScreen.tsx`. The single pre-existing error (line 1376, `insets` possibly undefined) is unrelated.
- No other layout change. The white-square removal from v3.10.170 stays intact.
