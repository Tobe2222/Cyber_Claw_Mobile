# v3.10.155 — TTS bug fixes: probe timing, auto-bind, real voice picker

## What

Three TTS bugs from one Tobe screenshot, fixed together
because they all touch the same surface:

1. **"No TTS engine" alert fires AFTER voice mode exits.**
   Moved the probe + prompt to App.tsx mount time.
2. **RHVoice installed but not bound as system default → silent failure.**
   Added an auto-bind walk through known TTS engine
   packages so the app uses whatever's installed, even
   when the user hasn't set it as the system default.
3. **Voice picker doesn't actually pick anything.**
   `WakeWordModule.speakText()` had no voice parameter;
   the picker wrote to AsyncStorage but the native engine
   always used its default. Added `setTtsVoice` +
   `listInstalledTtsVoices` + persisted voice restoration
   on engine rebind.

## Why

### Bug #1: prompt timing

The old flow:
1. User exits voice mode.
2. App fires a `speak()` for the exit-reply cue.
3. Native TTS engine isn't bound → `speakText` rejects
   with `TTS_INIT_FAILED, status=-1`.
4. JS catch shows `Alert.alert('No TTS engine', ...)`
   while the user is already on the home screen.

Tobe (2026-08-11): "First of all it should check and or ask
for such things for it to open Instead of saying it after."

New flow:
1. App.tsx mounts.
2. After 0ms: prewarm TTS engine (already warms `applyPersistedVoice`).
3. After ~0ms: `listInstalledTtsEngines()` returns the engines
   on the device.
4. If ≥1 engine installed: log it, done. No prompt.
5. If 0 engines: check the dismissal cooldown
   (`cyberclaw-tts-prompt-dismissed-at` AsyncStorage key,
   7-day TTL). If dismissed recently, log + skip.
6. Otherwise: after a 2.5s delay (so the home screen has
   mounted and there's somewhere for the user to land
   after dismissing), show a single `Alert.alert`. One
   button: "Install" launches the F-Droid / Play Store
   intent. "Later" sets the dismissal timestamp.

The speak-time path no longer shows ANY alert. It just logs
and falls back to the WebView `speechSynthesis` (which is a
no-op on degoogled devices but lets the JS promise settle).

### Bug #2: RHVoice installed but not bound

`TextToSpeech(reactContext, listener)` (2-arg constructor)
binds to whatever the system has set as the default engine.
On stock Android that's Google TTS. On GrapheneOS +
CalyxOS + LineageOS the user has to dig into
Settings → Accessibility → Text-to-speech output →
Preferred engine to set RHVoice as default. Most users
skip this step → `status=-1` → silent failure → exit.

The 3-arg constructor `TextToSpeech(reactContext,
listener, packageName)` lets us bind to a specific engine
by package name. New `getTts()` flow:

1. Try default-engine bind (attempts 1-2, with the
   v3.10.39 cold-start retry).
2. If still failing: walk `knownTtsEnginePackages` in
   order: RHVoice → Google TTS → Samsung → eSpeak NG.
3. For each: try `TextToSpeech(ctx, onInit, pkg)`.
4. First SUCCESS wins. The rest are skipped.

Result: Tobe installs RHVoice from F-Droid → CyberClaw
launches → app finds RHVoice via PackageManager → auto-binds
to it → exit-reply cue plays in SLT. No settings change
required.

### Bug #3: voice picker writes to disk but native ignores it

Old code:
```js
// CompanionSettingsScreen saveVoice():
await saveVoiceFor(companionId, { engine, localId }); // writes AsyncStorage
setVcSavedAt(Date.now());
// ...but WakeWordModule.speakText(text, promise) doesn't
// take a voice arg. Native engine keeps using its default.
```

Until the next app cold start, the user's voice selection
was a dead letter. Fix:

