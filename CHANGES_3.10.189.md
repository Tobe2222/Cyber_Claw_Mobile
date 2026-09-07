# v3.10.189 — Quests screen: red "No active quest" pill + visual cleanup

Tobe (2026-09-07 06:27, Discord #cyber-dev, screenshot):
"@Clawsuu in cyberclaw mobile, lets clean up the quests, it
looks like this now. Just add a no active quest red pill in
the top and clean up a little with looks and user experience
in mind."

## What changed

### 1. Red "No active quest" pill in the page header

A new pill row sits directly under the page header
(`← Back    📜 Quests    [+ New] [↻ Refresh]`). It always
shows the current active-state at a glance:

- **Green pill: `✓ {active quest name}`** — when a quest is
  active. The user can see which quest is feeding context to
  the companion without scrolling. Tapping the green pill
  opens the quest's detail modal.
- **Red pill: `● No active quest`** — when nothing is
  active. Exactly what Tobe asked for. Red (not orange) so
  it visually distinguishes from the gold/purple/orange
  active-quest visual language used elsewhere on the page;
  red is the "no project context, conversations are off-quest"
  warning signal. Same red family as the delete button and
  the error toast.

The pill is static (non-tappable) when no quest is active —
it's a status indicator, not an action. The actual toggle
lives in the dashed "No active quest" card directly below
the active quest.

### 2. Removed redundant "Quests" section title

The page header already says `📜 Quests`, so the orange
"Quests" section title inside `<View style={styles.section}>`
was duplicating that. Removed it. Saves a vertical row.

### 3. Tightened the section description

Before:
> "Synced from the desktop's Quests panel. The active quest
> (the one the companion is working on) is marked with a
> ⚡ ACTIVE badge and a gold border. Tap the actions below a
> card to set it active, edit it, or delete it. The phone
> edits round-trip to the desktop in real-time."

After:
> "Synced live from the desktop. Tap a card for details, long-press to copy its project path."

The ACTIVE / gold border details are now obvious from the
green/red pill + the cards themselves. The "round-trip to
the desktop in real-time" line is implied. The `Tap…/Long-
press…` hint was previously a separate line; folded into the
single description.

The description's `marginBottom` also dropped from 16 to 8
so cards sit higher on first paint.

### 4. Slightly tighter card padding

`paddingVertical` 12 → 10 and `marginVertical` 6 → 5. The
cards were a bit too tall; now they breathe without feeling
sparse.

## Files changed

- `src/screens/QuestsScreen.tsx` — added `headerStatusRow`
  + green/red pill, removed redundant section title,
  shortened description, tightened card spacing.
- `package.json` (3.10.188 → 3.10.189),
  `android/app/build.gradle` `versionName` (3.10.188 →
  3.10.189) and `versionCode` (395 → 396).

## Verification

- TypeScript: `tsc --noEmit` introduces zero new errors.
  The one pre-existing `insets.top` possibly-undefined
  warning (line ~1465) is unrelated and was already on
  v3.10.188.
- Manual mental test:
  1. No quest active → red pill visible, dashed "No
     active quest" card visible below. Active-quest
     green pill NOT rendered.
  2. Tap an orange "☆ Set active" button on a card →
     desktop broadcasts → handler updates state → green
     pill appears at the top, active card floats up to
     pin position, "No active quest" card becomes dashed
     inactive again.
  3. Tap the green pill → active quest's detail modal
     opens.
  4. Tap the dashed "No active quest" card → green pill
     swaps to red pill, active card moves down to the
     inactive list, dashed card becomes the active
     styling.
- Cross-screen: no navigation changes; the QuestsScreen
  still receives `onBack` from App.tsx and exits to home.

## UX lessons

- **Status pills belong at the top of the page, not buried
  in the list.** The previous design forced the user to
  scroll to find out which quest was active (the purple
  ACTIVE card could be off-screen on long lists). The pill
  is always visible and survives scrolling.
- **Color family matters for status signals.** Red is the
  existing "needs attention" color on this page (delete
  button = `#a55`, error toast = `#3a0e0e` border `#a55`).
  Reusing that family for the "no active quest" pill ties
  the visual cues together: red = something is off, fix it.
- **Don't duplicate the page title inside the body.**
  Removing the second "Quests" header felt obvious in
  retrospect but had been there since v3.7.6.
