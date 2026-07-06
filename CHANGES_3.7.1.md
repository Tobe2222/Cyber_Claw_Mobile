# v3.7.1

Hotfix for two v3.7.0 issues: a hard crash when entering the new
per-companion Voice sub-page, and a UX cleanup that removes the now-
redundant global Voice & Speech section.

## 1. Crash fix: "Rendered more hooks than during the previous render"

v3.7.0's `renderCompanionVoicePage` placed its state inside the
helper function itself (4 × `useState`, 1 × `useEffect`, 1 ×
`useRef`, 2 × `useCallback`). The dispatch at the top of the
companion screen picks one of four render-functions per render
(Wake / Exit / Voice / Overview). The existing Wake and Exit
helpers don't call any hooks; only the new Voice one did. So:

- On the first render of the voice page: 6 hooks ran inside the
  helper. React's hook bookkeeping recorded "this component has 6
  hooks".
- On the next render after backing out: the dispatch called
  `renderCompanionOverview` (0 hooks). React saw "this component
  has 0 hooks" — fewer than the previous render — and threw
  "Rendered more hooks than during the previous render."

**Fix:** lift all 6 hooks + 2 callbacks to the top-level
`CompanionSettingsScreen` component, alongside the existing
wake-greeting / exit-phrase state. The render-function is now
pure, matching the existing pattern for `renderCompanionWakePage`
and `renderCompanionExitPage`. The hydration `useEffect` keys on
`companionId` so the picker reloads when the user navigates
between companions (same pattern as the exit-phrase rehydration).

A `vcLoadedRef` is reset in the hydration effect so Save doesn't
overwrite the per-companion override with default values before
the load completes.

**Lesson (re-confirmed):** React's hook rules don't just apply to
"called in a loop" or "called conditionally" — they also apply
to "called inside a function that may or may not be called from
a different render path." The existing wake/exit helpers were
pure-render functions and I should have followed that pattern
when adding the voice one. The fix is to make the render-
function pure (state lives at the screen level) and use a
companionId-keyed `useEffect` to re-hydrate when the active
companion changes. Same pattern the wake-greeting and exit-phrase
state already use.

## 2. Remove the global Voice & Speech section

v3.7.0's per-companion voice picker makes the global Voice &
Speech section redundant. Tobe flagged this after testing. The
global section had:
- A Local voice picker (System Default / Male / Female) — now
  in the per-companion voice sub-page.
- A "Test local voice on phone" button — moved to the
  per-companion voice sub-page.
- A "Test voice on desktop" button — moved to the per-companion
  voice sub-page.
- A "✨ Premium API voice" hint pointing at the per-companion
  picker (which is now live, so the hint is moot).

The section is deleted. The global state variables it consumed
(`voiceLocalId`, `setVoiceLocalIdAndSave`, `testLocalVoice`,
`testDesktopVoice`) were removed from `SettingsScreen.tsx`. The
AsyncStorage key `cyberclaw-voice-local` is still read by
`loadVoiceFor()` in `VoiceSettings.ts` as a fallback for
companions with no per-companion override — but no Settings
screen UI writes it anymore. The `LOCAL_VOICES` import was
dropped from `SettingsScreen.tsx`; `CompanionSettingsScreen.tsx`
already imports it from `VoiceCatalog.ts`.

The 🔑 API keys section at the bottom is unchanged: it still
holds the global ElevenLabs key, the master "✨ Enable API
speech" toggle, the provider picker, and the default API voice
(all used as fallbacks for companions with no per-companion
override).

## 3. "Listening settings" → "Companion listening"

Renamed the section. "Listening settings" was vague — the section
governs *companion* behaviour (master wake-word listening toggle,
voice-mode silence timeout), not the device's microphone in
general. The new name matches the 🐾 Companions section naming
and makes the scope explicit. The header description was
updated to match.

## Files changed

- `src/screens/CompanionSettingsScreen.tsx`:
  - Lift the 6 voice-page hooks (vcEngine, vcLocalId, vcApiProvider,
    vcApiVoice, vcGlobalApiEnabled, vcSavedAt, vcLoadedRef) from
    `renderCompanionVoicePage` to the top-level screen component.
  - Add a `useEffect([companionId])` rehydration that loads
    `loadVoiceFor(companionId)` on mount and on companion switch,
    mirroring the exit-phrase rehydration at the top of the file.
  - Add `useCallback` × 2 at the screen level: `saveVoice` and
    `resetToGlobal`. Move them out of the render-function for
    the same hook-rule reason.
  - Add the `testLocalVoice` and `testDesktopVoice` helpers as
    module-level functions (they were moved from SettingsScreen).
  - Add Test buttons to the per-companion voice sub-page JSX,
    right after Save / Reset to global default.
  - Import `syncClient` for the desktop Test button.

- `src/screens/SettingsScreen.tsx`:
  - Remove the global "🔊 Voice & Speech" Section.
  - Remove dead state: `voiceLocalId`, `setVoiceLocalIdAndSave`,
    `testLocalVoice`, `testDesktopVoice`. The `LOCAL_VOICES`
    import is dropped; `PREMIUM_PROVIDERS` stays (used by the
    🔑 API keys section for the global provider / default-voice
    pickers).
  - Rename "🎧 Listening settings" to "🎧 Companion listening"
    in the Section title and the file-header section list.
    Update related comments to match.
