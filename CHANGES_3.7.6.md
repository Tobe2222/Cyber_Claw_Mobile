# v3.7.6 — Quests is its own top-level screen (lifted out of Companion Settings)

**TL;DR:** Quests is no longer a sub-page inside Companion Settings. The
📜 Quests button in the arena (top-left, added in v3.7.5) now opens a
dedicated top-level Quests screen directly. No more "go to a companion
first, then Quests." This is what the v3.7.5 deep-link tried to fake
but couldn't, because the Quests page itself was still hosted inside
the per-companion detail view.

---

## Why

**Symptom:** Tobe (2026-07-08): *"the quests are still within the
companion settings for some reason. It should be separated."*

The v3.7.5 arena button deep-linked into the per-companion Quests
phase, but the Quests page itself was rendered as a sub-page of
`CompanionSettingsScreen` — the "← Back" button at the top of the
Quests page returned to the companion overview, and the page header
used `companion.emoji || companion.icon || '🐾'`. Functionally the
data was global (every companion's Quests page showed the same
list from the desktop), but structurally it was per-companion on
the mobile.

The per-companion cache key (`cyberclaw-quests-<companionId>`) added
in v3.7.4 was the visible symptom: it justified a per-companion
storage shape on the basis of "future per-companion divergence" that
the desktop hasn't actually done. Quests are global on the desktop
(`~/.openclaw/cyberclaw/quests.json` — single file, single list, no
per-agent mapping), so they should be global on the mobile too.

**What I almost did wrong:** I offered Tobe three placement options
(Settings card / bottom tab bar / HomeScreen header icon) for the
new top-level screen. Tobe came back with "just do a new page" —
a fourth option I hadn't listed, and the right one. I was about
to over-engineer the placement when the actual fix was "Quests is
its own thing, full stop." Lesson learned: when the user says
"just do X" after an A/B/C prompt, they're rejecting the framing,
not picking an option.

---

## What changed

### New `src/screens/QuestsScreen.tsx` (top-level)

Pure render component. Owns its own state + cache + SyncClient
subscription (per the v3.7.1 hook-order lesson — all hooks at the
screen level, no hooks inside render-helpers).

- **State:** `quests: CompanionQuest[]` (lifted type from
  CompanionSettingsScreen.tsx, now lives in the new file).
- **Cache:** single `cyberclaw-quests` AsyncStorage key. On first
  mount, sweeps legacy `cyberclaw-quests-<companionId>` keys
  (v3.7.4) and unions their entries into the new global cache
  before deleting the old keys. Dedup by `id`; if a quest is in
  both the global and a legacy key, the global entry wins (it's
  fresher because SyncClient writes to it).
- **SyncClient:** subscribes to `quests_list` event on mount,
  unsubscribes on unmount. SyncClient already auto-fires
  `requestQuestsList()` 500ms after auth (v3.7.4) and replays the
  cached payload on reconnect, so a live `quests_list` event
  arrives shortly after the screen mounts.
- **UI:** header "📜 Quests" with ← Back (returns to home).
  Active quests first, then completed. Each card shows: name +
  status emoji, done/total goals, progress bar (purple while
  active, green at 100%), project directory (📁 + last path
  segment). Empty state: "No quests yet. Create one on the
  desktop in the 📜 Quests panel." About section explains
  sync model, that paths are not stored locally, that editing
  happens on the desktop.
- **Long-press** a card to copy `quest.directory` to clipboard
  (same UX as the v3.7.4 implementation).

### `App.tsx`

- Added `'quests'` to the `Screen` enum: `'home' | 'settings' |
  'voice-mode' | 'companion' | 'quests'`.
- Imported `QuestsScreen`.
- Added the route: `screen === 'quests'` → `<QuestsScreen onBack={...} />`.
- **Removed** `companionScreenInitialPhase` state (no longer needed —
  deep-link phase is no longer a thing).
- Replaced `onOpenCompanion` prop on `HomeScreen` with `onOpenQuests`.
  `onOpenCompanion` is still used by `SettingsScreen` → `CompanionSettingsScreen`
  (legitimate per-companion navigation).

