# 3.1.75 — Settings: voice engine toggle + orange section borders

## What it does

Two small cleanups to the Settings screen:

1. **Voice & Speech: single engine toggle.** Replaces the
   "always-show-both" layout (Local voice sub-section followed by
   Premium voice API sub-section) with a single "Engine" pill
   selector at the top of the section. When Local is selected,
   the local settings appear below; when Premium API is
   selected, the API settings appear instead. The Premium API
   block is no longer always-visible noise — only when it's
   actually relevant.

2. **Orange borders on every settings section.** The five
   top-level settings categories (Connection, Permissions,
   Wake Word, Voice & Speech, Agent Reach) had a `#222` grey
   border that was almost invisible against the `#111`
   background. Switched to the brand orange `#f7931a` (same
   orange as the active option pills and the test buttons) so
   each section reads as its own card.

## State migration

The old `voiceLocalEnabled` boolean (saved as
`cyberclaw-voice-local`) is replaced by a `voiceEngine` enum
('local' | 'api', saved as `cyberclaw-voice-engine`). The
two settings mean the same thing — local enabled ⇔ engine is
'local' — but the enum is what the new toggle UI needs.

On first load, if `cyberclaw-voice-engine` isn't set yet, the
old `cyberclaw-voice-local` key is used as a migration fallback:
- `'true'` (or missing) → `voiceEngine = 'local'` (default)
- `'false'` → `voiceEngine = 'api'`

Once the user picks an engine via the new toggle, only
`cyberclaw-voice-engine` is written. The old `cyberclaw-voice-local`
key is read once for migration and then ignored.

## Files

- `src/screens/SettingsScreen.tsx`
  - Voice & Speech section: replaced with engine pill toggle +
    conditional sub-section (local vs API)
  - State: removed `voiceLocalEnabled`, added `voiceEngine`
  - Persistence: added `cyberclaw-voice-engine`, kept
    `cyberclaw-voice-local` as read-only migration fallback
  - Styles: `section.borderColor` `#222` → `#f7931a`

`versionCode` 124 → 125, `package.json` 3.1.74 → 3.1.75.

## Out of scope

- The Premium voice API isn't actually wired up yet (still
  "coming soon" — the desktop bridge for synthesis hasn't
  landed). This release only reorganises the UI; it doesn't
  change which TTS engine is invoked at runtime.
- The other section types (toggle rows, option pills, test
  buttons) keep their existing borders; only the top-level
  `section` style changed.