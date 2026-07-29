# v3.10.106 — Swap active/inactive quest border colors

**What changed:** On the Quests screen, the active quest
card now has a **purple** border (`#a855f7`) and the
inactive cards are **orange** (`#f7931a`). Previously
the active quest was orange and the inactive ones were
purple.

**Why:** Tobe's 2026-07-29 feedback: "the current quest
is orange while the rest is purple. it should be the
other way around since most of the things are orange. to
make the current selected more distinct."

The orange-on-orange problem: most of the app's accent
colors are orange (the Connect indicator, the active
chat tab text, the send button, the BTC ticker, the
"Set active" button, the Quests list header border,
etc.). A gold/orange border on the active quest
blended in. Inverting the active/inactive colors makes
the active quest the only purple on a list of otherwise
orange cards — the most distinct possible signal.

**Where:** `src/screens/QuestsScreen.tsx`, the
`borderColor` derivation at the top of the quest
card map. Two `color` values changed:
- Active + not complete: `#f7931a` → `#a855f7`
- Active + complete: `rgba(247, 147, 26, 0.6)` →
  `rgba(168, 85, 247, 0.6)` (muted purple)
- Inactive colors are unchanged (orange for
  in-progress, green for completed)

The big ACTIVE banner at the top of the card, the
green "✓ Active" state button, and the gold ACTIVE
badge are all left as-is — they were already distinct
enough.

versionCode: 330
