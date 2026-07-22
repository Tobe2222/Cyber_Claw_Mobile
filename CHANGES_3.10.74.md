# v3.10.74 — Treats fix (companion didn't move), drag-to-place, food prefs, quest editor fixes

Tobe's report (2026-07-22 17:31):
> "i tested the snack. The companion did not move to
> it and it should be drag and drop able also. The
> comments the companion makes when given food or
> played with does not need to appear in the chat if
> it does, not sure. Certain companions should prefer
> certain Foods.
>
> And i tested the quest edit also. It still said the
> same and did not work to edit. And it does not need
> the double active quest or not. Still missing the
> steps."

Five things in one message. v3.10.74 addresses all of
them.

## 1. Companion didn't move to snacks (root cause + fix)

**Bug:** Treats were dropped on the arena but the
companion ignored them entirely.

**Root cause:** The v3.10.72 seek-and-eat logic ran
only when `c.isActive === true`. But on the home
screen the user can drop a treat BEFORE tapping a
companion tab — at that moment `activeId === null` and
no companion has `isActive = true`, so the seek never
ran. The desktop doesn't filter by active either; it
iterates all companions and the closest one eats. We
match that behavior now.

**Fix:** Removed the `c.isActive` requirement. Also
added a 200px L∞ distance threshold so a companion
that isn't even on the same part of the screen as
the treat won't break its current state trying to
seek. The desktop's seek logic does the same implicit
filtering by virtue of the `dist < 30` check alone,
but on mobile's smaller arena we want to be
conservative so we don't have companions constantly
seeking treats across the screen.

## 2. Drag-and-drop to place treats (new)

**Bug:** Tobe wanted drag-to-place in addition to
tap-to-place. The v3.10.72 picker only had tap.

**Fix:** Long-press a treat in the feed Modal → the
modal closes, a drag overlay emoji follows the
finger, on release the treat is placed at the finger
position. Implementation:

- `PanResponder` in `dragPanResponder` captures the
  gesture after `onLongPress` fires.
- `dragMode` state holds `{treatType, emoji, x, y}`.
- On `onPanResponderRelease`, calls `placeTreat(type,
  x, y)` which now accepts optional coords.
- `window.Arena.dropTreat(type, x, y)` accepts (x, y)
  and clamps to canvas bounds.
- Drag overlay is a top-level absolute-positioned View
  with `pointerEvents="box-none"` so it doesn't block
  other touches (e.g. tab buttons).
- Hint banner at the bottom: "🖐 Drag to place ·
  release to drop".

Tap-to-place still works the same way (drop at center).

## 3. Food/play comments don't appear in chat (desktop fix)

**Bug:** The v3.10.72 IPC handler called
`promptCompanionReaction()` which triggers an LLM
roundtrip + adds the reply to chat. Tobe didn't want
this — feeding should be a non-verbal action.

**Fix:** Removed the `promptCompanionReaction()` call
in the desktop's `mobile-arena-treat-placed` and
`mobile-arena-treat-eaten` IPC handlers (desktop v3.2.16).
The handlers now only log to the desktop's log panel
via `addDesktopLog`. No chat noise. The mobile's 😋
+ ❤️ emoji overlay is the only user-facing feedback.

## 4. Companion food preferences (new)

**Bug:** Tobe wanted certain companions to prefer
certain foods.

**Fix:** Static `COMPANION_FOOD_PREFS` map in
HomeScreen keyed by companion id or name (lower-case
substring match). Default fallback covers
companions we don't have a specific mapping for.
Preferred treats get a ⭐ star in the picker modal.

```ts
const COMPANION_FOOD_PREFS: Record<string, string[]> = {
  default: ['cookie', 'berry'],
  clawsuu: ['fish', 'meat', 'berry'],   // cyber-cat
  lamasuu: ['cake', 'cookie', 'berry'], // sweeter
  cat: ['fish', 'meat'],
  dog: ['meat', '***'],
  bird: ['berry', 'apple'],
};
```

Resolution order: exact id match → name contains
key → default. Substring match lets the mapping
work for any companion named "Mrs. Whiskers" via the
`cat` key without explicit per-companion entries.

A per-companion `favoriteFoods` field stored on the
agent model would be a more scalable version of this
(allow the user to override the heuristic). Out of
scope for v3.10.74.

## 5. Quest editor improvements

### 5a. Quest edit still failed — diagnostic info added

**Bug:** v3.10.73's `firstBroadcastReceived` gate
didn't help. Tobe still saw "Couldn't update quest:
quest not found" on the second screenshot.

**Diagnostic addition:** The desktop's
`quests_update_failed` response now includes
`available: [list of quest ids]` so the mobile can
show the user "wanted X, desktop has [a, b, c]".
The next test run will tell us what's actually
mismatched.

Server-side log: `[SyncServer] update_quest: id not
found. requested: X available: [a, b, c]` so the
desktop log captures the same info even if the user
doesn't share the error toast.