- New `WakeWordModule.setTtsVoice(name)`:
  - Persists the choice in SharedPreferences
    (`cyberclaw_tts` / `voice_name`).
  - Calls `engine.setVoice(voice)` on the bound engine.
  - Resolves with the actually-applied name (which may
    differ if the engine doesn't have an exact match).
- New `WakeWordModule.getCurrentTtsVoice()`:
  - Returns the currently-applied voice name (or null).
- New `WakeWordModule.listInstalledTtsVoices()`:
  - Returns `[{name, locale, quality, isNetwork}]` for
    every voice on the bound engine. Handles the
    async-load race (voices arrive 100-500ms after
    `onInit SUCCESS`).
- New `applyPersistedVoice()`:
  - Runs automatically inside `getTts` after every
    successful bind.
  - Reads the persisted name, looks it up in
    `engine.voices` (exact match first, then case-
    insensitive substring), applies it via `setVoice`.
  - If voices aren't loaded yet (callback race), retries
    in 500ms.
  - If the persisted name doesn't match anything on the
    bound engine, clears the preference so we don't keep
    failing forever.

## Files changed

### `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`

- Added `ttsEnginePackage` field (tracks which package
  we ended up bound to).
- Added `ttsCurrentVoiceName` field (tracks the active
  voice name).
- Added `knownTtsEnginePackages` static list
  (RHVoice, Google TTS, Samsung, eSpeak NG).
- Rewrote `getTts()` to walk `knownTtsEnginePackages`
  after the default-engine retry exhausts. Uses the
  3-arg `TextToSpeech(ctx, onInit, packageName)`
  constructor for known packages.
- `attemptBind()` refactored: each attempt picks
  `bindPackage = null` (default) for attempts 1-2,
  then iterates `knownTtsEnginePackages` for attempt 3+.
- After every successful bind, calls `applyPersistedVoice()`
  to restore the user's voice choice.
- Added new ReactMethods:
  - `listInstalledTtsEngines(promise)`: returns
    `[{packageName, label, isDefault}]` from the
    known packages + the system default.
  - `setTtsVoice(name, promise)`: persists + applies
    the voice; resolves with the applied name.
  - `getCurrentTtsVoice(promise)`: returns the active
    voice name.
  - `listInstalledTtsVoices(promise)`: returns the
    bound engine's voice list (handles the async-load
    race with a 600ms retry).
- Added private `applyPersistedVoice()` helper.

### `App.tsx`

- Added `Alert` to the `react-native` imports.
- New `useEffect` on mount that:
  1. Prewarms the TTS engine.
  2. Lists installed engines.
  3. If ≥1 engine: logs the labels, no prompt.
  4. If 0 engines: checks the 7-day dismissal cooldown
     (`cyberclaw-tts-prompt-dismissed-at`).
  5. If cooldown expired or never dismissed: after a
     2.5s delay, shows the Alert.
  6. Alert buttons: "Later" sets the dismissal
     timestamp; "Install" launches
     `WakeWordModule.installTtsData()`.

### `src/screens/WakeModeScreen.tsx`

- Removed `ttsInstallPromptedRef` (was guarding
  per-session alert repeats; no longer relevant since
  the alert moved to mount time).
- Stripped the `TTS_INIT_FAILED + status=-1` Alert
  block from the speak failure path. The path now
  logs the failure + falls back to WebView
  `speechSynthesis` + resolves. No alert ever shown
  from inside voice mode.

### `src/screens/CompanionSettingsScreen.tsx`

- `saveVoice()` now calls `WakeWordModule.setTtsVoice(
  vcLocalId)` after writing to AsyncStorage. The voice
  change takes effect on the very next speak, not on
  the next cold start. If the engine isn't bound yet
  (probe at boot found nothing), the persisted value
  is reapplied on the next successful bind via the
  native `applyPersistedVoice()` helper.

## Migration safety

No new AsyncStorage keys. The persisted voice lives in
Android SharedPreferences (`cyberclaw_tts` /
`voice_name`) — fresh on install, survives upgrades.

## Testing notes

Tobe's exact scenario:
1. Install v3.10.155 (over v3.10.154).
2. RHVoice already installed on GrapheneOS.
3. CyberClaw launches.
4. App.tsx probe fires.
5. Native `getTts()` tries default-engine bind (fails
   because no default is set) → falls into the known-
   engines walk → finds RHVoice → binds via
   `TextToSpeech(ctx, listener,
   "com.github.olga_yakovleva.rhvoice.android")` →
   SUCCESS.
6. `applyPersistedVoice()` runs but the persisted
   name is empty (fresh install) → leaves
   `ttsCurrentVoiceName = null` (engine default voice
   used).
7. App continues without prompting.
8. User goes to CompanionSettings → Voice → Per-
   companion override → SLT → Save.
9. `saveVoice()` writes AsyncStorage + calls
   `setTtsVoice('slt')` → native finds the SLT voice
   in `engine.voices` → `engine.setVoice(sltVoice)` →
   success → `ttsCurrentVoiceName = "slt"`.
10. Next speak plays in SLT.

If RHVoice were NOT installed:
1. App.tsx probe fires.
2. `listInstalledTtsEngines()` returns `[]`.
3. Cooldown check passes (no prior dismissal).
4. After 2.5s: Alert "No TTS engine" appears.
5. User taps "Install" → Play Store / F-Droid opens.
6. User installs RHVoice, comes back.
7. Next app launch: probe succeeds, no prompt.
