# v3.10.154 — strip cloud-TTS scaffolding, local-only voices

## What

Removed **all** ElevenLabs / Google Cloud TTS scaffolding from
the mobile app. They were decorative — the desktop never honored
them, never had an ElevenLabs client, and the user picker in
Settings pointed at voices that never played. All TTS now
flows through the device's Android `TextToSpeech` engine
(Google TTS, RHVoice, eSpeak NG, Samsung TTS, etc.) — same as
it did at runtime before this release, just with the dead UI
gone.

## Why

- The "✨ Premium API" picker was non-functional. Anyone who
  picked it got silent piper-on-the-desktop anyway.
- The mobile preference keys (`cyberclaw-voice-api-provider-*`,
  `cyberclaw-voice-api-voice-*`, `cyberclaw-voice-api-key`) were
  never read by the desktop, so saving them was a no-op.
- RHVoice install on GrapheneOS (Tobe's setup) replaces the
  Android system TTS provider transparently — no app change
  needed once the dead cloud options were out of the way.
- Local-first direction. Cloud TTS added latency, cost, and a
  privacy footprint for no gain.

## Files changed

### `src/services/VoiceCatalog.ts`

- Removed `PremiumProvider` / `PremiumVoice` types.
- Removed `PREMIUM_PROVIDERS` export (ElevenLabs + Google Cloud).
- Removed `DEFAULT_API_PROVIDER_ID` / `DEFAULT_API_VOICE_ID`
  exports.
- `VoiceEngine` simplified from `'local' | 'api' | 'default'`
  to `'local' | 'default'`.
- Expanded `LOCAL_VOICES` to include the three RHVoice
  canonical English voice names (`slt`, `clb`, `bdl`) with
  engine hints ("RHVoice required"). The native bridge
  resolves these by name; if the user doesn't have RHVoice
  installed, the system default is used as a fallback.

### `src/services/VoiceSettings.ts`

- `ResolvedVoiceConfig` stripped of `apiProvider` / `apiVoice`.
- Removed `getVoiceApiProviderKey` / `getVoiceApiVoiceKey`
  exports.
- `loadVoiceFor()` now returns `{ engine: 'local', localId }`
  only — no fallback to "elevenlabs"/"nova" defaults.
- `saveVoiceFor()` / `clearVoiceFor()` no longer write or
  remove the API keys.
- Added `migrateV3_10_154_dropCloudTts()`: one-shot
  AsyncStorage cleanup that:
  1. Removes all `cyberclaw-voice-api-provider[-…]`,
     `cyberclaw-voice-api-voice[-…]`, and
     `cyberclaw-voice-api-key` keys (any persisted
     ElevenLabs keys are deleted so secrets don't linger).
  2. Rewrites any `engine: 'api'` (global + per-companion)
     to `engine: 'default'` so the user falls back to the
     global master instead of staying stuck on an
     invalid engine.
  3. Rewrites any `localId: 'nova'` (ElevenLabs Nova
     default) to `'default'` — Nova isn't a valid local
     voice id and would render as a broken picker entry.
  Idempotent, safe to call on every launch.

### `src/screens/SettingsScreen.tsx`

- Deleted the entire **🔑 API keys** section (ElevenLabs
  key input, ✨ API speech master toggle, provider picker,
  default API voice picker).
- Removed `voiceApiKey` / `voiceApiProvider` /
  `voiceApiVoice` state hooks + their `useEffect` loads +
  their setters (`setVoiceApiKeyAndSave`,
  `setVoiceApiProviderAndSave`, `setVoiceApiVoiceAndSave`,
  `setVoiceEngineAndSave`).
- Dropped the `PREMIUM_PROVIDERS` import.
- Top-of-file docblock updated: section 8 (🔑 API keys) is
  gone, voice selection is per-companion only.

### `src/screens/CompanionSettingsScreen.tsx`

- Removed `vcApiProvider` / `vcApiVoice` / `vcGlobalApiEnabled`
  state hooks.
- Removed the **✨ Premium API** radio + provider/voice
  pickers from the per-companion voice sub-page. The
  sub-page now has just two engine choices: **🌐 Use global
  default** (inherit) and **📱 Per-companion override**
  (pick a specific voice below).
- Voice picker labels now show the `engineHint` from
  `VoiceCatalog` so the user knows e.g. "SLT — RHVoice
  required".
- "Currently using" status row simplified to one engine
  (local) — was previously two engines with a
  hard-to-explain "is api globally enabled" indirection.
- `saveVoice()` and `resetToGlobal()` updated to drop
  the `apiProvider` / `apiVoice` fields.
- Hydration logic normalizes legacy `engine: 'api'`
  values to `'default'` for any companion that hasn't
  been migrated yet.
- Dropped the `PREMIUM_PROVIDERS` import.

### `App.tsx`

- New `useEffect` runs `migrateV3_10_154_dropCloudTts()`
  on mount, alongside the existing
  `migrateLegacyTurnCueKey()`. Logs a one-line summary
  if anything was cleared or normalized so we can
  verify on first launch.

## Migration safety

- All removed state had an AsyncStorage backing key. The
  migration walks AsyncStorage at first launch, removes the
  obsolete keys, and normalizes any invalid engine / voice
  values to `'default'`. The user never sees a broken
  picker even if they had `engine: 'api'` or
  `localId: 'nova'` stored from earlier builds.
- The ElevenLabs API key (if any user ever pasted one in)
  is deleted from disk by the migration. No cloud secrets
  lingering on the phone.
- Idempotent — re-running on subsequent launches is a
  no-op (counts of cleared/normalized stay at 0).

## Backwards compatibility

- A v3.10.154 install over a v3.10.153 install: migration
  runs, user sees no change in their voice selection
  (their stored `localId` is preserved; only the
  premium-api fields are dropped).
- A v3.10.153 install over a v3.10.154 install: no data
  loss. The v3.10.153 code reads the same
  `cyberclaw-voice-engine-<id>` / `cyberclaw-voice-local-id-<id>`
  keys; missing keys fall back to defaults.

## Not in this release (planned for follow-ups)

- **Native voice discovery** — the picker still shows a
  fixed catalog (`default` / `slt` / `clb` / `bdl` /
  `male` / `female`). A future version can add a
  `listInstalledVoices()` ReactMethod that queries
  Android's `TextToSpeech.voices` and renders whatever's
  actually installed (Pico, Samsung, RHVoice extras,
  language variants, etc.). For now the canonical name
  approach works for the common case.
- **Per-companion voice resolution** — the per-companion
  localId is stored on the phone but not bridged to the
  desktop. Desktop still piper-synthesizes for AI
  replies. Mobile uses Android TTS for greetings + exit
  replies + working speech. The phone IS honoring the
  per-companion localId via WakeWordModule.speakText();
  the desktop AI-reply path is a separate problem.
- **Per-engine voice selection** — when more TTS backends
  land (system TTS, custom neural, etc.), the picker
  will need to grow. The catalog already accommodates
  the `engineHint` field for that.
