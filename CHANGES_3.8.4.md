# v3.8.4 — Send-word: settings UI now shows trained-model status

Tobe: "Okey trained and perhaps the process finished
now. No indication that one is saved or not in the
settings."

The training pipeline now works end-to-end (v3.8.3 +
desktop v3.1.55 fixed the `slice(NaN)` bug; the
trainer reports "🎉 Done!" and the model is hot-
swapped on the device). But the settings screen had
no way to surface that.

The settings UI only knew about `voiceSendPhrase`
(the typed-in string) and `voiceSendPhraseSavedAt`
(set only when the user manually clicks 💾 Save).
After a successful training the user came back to
settings and the screen looked identical to before
training — same empty Save badge, no "trained"
indicator, no timestamp, no model path.

This release closes that gap.

## What changed

### 1. SendPhraseTrainer — typed onComplete contract

`onComplete?: () => void` → `onComplete?: (ok: boolean) => void`.
The trainer's success path already called `onComplete?.()`
with no args (silent bug), and the "Done" button called
`onComplete?.(stage === 'complete')` with a bool that
the parent's signature swallowed. Now the contract
matches the wake trainer's signature `(ok: boolean) => void`
so the parent can branch on success vs error.

### 2. SettingsScreen — bump saved state on training success

The send-phrase trainer's `onComplete` callback now
runs the same `saveSendPhrase` flow as the manual
Save button:

```
onComplete={async (ok) => {
  if (ok) {
    const trimmed = voiceSendPhrase.trim().toLowerCase();
    if (trimmed) {
      try { await saveSendPhrase(trimmed); } catch (_) {}
      setVoiceSendPhrase(trimmed);
      setVoiceSendPhraseSavedAt(Date.now());
      const info = await loadSendModelInfo(trimmed);
      if (info) setSendModelInfo(info);
    }
  }
  setShowSendPhraseTrainer(false);
}}
```

So after a successful training the user comes back to
the settings screen and immediately sees the green
"✅ Saved" badge on the Send word field (instead of
the stale "💾 Save" indicator from before they
tapped Train).

### 3. SettingsScreen — "Listening for: <phrase>" badge

Below the "Train send word (6 samples)" button, a new
status badge mirroring the wake trainer's getSavedWakeModels
badge:

- **Trained state** (green ✓): "Listening for '<phrase>'"
  with a sub-line "Trained <date> · <model filename>"
- **No model state** (gray): "No trained send model yet
  — tap 'Train send word' to record 6 samples and hot-
  swap one in."

State hooks: `sendModelInfo = { trainedAt, modelPath } | null`.
Loaded from AsyncStorage on mount via the new
`loadSendModelInfo(phrase)` helper in VoiceSettings,
refreshed on every phrase change (so switching between
'send' and 'magicly' shows the right model), and
refreshed again in the trainer's `onComplete` callback.

### 4. VoiceSettings — loadSendModelInfo helper

New exported helper `loadSendModelInfo(phrase): Promise<
{ trainedAt: number; modelPath: string } | null>` reads
the trainer's `{ trainedAt, modelPath }` payload from
AsyncStorage (the same key `getSendSamplesKey(phrase)`
the trainer writes to). The existing `loadSendSamples`
helper looks for a different shape (`{ phrase, features,
savedAt }`) that the trainer never writes — that's a
latent bug we leave alone for this release since the
features-load path isn't currently used by the
hot-swap bridge (the trainer ships the .tflite bytes
over the wire and the native side persists them in
filesDir/send_models/; the AsyncStorage entry is just
metadata for the UI).

### 5. Mobile version bump

- `package.json` `"version": "3.8.3" → "3.8.4"`
- `android/app/build.gradle` `versionCode 218 → 219`,
  `versionName "3.8.3" → "3.8.4"`

## Files touched

- `src/components/SendPhraseTrainer.tsx`
  (onComplete type + pass `true` on success)
- `src/screens/SettingsScreen.tsx`
  (import `loadSendModelInfo`; add `sendModelInfo`
  state; hydrate on mount + on phrase change;
  refresh in trainer `onComplete`; render the
  "Listening for" badge below the train button;
  add `sendModelBadge*` styles)
- `src/services/VoiceSettings.ts`
  (export `loadSendModelInfo` helper)
- `package.json` (3.8.3 → 3.8.4)
- `android/app/build.gradle` (versionCode 218 → 219)

## Not touched

- Desktop — no changes needed. v3.1.55 already
  correctly sends `send_training_result {ok, tflitePath}`
  and `send_model_data {ok, base64}` back to the mobile.
- SyncClient — `send_training_progress` /
  `send_training_result` / `send_model_data` listeners
  are unchanged.
- Wake / exit trainers — they already show their
  trained-model badges via getSavedWakeModels / the
  per-companion exit cache.
- Other screens — HomeScreen, WakeModeScreen, etc.
  unchanged.