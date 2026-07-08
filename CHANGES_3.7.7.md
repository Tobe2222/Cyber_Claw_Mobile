# v3.7.7 — Quests screen: safe-area top padding + tap-to-detail modal

Two small UX fixes from user feedback on v3.7.6. No new wire protocol,
no data-model changes, no SyncClient edits. Just the QuestsScreen
itself.

---

## 1. Safe-area top padding

**Symptom:** Tobe's v3.7.6 screenshot showed the Quests screen
header ("← Back / 📜 Quests") butting up against the iOS status
bar — the "11:57" indicator was overlapping the "← Back" arrow.
This is the same status-bar / Dynamic Island issue the v3.4.5
companion settings fix addressed for CompanionSettingsScreen and
SettingsScreen, just one screen that hadn't been migrated yet
(it was new in v3.7.6).

**What changed:** `src/screens/QuestsScreen.tsx`.

- `scroll` style: `padding: 16` → `padding: 16, paddingTop: 50,
  paddingBottom: 64`. The 50pt top clears both Android status
  bars (~30-40dp) and iOS Dynamic Island (~30pt + safe area).
- `detailHeaderRow` style: added
  `paddingTop: Platform.OS === 'android' ? 34 : 10` for the
  extra system-bar height on Android (matches the v3.4.5 pattern
  in CompanionSettingsScreen).

The `SafeAreaView` in `App.tsx` handles the bottom inset; the
ScrollView still needs explicit top padding because the
SafeAreaView's top extends to the top of the device edge — we
want the scroll to start below the status bar.

---

## 2. Tap-to-detail modal

**Symptom:** Tobe: *"we should be able to click for a more
detailed view of the quest, its points/steps, directory etc."*

The v3.7.6 list card showed: name, status emoji, done/total,
progress bar, directory (last segment only). The full goal list,
the full description, and the full directory path were all
hidden — to see them, the user had to switch to the desktop.
On mobile, "tap a card to expand" is the universal pattern for
"this is a summary; the detail is one tap deeper." Long-press
was for the clipboard shortcut, not the detail view.

**What changed:** `src/screens/QuestsScreen.tsx`.

- Added a `Modal` (transparent, fade animation) rendered
  conditionally on the `detail` state (a single selected
  quest, or null).
- New `QuestDetailBody` sibling function — pure render, no
  hooks (per the v3.7.1 pattern). Renders inside the modal's
  ScrollView so long goal lists don't overflow the viewport.
- List card `onPress` → `setDetail(q)`. `onLongPress` still
  copies `quest.directory` to clipboard (unchanged).
- Hint text on the list updated from "Tap a card to copy the
  project path to clipboard" to "Tap a card for the full
  details. Long-press to copy the project path."

**Modal content:**

- Quest name (large, bold)
- Status badge ("Active" purple / "Completed" green) + done/
  total + percentage
- Full description (wrapped, no truncation)
- **Steps / goals** — every goal as a row with a checkbox
  glyph (☑ / ☐) and the text. Completed goals are greyed and
  struck through. Progress bar underneath.
- **Project directory** — full path in a monospace box, tap
  to copy to clipboard. Hint "Tap to copy" in the corner.
- Created date (formatted with `toLocaleString()`)

**Scrim pattern:** the scrim is a separate
`<Pressable style={StyleSheet.absoluteFill} onPress={close} />`
behind the card, not a parent-onPress with child stopPropagation.
`stopPropagation` on RN synthetic events is unreliable across
RN versions — the absoluteFill-sibling pattern is the standard
fix. Tapping the scrim or the "Close" button at the bottom of
the card dismisses; the modal also handles Android back via
`onRequestClose`.

**Modal sizing:** `maxWidth: 480, maxHeight: 85%`. On phones
the card stretches full-width minus 16pt padding; on tablets
or landscape it caps at 480pt so it doesn't sprawl. The 85%
maxHeight leaves room for the scrim to remain visible above
and below as a visual cue that there's a layer behind.

---

## Files touched

- `src/screens/QuestsScreen.tsx` (modal + padding + hint text
  + new styles)
- `package.json` (3.7.6 → 3.7.7)
- `android/app/build.gradle` (versionCode 210 → 211)

## Not touched

- `App.tsx` — no new routes, no new state (the modal is local
  to QuestsScreen, no need to lift it to App-level)
- `src/services/SyncClient.ts` — no new wire protocol
- `src/screens/CompanionSettingsScreen.tsx` — Quests fully
  lifted out in v3.7.6, nothing more to remove
- `src/screens/HomeScreen.tsx` — arena button + onOpenQuests
  prop unchanged
- Desktop side — no changes; the wire protocol is still the
  v3.1.49 `quests_list` broadcast
