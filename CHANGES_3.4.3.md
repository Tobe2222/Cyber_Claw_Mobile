# v3.4.3

## Companion settings → 5-level navigation hierarchy

Tobe's feedback on the v3.4.2 build (after fixing the
training-button location):

> "Instead of having the companion settings appearing in
> the general settings page it should rather be a new
> page, much less confusing.
>
> And within that page it should be categorized into wake
> and exit. Each opening its own page again. And within
> that page there is the wake settings and training. Same
> for exit."

The v3.4.2 per-companion detail view was a single long
page that mixed all the wake controls (greeting +
phrases + train) with all the exit controls (reply +
phrases + train) on one scroll. Tobe's read: a settings
page should be a navigation surface, not a dump of
controls.

### The new hierarchy

```
🎤 Voice mode (top-level, master toggle + grouped
   details + Companions list — unchanged from v3.4.1)
       ↓ tap companion
<Companion> settings (overview page — NEW dedicated page)
  🎤 Wake settings      → tap
  🚪 Exit settings      → tap
       ↓ tap Wake settings
Wake settings (sub-page)
  Wake greeting (TextInput)
  Wake phrases (list with retrain / delete)
  🎤 Train new wake phrase for X
       ← Back (returns to <Companion> settings)
```

Five-level drill-down: Voice mode → companion list →
companion overview → phase card (Wake / Exit) → phase
settings page.

The companion detail view itself is now ONLY a navigation
page (two cards + back button). Every per-companion
setting (greeting, phrases, train) lives on the
appropriate sub-page, not the overview.

## What changed in this release

### New: `companionViewPhase` state

A 2nd-level selection state inside the companion detail
view. Holds one of `'wake'`, `'exit'`, or `null`.

```
selectedCompanionId  +  companionViewPhase  →  rendered page
─────────────────────  ───────────────────     ──────────────
null                  +  null                 Voice mode list
<id>                  +  null                 Companion overview
<id>                  +  'wake'               Wake sub-page
<id>                  +  'exit'               Exit sub-page
```

`renderCompanionDetail()` dispatches on
`companionViewPhase` and returns the appropriate page.
When `selectedCompanionId` is null, the function returns
null and the top-level Voice mode renders normally.

### Refactored: `renderCompanionDetail()` → 3 functions

Was: a single big function returning the whole
single-page detail view.

Now: a 3-function split:

- **`renderCompanionDetail()`** — dispatcher. Routes to
  one of the three sub-functions based on
  companionViewPhase.
- **`renderCompanionOverview(companion, cid)`** — two
  big tappable cards (Wake / Exit), each setting
  companionViewPhase. Back button exits to the
  top-level Voice mode list and resets BOTH
  selectedCompanionId and companionViewPhase (so a
  re-entry starts at the overview).
- **`renderCompanionWakePage(companion, cid)`** — moved
  v3.4.2 wake controls (greeting + phrases +
  train button) into this dedicated page.
- **`renderCompanionExitPage(companion, cid)`** — same
  for exit controls (reply + phrases + train button).

The sub-page back buttons only reset
`companionViewPhase` (NOT selectedCompanionId) so the
user returns to the overview of the same companion, not
back to the top-level list. That's the difference
between "back into the companion" and "out of the
companion" — they're different navigations.

### Updated: Android hardware back handler

Previously popped any open modal then exited the whole
Settings screen. Now has a 4-level priority chain:

```
1. open trainer modal (wake-word or exit-phrase trainer)
   → close that modal
2. companionViewPhase is set (drill-down sub-page)
   → back to overview (companionViewPhase → null)
3. selectedCompanionId is set (companion overview)
   → back to top-level Voice mode list (selectedCompanionId → null)
4. none of the above (on the top-level Voice mode)
   → onBack() exits Settings entirely
```

### New styles: `phaseCard`, `phaseCardEmoji`,
### `phaseCardTitle`, `phaseCardSub`, `phaseCardArrow`

Card styling for the two drill-down cards on the
companion overview. Mirrors the companion-list row
style (emoji on left, text middle, chevron right) but
with card-level padding and a colored border per phase
(blue for Wake, orange for Exit).

### Auto-back on companion disappearance

If the active companion is removed from the local cache
while the user is on its detail view, both
`selectedCompanionId` AND `companionViewPhase` are reset
to null. Otherwise the next entered companion's detail
would open straight into a stale wake/exit sub-page.

## Files

**Modified:**
- `src/screens/SettingsScreen.tsx`:
  - Added `companionViewPhase` state (line ~184).
  - Refactored `renderCompanionDetail()` into
    dispatcher + 3 sub-functions (~150 lines total).
  - Extended `BackHandler.addEventListener` to handle
    the new drill-down level.
  - Added 5 new styles for the phase cards.
  - File-top comment to be updated to reflect the
    5-level hierarchy.

- `package.json` — version 3.4.2 → 3.4.3.
- `android/app/build.gradle` — versionCode 180 → 181,
  versionName "3.4.2" → "3.4.3".

**Unchanged:**
- All `src/services/*`, all native code, all storage
  keys. No migration needed.
- All other SettingsScreen sections.
- The top-level Voice mode layout from v3.4.1 (master
  toggle + Background listening details group +
  Companions list) is unchanged.
- All storage keys (wake greeting, exit reply, wake
  samples, exit samples, active wake companion).

## Behavior preserved

- All training (openWakeWord + exit-phrase) flows.
- All wake / exit detection logic.
- Active wake companion routing
  (`cyberclaw-active-wake-companion`).
- Per-companion exit phrase storage (v3.4.0 model).
- Auto-save on TextInput blur for greeting + reply.

## Lesson

A settings page that lists more than ~2 distinct phases
of settings (e.g. wake / exit) is a navigation problem,
not a layout problem. Tobe's instinct was right: group
the phases into a sub-page hierarchy rather than try to
cram everything into one scrollable page. When you find
yourself writing "Settings for X — part 1 / part 2 /
part 3" as section headings, that's the signal: make
each part a sub-page.

## Out of scope (deferred, same as v3.4.0 + v3.4.1 +
### v3.4.2)

- Per-companion wake greeting / exit reply (still global).
- Per-companion silence timeout / match thresholds
  (still global).
- Native-side `WakeWordModule.deleteSavedModel` for
  cleanup.
- Delete of legacy v3.3.0 exit-phrase storage keys.