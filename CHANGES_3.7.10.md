# v3.7.10 — Quests: fresh data on mount + louder ACTIVE banner

Tobe's v3.7.9 test still showed the pre-v3.7.7 visual (no ACTIVE
badge, no gold border, no changes counter) — even after the
desktop was confirmed to be on v3.1.50 with `active: true` on
CYBERHIVE_WEBSITE V2. Diagnosed via process inspection of the
desktop + adding a temporary DEBUG log to the broadcast
callback. The root cause was in the mobile, not the desktop.

## Root cause

The QuestsScreen read its data from `AsyncStorage` on mount and
then subscribed to the `quests_list` event. It did NOT fire a
`request_quests_list` on mount. The mobile relied on the
SyncClient's auto-fire 500ms after WebSocket auth.

That auth-time broadcast is fragile:
- If the QuestsScreen mounts AFTER the 500ms window, the event
  was emitted to nobody (no listener yet), so the screen
  subscribes to a stream that's already finished
- If the user is on a different tab when the broadcast fires,
  the QuestsScreen isn't mounted, so the event is missed
- The screen falls back to whatever's in the AsyncStorage
  cache, which can be stale (a previous run's data, missing
  the new `active` and `latestChanges` fields)

This was a latent bug since v3.7.6. It didn't matter when the
desktop's quest data was static — the cache was always
"current enough." But with v3.7.8's new `active` field, the
cache can be stale the moment the user stars a different
quest on the desktop.

## Fix

`src/screens/QuestsScreen.tsx`:

1. **Fire `syncClient.requestQuestsList()` on mount.** The
   desktop responds within ~100ms with a fresh broadcast,
   the handler runs, and the state is updated to the live
   data. The AsyncStorage cache read still happens first
   (for instant render), so the user sees data immediately
   and it gets replaced by the live broadcast as it
   arrives. The cache read is no longer the only source of
   truth.

2. **Replace the absolute-positioned 9pt ACTIVE badge with a
   full-width 11pt banner at the top of the card.** Tobe's
   screenshot showed the badge was either too small to
   notice (9pt is tiny) or hidden behind the "1/2" count
   in the top-right. The new banner sits above the name +
   count row, takes the full card width, and uses a louder
   gold tint with letter-spacing. "⚡ ACTIVE — companion is
   working on this" is the literal text. Impossible to
   miss.

## Edit functionality on the phone (deferred)

Tobe: "why is it read only? Can we not add edit
functionality etc?"

Quests on the mobile have been read-only by design since
v3.1.49 (when the mobile mirror was first added). The
desktop is the canonical editor — directory picker, goals
editor, agent edit tools, all live on the desktop. The
mobile's job is to *show* the current state of work,
including the v3.1.50 active marker + latest changes
journal.

Adding edit functionality to the mobile would be a
substantial feature:
- IPC handlers for create / update / delete on the
  mobile side
- A quest editor UI (probably a separate modal similar
  to the existing detail modal)
- Goal editor (reorder, add, remove, mark done)
- Directory picker (Android file system access on the
  phone side)
- Status toggling (active / completed)
- Star (set-active) button
- Local validation, error handling, conflict
  resolution if the desktop's state changes mid-edit

The data is owned by the desktop and the file lives in
`~/.openclaw/cyberclaw/`. The mobile editing it would be
the inverse of the current model: phone as editor,
desktop as viewer. There's a good case for it (the user
should be able to log progress from the phone), but it's
a bigger change than the current request.

**Defer to a separate v3.8.x series.** Tobe, signal back
if you want it sooner.

## Files touched

- `src/screens/QuestsScreen.tsx` (mount-time
  `requestQuestsList()` call + ACTIVE banner redesign)
- `package.json` (3.7.9 → 3.7.10)
- `android/app/build.gradle` (versionCode 213 → 214)

## Not touched

- Desktop code — the v3.1.50 release is correct. The
  temporary DEBUG log on the desktop's
  `onRequestQuestsList` and the initial-broadcast call
  has been removed.
- `src/services/SyncClient.ts` — the `requestQuestsList`
  method already exists from v3.7.4. No changes.
- The read-only design — still read-only. Edit
  functionality is a separate feature.

## Deployment note (still relevant from v3.7.9)

`CYBERHIVE_WEBSITE V2` is marked `active: true` in
`~/.openclaw/cyberclaw/quests.json`. Restart the desktop
if needed to make sure it's reading the current file. The
mobile's mount-time `requestQuestsList()` will then pick
up the active state on next screen open.