### `src/screens/HomeScreen.tsx`

- Renamed `onOpenCompanion` prop to `onOpenQuests` (and its type
  signature in the function header).
- The `msg.type === 'quests'` WebView dispatcher no longer looks up
  the active companion; it just calls `onOpenQuests?.()`. The
  fall-back-to-first-agent logic is gone (it was a band-aid for
  the deep-link case; not needed for a straight screen change).

### `src/screens/CompanionSettingsScreen.tsx`

- **Removed `'quests'` from the `companionViewPhase` union.**
- Removed `questsByCompanion` state, the `questsByCompanion`
  hydration useEffect (AsyncStorage + SyncClient subscription),
  the `questsLoadedRef` ref.
- Removed the `initialPhase` prop from the function signature and
  its useState initializer. (All other companion phases — wake,
  exit, voice — still drill down as before.)
- Removed the `Quests` card from `renderCompanionOverview`.
- Removed the entire `renderCompanionQuestsPage` function.
- Removed 10 orphaned styles: `questCard`, `questTopRow`,
  `questName`, `questPct`, `questDesc`, `questBar`, `questFill`,
  `questDir`, `emptyHintBox`, `emptyHintText`. (Other styles like
  `sectionTitle`, `sectionDesc`, `detailHeaderRow`, etc. are
  still used by the wake/exit/voice sub-pages and stay.)

### `android/app/src/main/assets/arena.html`

**No changes.** The v3.7.5 `📜 Quests` button posting
`{type:'quests'}` is still the entry point — the message dispatcher
in HomeScreen.tsx is what changed (now calls `onOpenQuests()`
instead of `onOpenCompanion(id, 'quests')`).

---

## Flow (after this release)

1. User on home screen taps the 📜 Quests button (top-left of arena)
2. `arena.html` → `postMessage({type:'quests'})`
3. `HomeScreen` receives → `onOpenQuests?.()` → `App.tsx`
4. `App.tsx` → `setScreen('quests')`
5. `QuestsScreen` mounts. Subscribes to SyncClient. Reads cache.
6. Within ~500ms, SyncClient receives `quests_list` broadcast from
   desktop → QuestsScreen updates state + writes cache.
7. User taps ← Back → `setScreen('home')` → home screen

No companion selection, no settings detour, no sub-page deep-link.
Quests is just a screen.

---

## Upgrade path (existing v3.7.4 users)

No user-visible upgrade step. The first time the user opens the
new Quests screen, the QuestsScreen's mount useEffect:

1. Reads `cyberclaw-quests` (likely empty for v3.7.4 users since
   v3.7.4 only wrote per-companion keys)
2. Sweeps all keys matching `cyberclaw-quests-*` (v3.7.4 keys)
3. Unions their entries (dedup by id) into `cyberclaw-quests`
4. Writes the merged global cache
5. Deletes the per-companion keys

The desktop's next `quests_list` broadcast overwrites the cache
with the canonical list anyway, so even a partial merge self-heals
within one network round-trip.

---

## Version

- `package.json`: 3.7.5 → 3.7.6
- `android/app/build.gradle`: versionCode 209 → 210

## Files touched

- `src/screens/QuestsScreen.tsx` (new, 300 lines)
- `src/screens/CompanionSettingsScreen.tsx` (removed ~190 lines:
  state, effect, render-function, styles, prop, phase union member)
- `src/screens/HomeScreen.tsx` (prop rename + dispatcher update)
- `App.tsx` (route + import + screen enum, removed state)
- `package.json`, `android/app/build.gradle` (versions)

## Not touched

- `android/app/src/main/assets/arena.html` — Quests button from
  v3.7.5 stays as-is
- `src/services/SyncClient.ts` — the `requestQuestsList` /
  `quests_list` event plumbing from v3.7.4 is unchanged
- The wake / exit / voice sub-pages in CompanionSettingsScreen —
  no functional changes, just the per-companion Quests stuff is
  gone
