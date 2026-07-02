# v3.4.5 — Group Voice mode controls + breathing room

## What changed

Tobe's v3.4.4 feedback on the new screens:

1. **Companion overview page had no top padding** — the orange section sat
   flush against the system status bar (cramped look).
2. **Voice mode controls need to be grouped** — "Background listening"
   toggle + audio buffer + silence timeout + match thresholds should be
   visually grouped as "🎧 Listening settings".
3. **Companions section needs bigger visual separation** — a thicker
   divider before the per-companion list so the user can tell at a
   glance that those are two different concepts.

## Architecture

### SettingsScreen — group titles + divider

- New `GroupTitle` helper component (renders `<Text style={groupTitle}>`).
  Bigger and bolder than `SubTitle` (16px bold vs 13px semibold).
- New `GroupDivider` helper component (renders `<View style={groupDivider}>`).
  Subtle 1px line + 20px vertical margin.
- Voice mode Section structure:
  ```
  🎤 Voice mode [section]
    🎧 Listening settings [GroupTitle — new]
      🎧 Background listening toggle
      Hint
      Audio buffer
      Lookback / Conversation timeout / Recording retention
      [Save audio settings]
      Silence to end turn
      Match thresholds
      Foreground / Background
    ──── divider ────
    🐾 Companions [GroupTitle — was SubTitle]
      Hint
      [companion list rows]
  ```
- The redundant `🎧 Background listening — details` SubTitle was removed
  (now redundant given the GroupTitle above).

### CompanionSettingsScreen — top padding

- ScrollView `contentContainerStyle.scroll` bumped from
  `padding: 16` to `padding: 16, paddingTop: 50 (Android) / 10 (iOS)`.
  This clears the system status bar on Android (status bar is ~30dp on
  most devices; was 16px before which clipped under it).

## Files

- Edited: `src/screens/SettingsScreen.tsx` (added GroupTitle/GroupDivider,
  restructured Voice mode Section)
- Edited: `src/screens/CompanionSettingsScreen.tsx` (bumped scroll paddingTop)
- Edited: `package.json` (3.4.4 → 3.4.5)
- Edited: `android/app/build.gradle` (versionCode 182 → 183, versionName 3.4.4 → 3.4.5)