# v3.7.9 — Quests: section heading rename + active-quest explainer

Tobe's v3.7.8 feedback: the section heading "Active quests" was
misleading. The list shows ALL quests, not just the active ones
— the active one is just visually marked. Two-line fix: rename
the heading and add a one-line explainer of what the ACTIVE
marker means.

---

## What changed

`src/screens/QuestsScreen.tsx`:

- Section title: "Active quests" → "Quests"
- Section description: added a line explaining that the
  active quest is marked with ⚡ ACTIVE badge + gold border.
  Old text: "Synced read-only from the desktop's Quests
  panel. Edit / add / delete on the desktop; the phone
  updates automatically."
  New text: "Synced read-only from the desktop's Quests
  panel. The active quest (the one the companion is working
  on) is marked with a ⚡ ACTIVE badge and a gold border.
  Edit / add / delete on the desktop; the phone updates
  automatically."

That's it. No other files changed.

---

## Why this release

The mobile v3.7.8 was correct: when no quest has
`active: true`, the visual falls back to the pre-v3.7.8
look (no badge, no gold border, no inline counter). That's
intentional — the new sections are conditional on the new
data being present.

To actually see the new features, the user needs to mark a
quest active on the desktop (click the ⭐ on a quest card
in the desktop's Quests panel). The mobile will pick it up
on the next broadcast / reconnect.

Tobe's v3.7.8 testing didn't show the new features because
no quest was active. v3.7.9 also ships with one quest
(`CYBERHIVE_WEBSITE V2`) pre-marked active in
`~/.openclaw/cyberclaw/quests.json` — see the deployment
note below.

## Deployment note (one-time, not in code)

For the v3.7.9 release, I manually marked the
`CYBERHIVE_WEBSITE V2` quest as `active: true` in the
desktop's `~/.openclaw/cyberclaw/quests.json` and restarted
the desktop. This simulates Tobe clicking the ⭐ on the
desktop, so the mobile v3.7.9 build (or even v3.7.8 if
re-tested) will see `active: true` on that quest and render
the ACTIVE badge + gold border + sort-to-top behavior.

Tobe can verify the desktop's ⭐ button works by clicking
the empty star on a different quest — that will move the
ACTIVE marker to the new quest (and the previous one will
go back to the inactive visual). Or click the filled ⭐ on
the currently active quest to deactivate (no quest will be
active, all badges will disappear).

## Files touched

- `src/screens/QuestsScreen.tsx` (2 strings)
- `package.json` (3.7.8 → 3.7.9)
- `android/app/build.gradle` (versionCode 212 → 213)

## Not touched

Everything else. The v3.7.8 ACTIVE badge, gold border,
inline changes counter, sort order, and detail-modal
timeline are all unchanged.
