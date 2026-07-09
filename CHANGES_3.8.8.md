# v3.8.8 — Send-word badge: reactive load on phrase change

Tobe: "Okey updated. Took a look at send training
again and noticed it said no training. Does it need
new training each time one updates? Ideally that
would persist through updates."

No — the model persists on disk. The badge was
lying.

Tobe trained `send magicly` in v3.8.3, the
`/home/humpsuu/.openclaw/cyberclaw/send-training/
send_magicly/output/model/send_send_magicly/
send_send_magicly.tflite` file is still on the
device, and AsyncStorage at
`cyberclaw-send-samples-send-magicly` still holds
the trainer's `{ trainedAt, modelPath }` payload.
The settings screen just wasn't reading it.

## Root cause

The v3.8.4 badge hydration was a one-shot call inside
the mount-time `useEffect`:

```js
loadSendModelInfo(voiceSendPhrase).then(info => {
  if (info) setSendModelInfo(info);
});
```

But `voiceSendPhrase` starts as the literal string
`'send'` (the initial state). The AsyncStorage hydrate
of the actual saved phrase (`'send magicly'`) happens
*after* this line, via `setVoiceSendPhrase(trimmed)`
in a separate `.then()`.

So the sequence was:
1. Mount → `voiceSendPhrase = 'send'` (initial state)
2. `useEffect` runs → calls `loadSendModelInfo('send')`
   → returns null (no key `cyberclaw-send-samples-send`)
   → `setSendModelInfo(null)`
3. Later in the same effect: `setVoiceSendPhrase
   ('send magicly')` (re-render triggered)
4. **No re-run of the load** → badge stays at
   "no trained send model yet"

The `useEffect` deps were empty, so it ran exactly once
at mount time with the wrong phrase.

## Fix

Replaced the one-shot inline call with a reactive
`useEffect([voiceSendPhrase])`:

```js
useEffect(() => {
  let cancelled = false;
  (async () => {
    const trimmed = voiceSendPhrase.trim().toLowerCase();
    if (!trimmed) {
      setSendModelInfo(null);
      return;
    }
    const info = await loadSendModelInfo(trimmed);
    if (!cancelled) setSendModelInfo(info);
  })();
  return () => { cancelled = true; };
}, [voiceSendPhrase]);
```

Now the load re-runs whenever the displayed phrase
changes:
- **Mount with the hydrated value**: the AsyncStorage
  hydrate sets `voiceSendPhrase = 'send magicly'` →
  effect re-fires → loads the trained model info
- **Every TextInput keystroke**: `onChangeText` updates
  `voiceSendPhrase` → effect re-fires → loads model
  info for the new phrase (cheap AsyncStorage read)
- **Trainer onComplete**: calls `setVoiceSendPhrase
  (trimmed)` → effect re-fires → loads the freshly-
  saved model info

The `cancelled` flag protects against a stale async
resolve: if the user types fast and the previous
in-flight load returns later, we ignore its result.

Removed the redundant inline `loadSendModelInfo(
voiceSendPhrase)` call at the original site — the
reactive effect handles it now. The other two call
sites (in `onChangeText` and trainer `onComplete`)
are now redundant with the effect but kept as
defensive duplication; they're idempotent.

## Files touched

- `src/screens/SettingsScreen.tsx`
  - new reactive `useEffect([voiceSendPhrase])` that
    loads the trained-model info
  - removed the stale-`voiceSendPhrase` inline call
- `package.json` (3.8.7 → 3.8.8)
- `android/app/build.gradle` (versionCode 222 → 223,
  versionName 3.8.7 → 3.8.8)

## Not touched

- The trainer's `AsyncStorage.setItem(...)` write
  (unchanged from v3.8.3, works correctly).
- `VoiceSettings.loadSendModelInfo` / `getSendSamplesKey`
  (unchanged).
- The wake trainer's `getSavedWakeModels` badge —
  same pattern, doesn't have this bug because its
  state hydrates atomically with the model list.
- Desktop.

## Quick answer to Tobe's question

> "Does it need new training each time one updates?"

**No.** The trained .tflite lives in the device's
internal storage under `filesDir/send_models/` (Kotlin
side) and persists across app updates. AsyncStorage
under `cyberclaw-send-samples-<phrase>` holds the
metadata (timestamp + filename) for the UI badge.
Reinstalling the app or clearing app data would wipe
both, but normal updates leave them alone.