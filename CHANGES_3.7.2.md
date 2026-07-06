# v3.7.2

Two follow-ups to v3.7.1: rename the listening section, and move
the silence option out of the global settings into the per-companion
voice sub-page.

## 1. "🎧 Companion listening" → "🎧 Wake listening"

v3.7.1 renamed the section from "Listening settings" to
"Companion listening". Tobe's feedback: "Companion listening" is
verbose. The section governs the wake-word pipeline (master
background-listening toggle), so "🎧 Wake listening" is shorter
and makes the scope explicit. The section description was
updated to point at the per-companion voice sub-page for engine /
voice / silence settings.

The section is now just the master Background listening toggle.
The silence-to-end-turn knob was moved out (see below).

## 2. Silence-to-end-turn is now per-companion

The "Silence to end turn" option was a global setting (stored
under `cyberclaw-voice-silence-ms`, edited in the listening
section). It's now per-companion, edited in each companion's
Voice sub-page. Rationale: different companions can have
different conversation rhythms (a chatty companion wants a
longer silence window than a terse one).

### Storage

New per-companion key:

| Key | Values |
|---|---|
| `cyberclaw-voice-silence-ms-<companionId>` | Number (2000..10000), clamped |

The legacy global key `cyberclaw-voice-silence-ms` is **read-only
fallback** after v3.7.2: `loadVoiceSettings(companionId)` reads
the per-companion key first, and falls back to the global key if
missing. So v3.7.1 users keep their existing silence setting for
any companion that hasn't been overridden. The first time they
touch the silence slider in a companion's voice sub-page, that
companion gets its own per-companion value.

`saveSilenceMs(companionId, ms)` (signature changed — now takes a
companionId) writes the per-companion key. The global key is
never written by v3.7.2+.

### Code

`src/services/VoiceSettings.ts`:
- New `getSilenceMsKey(companionId)` helper.
- `loadVoiceSettings(companionId?)` reads per-companion silence
  first, then global fallback, then default. Existing callers
  (`WakeModeScreen.tsx`) pass a `companionId` already, so they
  pick up the new per-companion behaviour automatically.
- `saveSilenceMs(companionId, ms)` writes the per-companion key.

`src/screens/CompanionSettingsScreen.tsx`:
- New voice-sub-page state: `vcSilenceMs`, `vcSilenceSavedAt`,
  `vcSilenceLoadedRef`. Lifted to the screen level (alongside
  the existing voice state) so the render-function stays
  hook-free.
- New rehydration `useEffect([companionId])` that calls
  `loadVoiceSettings(companionId)` and pulls `silenceMs`.
- New `useCallback` `saveSilence` that calls `saveSilenceMs(companionId, ms)`.
- New UI in the voice sub-page: a SubTitle "Silence to end turn:
  Ns" + a list of radio rows for 2s / 3s / 5s / 7s / 10s, with
  the same radio styles as the engine / voice pickers. A
  separate "Save silence setting" button commits the choice
  (matches the wake/exit pattern of one save button per setting
  group, so the user can change engine / voice / silence
  independently).

`src/screens/SettingsScreen.tsx`:
- Removed `voiceSilenceMs` state, the on-mount hydration of
  `cyberclaw-voice-silence-ms`, and the silence option block.
- The "🎧 Companion listening" Section was renamed to "🎧 Wake
  listening" (title, description, file-header section list,
  historical v3.4.7 / v3.6.2 comments).
- The "Wake listening" Section now contains only the master
  Background listening toggle.

## Files changed

- `src/services/VoiceSettings.ts` — `getSilenceMsKey`,
  per-companion-aware `loadVoiceSettings`, `saveSilenceMs(companionId, ms)`.
- `src/screens/CompanionSettingsScreen.tsx` — silence state +
  rehydration + save callback + new UI in the voice sub-page.
- `src/screens/SettingsScreen.tsx` — rename "Companion listening"
  → "Wake listening", remove silence option + state + hydration.
