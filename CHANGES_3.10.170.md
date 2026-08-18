# v3.10.170 — quest action row cleanup: remove the pointless white square, put Set active in the middle

## What Tobe reported (2026-08-18)

> "See image, in the quest settings there is a white square at the bottom right of each quest, no clue what this does but i dont need it. And the set as active can be in the middle there, so we have edit to the left, delete on the right and set as active in middle."

Two distinct nits on the same card. Both fixed in this build.

## What changed

### 1. The "white square" was the 🏁/◻️ complete-toggle button

The middle button on each quest card was a complete-toggle (Tobe-requested v3.10.134). The open-state icon was `◻️` (WHITE MEDIUM SQUARE, U+25FB) — a real Unicode digit block, not a custom render. On Android (and most rendering libraries) it shows as a small white filled square, which is exactly what Tobe saw.

He had no idea what it did. It was added three weeks ago as a convenience to flip a quest between `active` and `completed` from the card list — but the dedicated desktop quest UI already has the same toggle via `toggleQuestStatus` (see `src/js/app.js:1644`), and the same status is visible at a glance from the card header (✅ Done / ⚔️ Active) and the detail modal.

→ **Removed.** The 🏁/◻️ button and its `handleToggleComplete` helper are gone. The only path to toggle a quest's status is now the desktop side, which is the source of truth anyway.

### 2. Action row order: Edit → Set active → Delete (no more flex spacer)

The v3.10.83 layout was:

```
[ ✏️ Edit ]   ←flex 1 spacer→   [ ⭐ Set active ]   [ ◻️ Complete ]   [ ✕ Delete ]
```

The flex spacer pushed SetActive toward the right edge to "balance" with the secondary buttons. Tobe wanted them grouped as `Edit → Set active → Delete` with SetActive in the middle.

New layout:

```
[ ✏️ Edit ]   [ ⭐ Set active ]   [ ✕ Delete ]
```

No flex spacer. The three buttons sit together with the existing `gap: 6` from `cardActions`. SetActive keeps its prominent gold/green pill (it's the only labeled one). Edit and Delete remain small icon-only chips on the edges.

The trailing ✕ stays exactly where it was. The intent of the old v3.10.83 layout ("destructive actions on the edge, infrequent") is preserved.

## Files touched

- `src/screens/QuestsScreen.tsx`
  - Removed the v3.10.134 complete-toggle `TouchableOpacity` (🏁/◻️).
  - Removed `<View style={{ flex: 1 }} />` spacer between Edit and SetActive.
  - Reordered: Edit (left) → SetActive (middle) → Delete (right).
  - Removed now-unused `handleToggleComplete` helper.
  - Removed now-unused styles: `cardCompleteBtnActive`, `cardCompleteBtnText`, `cardCompleteBtnTextActive`.
  - Updated the action-row comment block to document the new layout.
- `android/app/build.gradle`: versionCode 379 → 380, versionName "3.10.169" → "3.10.170".
- `package.json`: version "3.10.169" → "3.10.170".

No changes to the editor modal, the no-quest card, the detail modal, or the sync protocol. Quest status is still readable from the card header (✅ Done / ⚔️ Active) and the detail modal.

## Verification

- `tsc --noEmit` over the full project: no new errors in `QuestsScreen.tsx`. The single pre-existing error (line 1357, `insets` possibly undefined) is unrelated to this change.
- No other screen or component references `handleToggleComplete` or the removed `cardCompleteBtn*` styles.
- Sync protocol unchanged — the complete-toggle was a thin wrapper over `handleUpdateQuest(id, { status: ... })`, which now only fires from the desktop.
