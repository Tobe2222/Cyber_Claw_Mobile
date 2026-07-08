# v3.7.4

Quest list mirror (read-only) on each companion's settings screen.

This is the phone-side counterpart to the desktop v3.1.49
release. Each companion's settings tab now has a new
**📜 Quests** card that opens a fullscreen screen showing
the desktop's quest list — names, descriptions, goals with
checkboxes (read-only), progress bars, project directory,
active/completed state. All synced live from the desktop
over the existing WebSocket.

## What changed

### `src/services/SyncClient.ts`

1. **New `requestQuestsList()` method** that sends
   `{ type: 'request_quests_list' }`. Same shape as
   `requestAgentsList()`, fired on every successful
   auth (SyncClient.ts:445) with a 500ms stagger so
   it doesn't bunch up with the other request_*
   messages on first connect.

2. **New `case 'quests_list':` handler** that
   re-emits the message as a local event. The new
   `CompanionSettingsScreen` useEffect subscribes
   to it; would also be the hook point for any
   other screen that wants to render quests.

### `src/screens/CompanionSettingsScreen.tsx`

**Hook-rule cleanliness**: all new state and effects
live at the screen level (next to the existing wake
/ exit / voice state), not inside the new
`renderCompanionQuestsPage` render-function. Mirrors
the v3.7.1 fix for `renderCompanionVoicePage`. The
render-function is pure; the dispatch swap (overview
↔ quests ↔ back) can't break React's hook bookkeeping.

**State + persistence:**

- `companionViewPhase` union gains `'quests' | null`.
- New `questsByCompanion: Record<string, Quest[]>`
  state, keyed by `companionId`. Snapshot is
  persisted per-companion to AsyncStorage as
  `cyberclaw-quests-<companionId>`. Read-only on
  the phone for now; the desktop is the source of
  truth and rebroadcasts on every change.
- New `questsLoadedRef` + useEffect that:
  - Hydrates from AsyncStorage on mount +
    companionId change.
  - Subscribes to SyncClient's `quests_list`
    event and writes through to state +
    AsyncStorage on every received message.
  - Does NOT fire its own `requestQuestsList()`
    — that's the SyncClient's job on auth.

**UI:**

- New 📜 Quests phase card in
  `renderCompanionOverview`, after the existing
  Voice card. Subtitle shows the count: "No
  quests on the desktop yet" or "N quest(s)
  from the desktop — read-only".
- New `renderCompanionQuestsPage` fullscreen
  screen — same pattern as Wake / Exit /
  Voice pages. Header has a `← Back` button.
  Body has the quest cards (active first,
  completed dimmed and sorted to the bottom)
  + an "About quests on mobile" explainer
  at the bottom. Empty state shows a
  dashed-border hint pointing the user at
  the desktop.
- Each card has: title (✅ if done, ⚔️ if
  active), 0/N goal count chip, description,
  progress bar (purple → green at 100%),
  project directory (just the basename, so
  `/media/.../cyberhive_website` shows as
  `cyberhive_website`).
- Long-press a card to copy the project path
  to clipboard. Doesn't open the project —
  the phone doesn't know what app should open
  it (IDE, file manager, terminal), and per
  Tobe's "project stays clean" rule the phone
  should never modify project files.

**Styles:**

- 8 new entries: `questCard`, `questTopRow`,
  `questName`, `questPct`, `questDesc`,
  `questBar`, `questFill`, `questDir`,
  `emptyHintBox`, `emptyHintText`. All visually
  consistent with the existing phase-card style
  (dark blue card, purple accent matching the
  existing settings section, green when
  complete).

## Behavior

- Open the companion tab → tap 📜 Quests → see
  the desktop's quest list.
- Switch companion tabs → quest list refreshes
  from cache (already hydrated) + from any
  in-flight `quests_list` broadcast (no need to
  wait for re-fetch — SyncClient's reconnect
  handler replays it).
- Force-quit the app → reopen → quest list is
  still there from AsyncStorage. If offline and
  the desktop is unreachable, you still see the
  last-known list (clearly stale by the time you
  notice, but visible). Once the desktop
  reconnects, the SyncClient's auto-`request_quests_list`
  refreshes it.
- Edits made on the desktop propagate within
  ~1 RTT (no polling). Save a new quest on the
  desktop → it shows up on the phone within a
  second.

## Not in this release

- **Arena highlight by active quest.** The pixel
  arena could highlight the companion whose
  active quest matches the project's directory
  — but "which companion is on which project"
  isn't a thing yet on the desktop. Quests are
  global, not per-companion. Tobe flagged this
  as "not sure how this would look, let's try"
  — defer until the desktop models per-companion
  quest assignment.
- **Quest edits on phone.** Mobile is read-only.
  Creating / editing / deleting stays on the
  desktop because it needs filesystem access
  (directory picker, goal editor, version
  detection from package.json).
- **Per-project support data.** The phone stores
  its quest cache at
  `cyberclaw-quests-<companionId>` in AsyncStorage
  (not in `quest.directory`). If we ever need
  per-project phone-side state (e.g. edit
  summaries cached alongside the project),
  we'd add `<project>/.cyberclaw-mobile/`. Out
  of scope for the mirror-only v1.

## Files modified

- `src/services/SyncClient.ts` — `requestQuestsList()` method, `quests_list` event handler, auth-time auto-request (500ms)
- `src/screens/CompanionSettingsScreen.tsx` — `companionViewPhase` union adds `'quests'`, new state + useEffect for hydration + subscription, new `renderCompanionQuestsPage` render-function, new phase card in `renderCompanionOverview`, 10 new styles
- `CHANGES_3.7.4.md` (new)
- `package.json` — 3.7.3 → 3.7.4
- `android/app/build.gradle` — versionCode 207 → 208
- `.github/workflows/build.yml`, `.github/workflows/android-build.yml` — artifact name → v3.7.4
