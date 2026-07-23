# v3.10.82 — Quest screen polish: detail-modal buttons, right-side active toggle, "No active quest" default

Tobe reported on v3.10.81 (2026-07-23):

> "@Clawsuu The close and edit button positioning is
> a bit wonky, create a border for them also.
>
> And in the quest menu, add a button/toggle on the
> right side of each there where one can set as
> active. Much easier than having to go into the
> quests. Also add a default/no quest for
> conversations not related to any of them"

Three changes:

## 1. Detail-modal footer (Close + Edit)

**Before:** `modalEditBtn` had `flex: 1` but
`modalCloseBtn` didn't — so Close hugged the left
edge while Edit stretched across the rest. Both
buttons had `borderTopWidth: 1` (redundant — the
footer already had a top border). No visible borders
on the buttons themselves. Looked unfinished.

**After:** Both buttons get `flex: 1` (50/50 width).
Both have a visible 1px border (`#333` on dark
`#15151a` background) — gives them clear definition
as discrete buttons. Footer uses `gap: 8` between
buttons instead of `borderLeftWidth` divider.
`paddingVertical: 14` (was 12) and `paddingHorizontal:
12` for a bit more breathing room.

## 2. List-card action row: ☆ moved to the right

**Before:** `☆ ... ✏️ ... ✕` (left to right), with
✕ on the far right via `marginLeft: 'auto'`. The
"set active" toggle was on the LEFT next to ✏️
(edit), which is where you'd expect the "edit"
action, and the destructive ✕ next to the
"default" ☆ made the visual pairing confusing.

**After:** `✏️ ... ☆ ✕` — edit on the left, the
quick-action toggle and destructive action both
on the right. Matches the convention that
destructive actions go on the far right edge.
Removed the now-unused `cardActionDelete` style
(the `flex: 1` spacer handles right-alignment for
both ☆ and ✕).

The ☆ is still hidden when the quest is the active
one (the ACTIVE banner at the top of the card makes
the active state obvious, and offering "set as
active" on the active quest is meaningless).

## 3. "No active quest" card (NEW)

Tobe's biggest ask: a way to clear the active quest
from the mobile. Previously, once a quest was set
active, the only way to clear it was via the desktop
UI — the mobile had no UI for "default / no quest"
state. The agent kept getting quest context injected
on every chat reply even when the user wanted to chat
about something unrelated.

**Implementation:** A dedicated card at the TOP of
the quest list (above all real quests), styled with
a dashed border and lighter background to visually
distinguish it from real quests. Tapping it calls
`handleSetActive(null)`, which sends
`set_quest_active` with `id: null` to the desktop.

**Why this works at the protocol level already:**
The desktop's `onSetQuestActive` handler in
`main.js:2317` was written defensively to handle
empty/null ids:

```js
const shouldBeActive = q.id === id && !!id;
```

When `id` is empty/null, `!!id` is false, so
`shouldBeActive` is false for every quest — all get
`active: false`. No backend change needed. The
mobile's `SyncClient.setQuestActive(id: string | null)`
and the sync-server's `set_quest_active` case both
already pass `id` straight through. The whole stack
supported "no active quest" since v3.1.50 — the only
missing piece was the mobile-side UI.

**Visual states:**
- *No quest active:* Card has solid gold border,
  bright ★ icon, dark gold tint background — matches
  the active-quest visual language on regular cards.
- *A quest IS active:* Card has dashed gray border,
  faded ☆ icon, lighter background. Shows the name
  of the currently-active quest as a hint: "⏵ Tap to
  deactivate 'CYBERHIVE_WEBSITE V3'" so the user
  knows what tapping will do.

**Stale-id guard:** Same `firstBroadcastReceived`
check as the regular card actions. If the first
desktop broadcast hasn't arrived yet, the no-quest
card is disabled (with the existing syncing-hint
text above explaining why).

## Files changed

- `src/screens/QuestsScreen.tsx`:
  - `modalCloseBtn` / `modalEditBtn` / `modalFooter`
    styles rewritten (flex: 1 on Close, visible
    borders, gap between buttons)
  - Card action row reordered (✏️ left, ☆ right,
    ✕ far right)
  - Removed unused `cardActionDelete` style
  - New "No active quest" card at the top of the list
  - `handleSetActive` type widened to `string | null`
  - New styles: `noQuestCard`, `noQuestCardActive`,
    `noQuestCardDesc`, `noQuestCardHint`
- `android/app/build.gradle` — versionCode 305→306,
  versionName 3.10.81→3.10.82
- `package.json` — version 3.10.81→3.10.82

## Lessons

**"Add a feature" requests usually reveal hidden
state in the protocol.** Tobe asked for a "default /
no quest" option on the UI. The fix turned out to be
trivial (just send `id: null`) because the backend
already supported it — it was just never exposed. When
the user asks for "a way to do X", check whether X
already works at the lowest layer and the only missing
piece is UI exposure. Saves you from building a new
backend path.

**Visual asymmetry on action buttons is a tiny
detail that compounds.** Close had no `flex: 1`, so
it hugged the left while Edit stretched across. Both
looked "off" but for different reasons. The fix is
mechanical (give both the same width), but the
diagnosis required seeing it from the user's POV —
they only saw "wonky", not "Close is missing flex:
1". When users describe positioning as wonky, look
for unequal width/height on the sibling elements
first.

**Default-state UIs matter more than they seem.** A
"set to default" toggle is easy to forget when you're
focused on the "set to active" path. But the default
is what the user sees most often, and if it's hard to
return to, the user feels trapped. Tobe's "for
conversations not related to any of them" is exactly
this — once a quest was active, every conversation
implicitly became about that quest. The fix lets the
user choose when context injection should and
shouldn't happen.