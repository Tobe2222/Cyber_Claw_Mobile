# Trainer Manager — Implementation Plan

User request: "in each of the trained data functions it should have a import/export option. the user should get a list of which of the training sets should be active, and the ability to rename them."

## Storage shape (one schema for all three categories)

```
filesDir/<category>_models/<setId>/
  model.tflite
  meta.json   { setId, phrase, category, scope, createdAt, sizeBytes }
```

Where:
- `category` ∈ {`wake`, `exit`, `send`}
- `scope` is either `agent:<agentId>` (wake, exit) or `global` (send)
- `setId` is user-chosen, defaults to `<phrase>-<timestamp>` (e.g. `hey-clawsu-1783635000000`)

## Active binding (SharedPreferences)

| Key                                      | Value   |
|------------------------------------------|---------|
| `active_wake_<agentId>`                  | setId   |
| `active_exit_<agentId>`                  | setId   |
| `active_send`                            | setId   |

The wake detector and exit/send interpreters resolve the active setId → meta.json → model.tflite on app boot.

## Migration (v3.8.x → v3.9)

Existing single-file storage:
- `filesDir/wake_models/<agentId>.tflite` → `filesDir/wake_models/<agentId>/model.tflite` + meta.json
- `filesDir/exit_models/<phrase>.tflite` → `filesDir/exit_models/<phrase>/model.tflite` + meta.json
- `filesDir/send_models/<phrase>.tflite` → `filesDir/send_models/<phrase>/model.tflite` + meta.json

Migration runs on first loadOww call. Old SharedPreferences keys (`<agentId>_path`, `<agentId>_phrase`) get rewritten into the new active-set keys.

## New Kotlin API surface

```kotlin
// List all sets for a category (optionally scoped)
listModelSets(category: String, scope?: String, promise: WritableMap)

// Get the active setId for a scope
getActiveModelSet(category: String, scope: String, promise: String?)

// Set the active setId for a scope (also hot-swaps into the running detector)
setActiveModelSet(category: String, scope: String, setId: String, promise: Boolean)

// Rename a set (moves the directory + updates meta.json)
renameModelSet(category: String, oldSetId: String, newSetId: String, promise: Boolean)

// Delete a set (also clears the active binding if it was active)
deleteModelSet(category: String, setId: String, promise: Boolean)

// Save a freshly-trained set from base64 (replaces setWakeModelFromBase64 etc.)
saveModelSet(category: String, setId: String, scope: String, phrase: String, base64: String, promise: String)

// Read the raw .tflite bytes for an existing set (for export)
readModelSet(category: String, setId: String, promise: WritableMap {base64, path, size})

// Import a set from base64 + meta (reuses saveModelSet, but a separate helper sets the import path)
importModelSet(category: String, setId: String, scope: String, phrase: String, base64: String, promise: String)
```

## New SyncClient wire protocol

| Message                                       | Direction   | Purpose |
|-----------------------------------------------|-------------|---------|
| `list_<category>_sets`                        | M → D       | Desktop returns the cached `.tflite`s in `~/.openclaw/cyberclaw/<category>-training/` |
| `<category>_sets_list`                        | D → M       | `[{setId, phrase, sourcePath, sizeBytes, modifiedAt}]` |
| `import_<category>_set_from_desktop`          | M → D       | `{setId, sourcePath}` |
| `<category>_set_imported`                     | D → M       | `{setId, base64, sizeBytes}` (or `{ok:false, error}`) |
| `export_<category>_set_to_desktop`            | M → D       | `{setId, base64, phrase}` |
| `<category>_set_exported`                     | D → M       | `{ok, setId, savedPath}` or `{ok:false, error}` |

The desktop's main.js writes these to the existing `<category>-training/<safe_phrase>/output/model/<name>.tflite` paths so a future training run / list call sees them.

## Set-list screen UX

Reachable from settings → "Wake word sets" / "Exit phrase sets" / "Send word sets" buttons.

For each set:
- Active badge (green ✓ if `setId == active_set_for_scope`)
- Phrase (large)
- Created at + size (small)
- "Activate" button (sets active + hot-swaps)
- "Rename" button (modal with TextInput)
- "Export" button → action sheet: "Save to file" / "Push to desktop"
- "Delete" button (with confirm Alert)

Plus a sticky "+ Import" button at the bottom:
- Tap → action sheet: "Import from file" / "Pull from desktop"

"Pull from desktop" opens a list screen showing the desktop's available sets (from the `list_<category>_sets` round-trip), each with "Pull" button.

## Files to touch

### Mobile
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — new API surface + migration
- `src/components/SetListScreen.tsx` — new screen, one per category (or shared with category prop)
- `src/components/RenameSetModal.tsx` — small modal
- `src/services/SyncClient.ts` — wire protocol additions
- `src/services/VoiceSettings.ts` — JS-side set registry helpers
- `src/screens/SettingsScreen.tsx` — three new "Manage sets" buttons
- `src/App.tsx` (or equivalent navigation) — wire SetListScreen into the routing

### Desktop
- `src/main.js` — new syncServer cases for `list_<category>_sets`, `import_*`, `export_*` + handlers
- `src/sync-server.js` — wire-protocol cases

## Versioning

- Mobile 3.9.0 (minor bump — new feature)
- Desktop 3.2.0 (minor bump)

## Rollout strategy

- v3.9.0: ship migration + SetListScreen for wake only (most mature). Exit + send in v3.9.1 + v3.9.2 to keep diff small.

Actually wait — Tobe asked for all three. Let me ship all three in v3.9.0 and tag it once. Migration runs lazily for each category on first read.