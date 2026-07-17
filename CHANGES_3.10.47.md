# v3.10.47 — move Background listening toggle to top of Voice mode

Tobe asked: "i think we could put that setting in the top
of the voice mode section."

The "that setting" = the master Background listening toggle
that lived in its own "🎧 Wake listening" Section in
Settings. That section sat between the 🎤 Wake settings
navigation cards (above) and the 🐾 Companions section
(below).

The placement was confusing because:

1. The 🎤 Wake settings cards above it said "Wake
   listening" in their description (per-card link to the
   wake sub-page).
2. The 🎧 Wake listening section below it ALSO said
   "Wake listening" in its title — but meant the global
   mic behavior toggle.
3. Two "Wake listening" labels stacked on top of each
   other, with different meanings (navigation vs master
   toggle). Tobe's mental model is "the mic behavior is
   part of voice mode" — the global toggle belongs next
   to Smart silence and the speaker-profile bar, both of
   which live in 🎙️ Voice mode.

## Fix

Removed the standalone "🎧 Wake listening" Section from
its current location. Moved the Background listening
Toggle + its Hint to the TOP of the "🎙️ Voice mode"
Section, above the VoiceEnrollmentBar. Same control, same
AsyncStorage key, same handler logic — pure repositioning.

New top-level order in Settings:
1. 🔗 Connection
2. 🔒 Permissions
3. 🎤 Wake settings (cards — unchanged)
4. 🐾 Companions (unchanged)
5. **🎙️ Voice mode**
   - **🎧 Background listening** ← moved here
   - Hint (preserved verbatim)
   - VoiceEnrollmentBar (compact)
   - Smart silence
   - Send word
   - (everything else unchanged)
6. 🎙️ Background recording
7. (rest unchanged)

Per-companion wake/exit training still lives in 🐾
Companions via the wake/exit cards. No content lost — just
regrouped.

## Why voice mode (not wake settings)

Tobe's framing: "voice mode section". The Background
listening toggle controls the BG service which keeps the
mic active — that's mic behavior shared across all
companions in voice mode. It conceptually pairs with:

- Smart silence (also global mic behavior, also in Voice
  mode)
- VoiceEnrollmentBar (also global, cross-companion)

The 🎤 Wake settings section above is a navigation hub to
per-companion sub-pages — it doesn't host global
controls.

## What's NOT changed

- `bgListening` state, AsyncStorage key
  (`cyberclaw-bg-listening`), handler logic — all
  preserved verbatim.
- The Hint text under the toggle — preserved verbatim.
- The Toggle component itself — preserved.
- Per-companion wake/exit training (Companion settings →
  Wake / Exit / Send sub-pages).
- The voice mode bar active-only change from v3.10.46
  (WakeModeScreen still passes `mode="active-only"`).

## Files

- `src/screens/SettingsScreen.tsx` — removed the
  standalone "🎧 Wake listening" Section, added the same
  Toggle + Hint at the top of the "🎙️ Voice mode"
  Section.
- `package.json` — 3.10.46 → 3.10.47
- `android/app/build.gradle` — versionCode 273 → 274,
  versionName 3.10.47

## General lesson

**When two adjacent section titles use the same words for
different things, one of them is in the wrong place.** The
🎤 Wake settings cards (navigation) and the 🎧 Wake
listening section (master toggle) both used "Wake
listening" but meant completely different things. The fix
isn't a rename — it's a regrouping: the navigation hub
stays where it is, and the master toggle moves to the
section that semantically contains it (Voice mode, where
the other global mic controls live). This is a layout
fix, not a feature change.

Same pattern as v3.10.46's mode prop on
VoiceEnrollmentBar: the right grouping depends on what
the user is conceptually looking for, not on where the
code naturally sorted it. When two labels collide,
regroup; don't rename both.