The mobile's failedHandler now appends
` · wanted "X", desktop has [a, b, c]` to the toast
text (truncated to 5 ids + "+N more"). Also
`console.warn` so the WebView's log captures it.

This is a diagnostic change, not a fix — the
underlying bug needs the next test run to diagnose.
Possible causes (ranked by likelihood):
- The mobile is sending an id from a stale cache that
  the desktop doesn't have
- The desktop's `QUESTS_FILE` was modified externally
  between broadcast and save
- There's an id-encoding bug (e.g. invisible Unicode
  chars) — not seen yet but worth checking

### 5b. Removed double-active toggle in the editor

**Bug:** Tobe's screenshot showed V2 with Status
"Active" highlighted AND HIVE_CONTROL with the
⚡ ACTIVE badge. Two different "active" concepts
confused the UX.

**Fix:** Removed the redundant "Active" toggle from
the editor. The "this is THE active quest" flag is
now set exclusively via the ☆ button on the card list.
The editor's Status field (Active / Completed) keeps
its meaning ("is this quest in-progress or finished").

### 5c. Goal text editing ships (steps!)

**Bug:** Tobe: "Still missing the steps." The editor
previously had the hint "Goal text editing lands in a
future release."

**Fix:** Steps are now editable in the editor. One
`TextInput` per step, with a remove (✕) button per
row and a "+ Add step" button at the bottom. The
checkbox on the left toggles the step's completed
state. Save sends the full goals array (preserving
order and `completed` flags) and the desktop stores
it as-is.

The Save payload now includes `goals`:
```ts
{
  name, description, status, goals: [
    { text, completed },
    ...
  ]
}
```

Empty-text goals are filtered out on Save (so the
user can save mid-typing without losing the rest).
The desktop's `onUpdateQuest` accepts `goals` in the
updates object (only `id`, `created`, `active`,
`latestChanges`, `skills` are stripped).

## Files changed

**Mobile (v3.10.74):**
- `android/app/src/main/assets/arena.html` —
  `dropTreat(type, x, y)` now accepts optional coords;
  seek-and-eat no longer requires `c.isActive`; added
  200px L∞ distance threshold
- `src/screens/HomeScreen.tsx`:
  - `PanResponder` import
  - `dragMode` state + `dragPanResponder` ref
  - `placeTreat(type, x?, y?)` extended with optional
    coords
  - `COMPANION_FOOD_PREFS` map + `getPreferredTreats()`
    helper
  - Treat modal items: ⭐ marker for preferred,
    `onLongPress` for drag-to-place
  - Drag overlay View + hint banner
  - Drag styles (`feedDragGhost`, `feedDragHint`,
    `feedModalItemStar`)
- `src/screens/QuestsScreen.tsx`:
  - Removed "Active" toggle from `QuestEditorBody`
  - Added goal list editor (steps add/remove/edit)
  - `failedHandler` includes diagnostic info from
    the desktop
- `android/app/build.gradle` — versionCode 299→300,
  versionName 3.10.73→3.10.74
- `package.json` — version 3.10.73→3.10.74

**Desktop (v3.2.16):**
- `src/sync-server.js` — `update_quest` failure
  response includes `available: [quest ids]`
- `src/main.js` — new `onListQuests` callback
- `src/js/app.js` — `mobile-arena-treat-placed` and
  `mobile-arena-treat-eaten` IPC handlers no longer
  call `promptCompanionReaction` (chat noise removed);
  log only via `addDesktopLog`
- `package.json` — version 3.2.15→3.2.16

## Lessons

**Debug-before-fix when the obvious cause doesn't pan
out.** The v3.10.73 gate was supposed to fix
"Couldn't update quest: quest not found" but it
didn't. Rather than guessing at another fix, v3.10.74
adds diagnostic info to the error response so the
next test run reveals the actual root cause. Pattern:
when your hypothesis is wrong, instrument before
guessing again.

**Cross-system UI consistency needs careful field
naming.** The mobile editor's "Active" toggle and the
"⚡ ACTIVE" badge on cards were semantically different
("in-progress status" vs "this is THE active quest")
but looked identical. Removing the redundant toggle
cleared up the confusion. Lesson: when adding
multiple UI elements that touch the same concept,
make sure they're either clearly different or
clearly subordinate. Don't have two "active"-feeling
controls that do different things.

**Heuristic preferences beat no preferences.** A
name-substring-match for cat/dog/bird beats having no
companion-specific food choices at all. The 6-line
`COMPANION_FOOD_PREFS` map covers the common cases
without per-companion config overhead. The full
`favoriteFoods` field on each agent is a future
improvement but the heuristic gets 80% of the value
in 5% of the code.

**Long-press is a mobile-native gesture that
desktop-port patterns miss.** The desktop has
drag-to-place because mice can drag. Mobile has
long-press → drag because fingers can long-press. The
v3.10.72 tap-to-place was the natural mobile flow,
but it left users wanting precision placement that
only drag-and-drop provides. Adding long-press as a
"tap alternative" gives both: tap for speed, drag for
precision, both without a mode toggle.