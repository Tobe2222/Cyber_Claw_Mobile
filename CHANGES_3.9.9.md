# v3.9.9 — Hotfix: getSavedWakeModels collapses to active-only + one-shot dedupe

Tobe (in #cyber-dev, ~21:06 with 2 screenshots after
v3.9.8 install):
"It still says no wake trained yet even tho there are
files in the manager. And again, which ones of these
are correct. They got created at the same time it seems,
why is that? There should only be one. Very confusing
for the user"

Two distinct issues from v3.9.8:

1. **"No wake trained yet" badge** — even though the
   Wake Manager shows an Active set, the Wake settings
   card says "No trained wake phrases yet".
2. **4 timestamped-the-same-minute orphans** — the
   v3.9.8 cleanup-on-new-training fix only fires for
   NEW training. Tobe's 4 orphans existed on disk
   before v3.9.8 was installed, so the cleanup never
   ran on them.

## Fix 1 — getSavedWakeModels returns active-only

`android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:

`getSavedWakeModels()` previously iterated ALL wake sets
and used `result.putMap(agentId, entry)` to write each
one keyed by its `agentId`. With 4 stale sets for
"clawsuu", all keyed the same way, the JS-side Map got
the LAST set in filesystem iteration order. Depending
on which set "won", the JS badge UI would either:

(a) Show a wrong/stale phrase, or

(b) Show nothing at all if the last-iterated set had a
malformed meta (missing phrase field, etc.).

The "No trained wake phrases yet" message Tobe saw is
case (b) — the winning set didn't make it through the
`entry?.phrase && entry?.path` guard.

Fix: filter to active-only via `isActiveWakeSet(meta)`.
The badge UI only ever cares which model is currently
hot-swapped into the running detector; non-active sets
should be invisible to this code path. The full list
(for the manager) goes through `listWakeSets()` which
keeps showing everything.

## Fix 2 — One-shot dedupe migration

`dedupeWakeSetsSync()` (new private function, called
from `getSavedWakeModels`, `listWakeSets`, and
`setWakeModelFromBase64`):

For each `(agentId, phrase)` group with multiple sets:
- Pick the survivor: prefer the set currently bound as
  `active_<agentId>`; fall back to the newest by
  `createdAt`.
- Delete the rest.

Runs idempotently on every relevant code path entry.
Cheap (small N, single directory scan). After install,
Tobe's 4 `wake-178396641****` orphans collapse to 1
within the first call to `getSavedWakeModels` /
`listWakeSets` (whichever fires first after upgrade).

## Why the v3.9.8 cleanup didn't catch Tobe's orphans

`setWakeModelFromBase64` v3.9.8 added cleanup that runs
BEFORE writing the new set. But Tobe's orphans were
created in prior training sessions, BEFORE v3.9.8 was
installed. The cleanup logic only sees sets that exist
at the time a new training fires — it doesn't proactively
scan on app startup.

The dedupe function in this release closes that gap:
runs on every wake-set code path entry, so it fires the
moment the user opens the Wake Manager or any other
code path that touches wake sets. Tobe will see the 4
orphans collapse to 1 the first time he opens the
manager after upgrading.

## Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (`getSavedWakeModels` filter, new
  `dedupeWakeSetsSync`, hook into `listWakeSets`)
- `package.json` (3.9.8 → 3.9.9)

## Verification

`./gradlew :app:compileDebugKotlin --offline` ✅

## Test plan after install

1. Open the app. The dedupe runs on the first wake-
   related code path call (likely `getSavedWakeModels`
   on Settings mount).
2. Open the Wake Manager. The 4 `wake-178396641****`
   orphans should collapse to 1 (the active one).
3. Open the Wake settings card for clawsuu. The "No
   trained wake phrases yet" message should be gone —
   replaced by the trained-phrase row showing the
   active wake phrase.
4. Train a new wake phrase. The old set should be
   auto-deleted; only the new one remains. (Same
   behavior as v3.9.8 — verified.)
5. For good measure: train a DIFFERENT phrase for the
   same companion. Should produce 2 sets (one per
   phrase) — different keys kept.

## Lesson (general)

Three rules for "list with metadata" APIs that share
keys:

1. **Active-only when the consumer cares about state** —
   don't include inactive items in the response when the
   consumer only wants the currently-bound one. Returning
   all (and overwriting on duplicate key) leads to
   non-deterministic "last-wins" behavior.
2. **Filter to one-per-key at the source** —
   `result.putMap(agentId, entry)` looks innocuous but
   silently overwrites on duplicate keys. If multiple
   items share a key, decide policy at the producer
   (which one wins, or aggregate, or list).
3. **Idempotent migrations run on every entry** —
   one-shot cleanup at app start is fragile (can be
   skipped on crashed installs, OTA upgrades, etc.).
   Cleaner pattern: run cleanup at every entry point
   that's relevant; cheap function, no downside.

## Companion release

Nothing desktop-side.
