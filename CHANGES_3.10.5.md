# v3.10.5 — Active wake panel on sub-page + direct canonical lookup

Tobe tested v3.10.4 and reported (channel `#cyber-dev`,
two screenshots attached):

1. **Wake settings card still says "No active wake on
   this phone — open Wake Sets to manage trained
   phrases"** even though the Wake Sets manager
   correctly shows "Hey Clawsuu" as ✓ Active for the
   same companion.

2. **The text under "Wake phrases" on the Wake sub-page
   is old and doesn't make sense** — it says "Tap 🎙 to
   retrain, 🗑 to delete" but the section right below
   has no rows (those actions live in the manager now).
   Tobe wants the text updated.

3. **The Wake settings page should show the active
   wake phrase / file directly** so the user doesn't
   have to tap "Manage wake sets" to see what's
   currently bound.

## Root causes

### #1 — `savedWakeModels` merge still misses the active binding

v3.10.4's fix merged `getSavedWakeModels` (active-only
filter, has the absolute `.tflite` path) with
`listWakeSets` (all sets, includes `active: bool` flag)
as a fallback. The merge loop iterates
`availableCompanions`, filters each set's meta by
`e.agentId === c.id`, and picks the active set or
the most-recently-created one. **But if the meta's
`agentId` is empty, null, or doesn't strictly match the
JS companionId in some edge case (e.g. the set was
trained before the JS companionId was renamed by a
desktop sync, or agentId casing differs), the filter
returns zero candidates and the fallback picks nothing.**

Meanwhile the Wake Set Manager uses a DIFFERENT code
path — it reads `agentId` directly from the prop and
calls `getActiveWakeSet(agentId)`, which is a single
SharedPreferences read of `active_<agentId>`. That's
the canonical "what's active for this companion?"
call. As long as the binding is set, it returns the
setId. The manager then looks up the setId in
listWakeSets for metadata.

So: the manager uses a direct lookup; the screen uses
a merge. They disagree whenever the merge fails to
resolve a candidate.

### #2 — Stale picker hint text

The Wake sub-page's "Wake phrases" section rendered
the picker with a hint saying "Tap 🎙 to retrain, 🗑
to delete" — that text made sense in v3.7.x when the
picker had inline retrain/delete buttons per row.
v3.9.0 moved that management into the dedicated Wake
Set Manager (full-screen route), so the picker now
shows at most ONE row (the active phrase) or zero
rows (when the merge fails) — there are no rows
with retrain/delete buttons on this page anymore.
The hint became a promise of UI that doesn't exist.

### #3 — Active wake hidden behind "Manage"

Tobe's flow: open Settings → tap a companion → tap
Wake settings → see... nothing useful. The greeting
field, then "Wake phrases" with no rows, then two
dashed buttons (Train, Manage). To know which wake
phrase is currently bound, the user has to tap
Manage, wait for the manager route to load, scroll
to the ✓ Active badge. That's three extra taps for
information that should be on the page they came
from.

## Fixes

### #1 — Direct canonical lookup, parallel to savedWakeModels

Added `activeWakeDirect` state. Independent of
`savedWakeModels` (deliberately — the merge bug must
not be able to mask the canonical truth). On mount,
on companion change, and on `AppState change →
'active'`:

1. Call `WakeWordModule.getActiveWakeSet(companion.id)`
   — returns the setId or null. This is the same
   SharedPreferences key the manager reads, so the
   "✓ Active" badge and the new panel agree by
   construction.

2. If a setId is returned, look up its metadata in
   `WakeWordModule.listWakeSets()`. Extract
   `phrase`, `displayName`, `path`. Stash into
   `activeWakeDirect`.

3. If `getActiveWakeSet` returns null, set
   `activeWakeDirect = null` (genuine "no active
   wake" state).

4. If the lookup succeeds but `listWakeSets` doesn't
   include the setId (transient), fall back to a
   minimal `{ setId, phrase: setId }` so the UI can
   at least show "Active: <setId>" — never silently
   blank.

5. On transient failure, keep the previous value (no
   flicker).

The wake card's status line now prefers
`activeWakeDirect` over `savedWakeModels[companion.id]`.
If the direct lookup says "Hey Clawsuu" is active,
the card says so. Period. The merge is still useful
as a fallback for companions that have a set but no
active binding (so we can show "Not active" instead
of "No wake exists at all").

### #2 — New "Currently active wake" panel on the Wake sub-page

Between the greeting input and the "Wake phrases"
section, a new panel:

- **When active**: green-bordered card with the
  phrase (large, white), the setId (small, green,
  monospace), the `.tflite` path (smaller, grey,
  monospace), and a "📂 Manage wake sets" button
  that pushes the manager route.

- **When not active**: dashed grey-bordered card
  with a hint pointing at the Train / Manage
  buttons below.

Uses the same green ◉ indicator the voice picker
already uses, so it reads as "active" without
needing a label. The phrase is the big primary
element; setId and path are secondary debug info
for users who want to verify the binding on disk.

### #3 — Updated "Wake phrases" hint text

Replaced "Trained wake words for X. Tap 🎙 to retrain,
🗑 to delete." with:

> "Trained wake phrases for X. Use 'Manage wake sets'
> below to retrain, rename, or delete."

Now matches the actual UI: there's no inline
retrain/delete on this page (those live in the
manager), so the hint points the user at the
correct location.

### #4 — Pre-existing HomeScreen.tsx TS error (unchanged)

`npx tsc --noEmit` reports one pre-existing error in
`HomeScreen.tsx:2702` (`Unexpected token. Did you
mean {'}'}` or `&rbrace;?`). It was already present
on the v3.10.4 baseline (verified by stashing all
local changes and re-running `tsc`). Not related to
this fix. v3.10.4 was tagged despite this error.

## Files

- `src/screens/CompanionSettingsScreen.tsx` (+254 /
  -16): replaced the v3.10.5-stale `activeWakeDirect`
  useRef scaffold (which only did bookkeeping and
  never set state) with a real working
  `getActiveWakeSet` + `listWakeSets` lookup;
  updated `wakeStatusLine` to prefer the direct
  lookup; added the "Currently active wake" panel
  to the Wake sub-page; rewrote the stale "Wake
  phrases" hint.
- `package.json` — 3.10.4 → 3.10.5
- `android/app/build.gradle` — versionName 3.10.4 →
  3.10.5, versionCode 231 → 232

## General lesson

**When a UI component reads the same canonical data
through two different code paths and the two paths
disagree, the canonical one wins — even if it's a
"second" fetch.** The v3.10.4 fix tried to unify the
data by merging; that helped for some companions but
didn't reach 100% because the merge filter has its
own skip conditions. The right move at v3.10.5 is
to ask the canonical question directly: "what's
active for THIS companion?" — and accept the
duplicate fetch as the price of correctness.

A cleaner long-term refactor would be a shared
`useActiveWake(companionId)` hook consumed by both
the screen and the manager, but pre-emptively
introducing it would have masked the v3.10.4 gap.
When two screens disagree, build the hook AFTER you
have proof the disagreement exists; the proof
matters more than the abstraction.

**Lesson from the stale text:** when you move a
piece of UI to a different location, every text
that referenced the old location has to move with
it. The "Tap 🎙 to retrain, 🗑 to delete" hint was
written when the picker rows were inline. When
v3.9.0 moved management to the manager route, the
hint should have moved with it. Pattern: when a
refactor relocates a UI affordance, grep for
references to it in description text and update
them in the same commit. Otherwise the description
becomes a lie that lives for months.