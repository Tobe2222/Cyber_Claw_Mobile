# v3.4.7 — Listening settings & Companions as separate Sections + drop Match Thresholds

## What changed

Tobe's v3.4.6 feedback:

1. **Listening settings and Companions should be TWO separate Sections**,
   each with its own orange border. The v3.4.5 in-Section divider
   (GroupTitle + GroupDivider) was still too subtle — it read as
   "these are sub-parts of one thing" when they're actually two
   distinct concepts.

2. **Are we still using Match Thresholds with the new trained wake?**
   No — the v3.1 sample-matching detector was replaced by the
   v3.1.95 openWakeWord TFLite ML detector (~95% accurate out of
   the box). The threshold UI was redundant clutter.

## Architecture

### SettingsScreen — two Sections

The single "🎤 Voice mode" Section was split into:
- **🎧 Listening settings** (orange border, own Section)
  - Background listening master toggle
  - Audio buffer (lookback, conversation timeout, retention)
  - Silence to end turn
- **🐾 Companions** (orange border, own Section)
  - Hint
  - Companion list rows (tap → App.tsx route 'companion' → CompanionSettingsScreen)

Removed: `GroupTitle` helper, `GroupDivider` helper, `groupTitle`
and `groupDivider` styles. They were only used inside the merged
Voice mode Section; with two separate Sections, no in-section
divider is needed.

### SettingsScreen — Match Thresholds removed

Removed:
- `fgThreshold` / `bgThreshold` state declarations
- The hydration useEffect for those keys
- The "Match thresholds" Label + Hint
- "Foreground: X%" / "Background: Y%" sliders + their cell handlers
- `thresholdRow` / `thresholdEdge` / `thresholdCell` / etc. styles
  (kept for now as dead styles; will be removed in next cleanup pass)

Kept:
- The AsyncStorage keys `cyberclaw-wake-fg-threshold` and
  `cyberclaw-wake-bg-threshold` are still read by HomeScreen
  and WakeModeScreen (the wake detector respects them). Existing
  users who tuned the threshold keep their tuning.
- Defaults: 0.55 (foreground) / 0.65 (background).

## Why drop the threshold UI?

The threshold was a knob for the v3.1 DTW-based sample-matching
detector, which compared live audio against recorded audio
fingerprints. That detector had high false-positive rates and
needed per-context tuning.

The v3.1.95 openWakeWord TFLite ML detector runs a proper neural
wake-word model with much higher accuracy out of the box. The
threshold is still respected by the detector (passed to
`initOww(wakeword, threshold)`) but rarely needs user tuning.

## Files

- Edited: `src/screens/SettingsScreen.tsx`
  - Split Voice mode into two Section blocks
  - Removed fgThreshold/bgThreshold state + UI + hydration
  - Removed GroupTitle/GroupDivider helpers + styles
  - Updated top-of-file docstring
- Edited: `package.json` (3.4.6 → 3.4.7)
- Edited: `android/app/build.gradle` (versionCode 184 → 185, versionName 3.4.6 → 3.4.7)