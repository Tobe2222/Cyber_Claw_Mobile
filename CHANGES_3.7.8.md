# v3.7.8 — Quests: ACTIVE badge + latest changes timeline

The mobile side of the desktop v3.1.50 release. The new fields
(`active`, `latestChanges`) ride the existing `quests_list` event,
so the mobile just reads them off the quest object the SyncClient
already hands it. No new wire protocol, no new IPC, no SyncClient
changes — purely a viewer update.

**Companion release:** desktop v3.1.50 (already shipped).

---

## What changed

### 1. ACTIVE badge on the quest card

The active quest is the one the companion is currently working
on, persisted in `~/.openclaw/cyberclaw/quests.json` (desktop
v3.1.50 added this). Exactly one quest is active at a time.
The mobile now shows it loud and clear:

- **⚡ ACTIVE badge** in the top-right of the card. Gold
  background tint, gold border, uppercase, letter-spacing.
  Positioned absolutely so it doesn't disturb the existing
  card layout.
- **Gold border + thicker 2px width** on the active card. If
  the quest is also `status: 'completed'`, the border is muted
  (60% alpha gold) so it doesn't shout, but the badge is still
  there.
- **Sort order:** active quest first, then non-completed, then
  completed. The working quest is always at the top of the
  list.

### 2. Inline changes counter

Quests with journal entries get a small italic counter under
the goal bar: "📝 5 changes logged". Tells the user there's
more detail in the modal without having to tap to find out.

### 3. ACTIVE badge in the detail modal

The detail modal now has its own ⚡ ACTIVE badge in the status
row, next to the existing "Active"/"Completed" status badge.
The two are independent concepts: a quest can be
`active: true, status: 'completed'` (you've finished but still
have it open for reference) and the modal makes that visible.

### 4. Latest changes timeline

The detail modal now has a "Latest changes (N)" section
rendered as a vertical timeline:

- Small purple dot on the left of each entry (the timeline
  bullet)
- The change text on the right
- A relative timestamp underneath ("2h ago", "1d ago", or
  the actual date for entries older than 30 days)
- Newest first

A "Synced from the desktop. The companion appends to this
when it does something worth logging." intro line above the
timeline explains what the section is.

The `formatTimeAgo` helper mirrors the desktop's `fmtAgo` in
`app.js:1062` so the mobile and desktop render the same way
("2h ago" rather than a hard-to-skim absolute timestamp).

Empty state: if there are no changes yet, the section is
omitted entirely (not "Latest changes (0)" with an empty list
— that would be noise on a fresh quest).

---

## Files touched

- `src/screens/QuestsScreen.tsx` (type extension, sort update,
  list-card badge + border + inline counter, detail-modal
  badge + timeline section, `formatTimeAgo` helper, 9 new
  styles)
- `package.json` (3.7.7 → 3.7.8)
- `android/app/build.gradle` (versionCode 211 → 212)

## Not touched

- `src/services/SyncClient.ts` — the `requestQuestsList` and
  `quests_list` event plumbing from v3.7.4 is unchanged. The
  new fields ride the existing payload.
- `App.tsx` — no new routes, no new state
- `src/screens/HomeScreen.tsx` — arena button + onOpenQuests
  prop unchanged
- `src/screens/CompanionSettingsScreen.tsx` — Quests fully
  lifted out in v3.7.6, nothing more to remove
- Desktop side — no changes; the wire protocol is the v3.1.50
  `quests_list` broadcast

## Upgrade path

No user-visible upgrade step. The first time the user opens
the new mobile build, the QuestsScreen receives the new
`quests_list` payload (with `active` and `latestChanges` on
each quest) and renders the ACTIVE badge + inline counter
where applicable. No migration needed on the mobile — the
new fields are optional in the type (the `?` after each
name), so older payloads without them just render the
pre-v3.7.8 view (no badge, no counter, no timeline section).
