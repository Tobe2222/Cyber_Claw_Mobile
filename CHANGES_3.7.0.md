# v3.7.0

Per-companion Voice & Speech. The 🔊 Voice picker is now per-companion
inside each companion's settings page; the global 🔑 API keys section
keeps holding the master API key + the master "✨ Enable API speech"
toggle that gates whether per-companion voice pickers can offer
"Premium API" as an option.

This is the architectural change Tobe asked for after v3.6.2: different
companions can have different voices (e.g. Lamasuu = Male, Clawsuu =
Female) without changing the global default.

## 1. New "🔊 Voice" card in the companion detail view

The companion settings screen had a 3-level hierarchy from v3.4.3:
overview (cards) → Wake sub-page / Exit sub-page. v3.7.0 adds a third
sub-page: **🔊 Voice**. New card on the overview, green border
(different from the blue Wake card and orange Exit card) so the
three sub-pages are visually distinct.

Tap the Voice card → 🔊 Voice sub-page with:
- **Engine selector** with three options:
  - 🌐 **Use global default** — inherit whatever the global master
    is set to right now (inherits the v3.6.2 master toggle state).
  - 📱 **Local (free)** — Android TTS, always available.
  - ✨ **Premium API** — cloud TTS (ElevenLabs / Google). Disabled
    (greyed out) when the global "✨ Enable API speech" master
    toggle is off, with a hint that points the user at the global
    🔑 API keys section.
- **Voice picker** that swaps based on the selected engine:
  - Local → the LOCAL_VOICES list (System Default / Male / Female).
  - Premium API → provider picker (ElevenLabs / Google Cloud TTS) +
    voice picker for the selected provider.
- **Currently** status row: shows what would actually be used right
  now (e.g. "Local — 👨 Male" or "Premium API — elevenlabs / nova").
- **Save** button — persists the four per-companion keys.
- **Reset to global default** — clears the per-companion override,
  reverting to the global defaults.

## 2. Per-companion AsyncStorage keys

New keys (in `src/services/VoiceSettings.ts`):

| Key | Values |
|---|---|
| `cyberclaw-voice-engine-<companionId>` | `'local'` \| `'api'` \| `'default'` |
| `cyberclaw-voice-local-id-<companionId>` | voice id (e.g. `'male'`, `'female'`) |
| `cyberclaw-voice-api-provider-<companionId>` | provider id (e.g. `'elevenlabs'`) |
| `cyberclaw-voice-api-voice-<companionId>` | voice id (e.g. `'nova'`) |

For each field, a missing per-companion key means "use the global
default" — see `loadVoiceFor(companionId)` in `VoiceSettings.ts`. The
"Use global default" engine option writes the literal string
`'default'` for the engine key, so the user can explicitly opt back
into inheritance after picking a local override.

The global keys (`cyberclaw-voice-engine`, `cyberclaw-voice-local`,
`cyberclaw-voice-api-provider`, `cyberclaw-voice-api-voice`) written
by the v3.6.2 API keys section are still consulted as the
fallback. Existing v3.6.2 users who had a global voice chosen
continue to get that voice everywhere until they set a per-companion
override.

## 3. Shared voice catalog

The `LOCAL_VOICES` and `PREMIUM_PROVIDERS` constants previously
lived inside `SettingsScreen.tsx`. v3.7.0 lifts them to
`src/services/VoiceCatalog.ts` so the per-companion picker can
re-use the same list. Both the global Settings screen and the
companion Voice sub-page now import from there. No data-model
change, just deduplication.

`VoiceCatalog.ts` also exports the type `VoiceEngine` and a few
default id constants (`DEFAULT_LOCAL_VOICE_ID`, `DEFAULT_API_PROVIDER_ID`,
`DEFAULT_API_VOICE_ID`) so future call-sites can refer to them
without hardcoding strings.

## 4. TTS layer is unchanged

Verified that the working TTS playback path in `HomeScreen.tsx` and
`WakeModeScreen.tsx` does NOT read `voiceLocalId` / `voiceEngine` /
`voiceApiKey` / `voiceApiVoice` / `voiceApiProvider` from anywhere.
Those settings are write-only as far as the on-device TTS layer is
concerned. The v3.6.2 lesson ("dead config fields are easy to ship
and hard to spot") applies here: the existing TTS path picks the
voice from a hardcoded path or a different config, not from these
keys. v3.7.0 doesn't try to fix that — the per-companion voice
setting is data the desktop will consume when the per-companion
synthesis bridge lands, and a UI affordance for the user to
configure per-companion voice in the meantime.

## Files changed

- `src/services/VoiceCatalog.ts` (new) — shared voice + provider
  catalog, type `VoiceEngine`, default id constants.
- `src/services/VoiceSettings.ts` — new `loadVoiceFor(companionId)`,
  `saveVoiceFor(companionId, patch)`, `clearVoiceFor(companionId)`
  helpers and the per-companion key builders. No changes to
  existing functions.
- `src/screens/SettingsScreen.tsx` — replaced the file-local
  `LOCAL_VOICES` and `PREMIUM_PROVIDERS` constants with imports
  from `VoiceCatalog`. No UI or behaviour change.
- `src/screens/CompanionSettingsScreen.tsx` — added the
  `companionViewPhase = 'voice'` branch, the new 🔊 Voice
  card on the overview, and the `renderCompanionVoicePage`
  sub-page (with the engine / voice pickers, status row,
  Save, and Reset to global default). Added radio-row
  styles (`radioRow`, `radioRowActive`, `radioBullet`,
  `radioTitle`, `radioSub`).
