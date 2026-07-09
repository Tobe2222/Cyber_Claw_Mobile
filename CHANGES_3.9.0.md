# v3.9.0 — Trainer Manager (wake): list / activate / rename / delete / pull / push

Tobe: "in each of the trained data functions it should
have a import/export option. the user should get a list
of which of the training sets should be active, and the
ability to rename them."

This release is the wake-only first cut of the trainer
manager. Exit / send follow in v3.9.1 / v3.9.2.

## What's new

### Wake Set Manager screen

Reachable from each companion's per-detail settings
view — a new "📂 Manage wake sets" button next to the
"Train new wake phrase" button.

Shows every wake .tflite for that companion (and any
other companions the user has trained). Each row:

- **setId** (e.g. `hey-clawsu-1783635123456`)
- **phrase** (the wake word text)
- **sizeBytes · createdAt** (metadata)
- **✓ Active badge** (green border + tag) when this
  set is the agent's active set

Per-row action buttons:
- **Activate** — sets the active binding for this
  companion and hot-swaps the .tflite into the running
  OpenWakeWordDetector
- **Rename** — modal with TextInput; moves the directory
  + updates meta.json + rewrites the active binding if
  needed
- **Push ↗** — copies the .tflite to the desktop's
  `~/.openclaw/cyberclaw/wake-training/<agent>/output/
  model/<phrase>.tflite` for backup
- **Delete** — removes the directory + meta.json +
  clears the active binding if this set was active

Sticky bottom button:

- **+ Pull from desktop** — opens a sheet listing every
  `.tflite` the desktop has in its wake-training cache
  (`~/.openclaw/cyberclaw/wake-training/`). Tap "Pull"
  on any row to copy it into the device's local set
  registry under a `<setId>__imported-<ts>` directory
  and set it as the active set for this companion.

### Storage schema (v3.9.0)

```
filesDir/wake_models/<setId>/
  model.tflite
  meta.json   {
    setId, phrase,
    scope: "agent:<agentId>",
    agentId: "<agentId>",
    createdAt: <epoch ms>,
  }
```

Active binding is now per-scope:
`active_wake_<agentId>` → setId in SharedPreferences.

### Migration (v3.8 → v3.9)

Runs lazily on first call to any new API method. For
every agentId with a legacy `<agentId>_path` /
`<agentId>_phrase` / `<agentId>_savedAt` binding:

1. Move `filesDir/wake_models/<agentId>.tflite` →
   `filesDir/wake_models/<agentId>__legacy/model.tflite`
2. Write meta.json next to it
3. Set `active_wake_<agentId>` → `<agentId>__legacy`
4. Delete the legacy SharedPreferences keys

The setId for migrated sets is `<agentId>__legacy`
(deterministic, easy to rename in the manager UI).
Migration is idempotent — re-running on a clean v3.9
device is a no-op.

### Trainer behavior change

`setWakeModelFromBase64` now creates a NEW set per
training instead of overwriting the existing file.
Default setId is `<phrase>-<timestamp>` (e.g.
`hey-clawsu-1783635123456`); the previous (if any) is
left in place as an inactive set. The user can re-activate
it from the manager, delete it, or rename it.

### New Kotlin API

`WakeWordModule` exposes:

```kotlin
migrateWakeSets(promise)              // run migration; returns count
listWakeSets(promise)                 // Map<setId, {setId, phrase, scope, agentId, createdAt, sizeBytes, active}>
getActiveWakeSet(agentId, promise)    // String?
setActiveWakeSet(agentId, setId, promise)  // hot-swaps
renameWakeSet(oldSetId, newSetId, promise)
deleteWakeSet(setId, promise)
readWakeSet(setId, promise)           // {base64, sizeBytes, path}  -- for export
```

### New sync-server wire protocol (desktop)

| Message                                  | Direction | Purpose |
|------------------------------------------|-----------|---------|
| `list_wake_sets_from_desktop`            | M → D     | desktop returns `wake_sets_list {sets: [...]}` |
| `wake_sets_list`                         | D → M     | list of cached .tflites |
| `import_wake_set_from_desktop`           | M → D     | `{setId, sourcePath}` → desktop emits `wake_set_imported {ok, base64, sizeBytes}` or `{ok:false, error}` |
| `wake_set_imported`                      | D → M     | the imported bytes |
| `export_wake_set_to_desktop`             | M → D     | `{setId, base64, phrase}` → desktop emits `wake_set_exported {ok, savedPath}` |
| `wake_set_exported`                      | D → M     | ack |

### Files touched

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  - new `migrateWakeSets` / `listWakeSets` /
    `getActiveWakeSet` / `setActiveWakeSet` /
    `renameWakeSet` / `deleteWakeSet` / `readWakeSet`
  - `setWakeModelFromBase64` rewritten to create a
    new set per training (was: overwrite the file)
  - `loadOwwSavedModel` / `getSavedWakeModels`
    rewritten to read from the new registry (the
    legacy SingleFile-by-agentId shape is preserved
    in `getSavedWakeModels` for UI badge compat)
- `src/components/WakeSetManagerScreen.tsx` (new)
- `src/services/SyncClient.ts`
  - new `requestListWakeSetsFromDesktop` /
    `importWakeSetFromDesktop` /
    `exportWakeSetToDesktop`
- `src/screens/SettingsScreen.tsx`
  - import `WakeSetManagerScreen`
  - new `showWakeSetManager` gate
- `src/screens/CompanionSettingsScreen.tsx`
  - import `WakeSetManagerScreen`
  - new "📂 Manage wake sets" button per companion
  - gate renders the manager screen overlay
- `cyberclaw/src/sync-server.js` — three new
  `_handleMessage` cases
- `cyberclaw/src/main.js` — three new
  `syncServer.on('list_wake_sets_from_desktop', ...)` etc
  handlers
- `package.json` (3.8.8 → 3.9.0)
- `android/app/build.gradle` (versionCode 223 → 224,
  versionName 3.8.8 → 3.9.0)
- `cyberclaw/package.json` (3.1.53 → 3.2.0)
- `docs/trainer-manager-plan.md` (new — design doc
  for the full wake/exit/send rollout)

### Not touched (v3.9.1 / v3.9.2 will do these)

- Exit phrase manager — same shape, per-companion
  per-phrase
- Send word manager — global, per-phrase
- File-picker import/export (system SAF picker) —
  v3.10 if Tobe wants it
- iOS — no native module changes for this release
  (the WakeWordModule methods are Android-only; the
  manager screen renders on whatever the React Native
  side can do, but iOS would need a separate native
  implementation of the storage + set registry)

## What to test (Tobe)

1. Update the desktop to v3.2.0 (`cd cyberclaw && git
   pull && npm start`). Restart.
2. Update the mobile to v3.9.0 (build APK from
   `.github/workflows/build.yml` v3.9.0 tag, or local
   install).
3. Open the app, go to a companion's detail view.
4. Tap "📂 Manage wake sets". You should see all your
   existing wake .tflites listed with the green
   "✓ Active" badge on the one that's currently hot.
5. Tap "Activate" on a different one → that set
   becomes active. The companion's wake word changes.
6. Tap "Rename" → modal opens, type a new name → tap
   "Rename". The setId in the row updates.
7. Tap "Push ↗" on a set → desktop log shows
   `[wake-mgr] Exported wake set ... → /home/.../wake-training/...`
8. Tap "Delete" → confirm → set disappears.
9. Tap "+ Pull from desktop" → sheet opens with the
   desktop's cached sets. Tap "Pull" on any → that
   set becomes the active set for this companion.