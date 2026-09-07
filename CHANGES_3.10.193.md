# v3.10.193 — Mobile editor: Soul + Memory now Behaviour-only

Tobe (2026-09-07 12:45, Discord #cyber-dev, screenshot):
"i see you have put the soul and memory md in the models and
looks also, this only needs to be under behaviour."

## The bug

The CompanionEditScreen renders the same screen for three
modes (Looks / Behaviour / Models). The Soul + Memory
sections sat OUTSIDE the `mode === ...` gates under a
`{/* === BOTH MODES === */}` comment, so they appeared on
all three pages. Looking at the v3.10.192 Models editor
screenshot, Soul + Memory were below the Models panel —
wrong placement.

## The fix

Wrap Soul + Memory in `{mode === 'behaviour' ? (...) : null}`
so they only render in Behaviour mode.

Behaviour mode now shows:
- 💬 Chattiness
- 🎭 Personality Traits
- 📜 Soul (read-only)
- 🧠 Memory (read-only)

Looks mode shows:
- 📛 Name
- 🐾 Sprite
- 📐 Size

Models mode shows:
- 🌐 Provider + 🔑 API key + 🧠 Model + 💻 Local runtime

No cross-mode leakage. Matches the desktop forge's
structure (Soul + Memory sit under Behaviour in the
desktop's Companion Forge modal too).

## Files changed

- `src/screens/CompanionEditScreen.tsx` — Soul +
  Memory blocks wrapped in `mode === 'behaviour'`.
- `package.json` (3.10.192 → 3.10.193),
  `android/app/build.gradle` `versionName` + `versionCode`
  (399 → 400).

## Verification

- TypeScript: `tsc --noEmit` introduces zero new errors.
- Manual mental test:
  1. Settings → Companion → Looks card → Edit ›
     shows Name + Sprite + Size. NO Soul, NO Memory. ✓
  2. Behaviour card → Edit › shows Chattiness +
     Traits + Soul + Memory. ✓
  3. Models card → Edit › shows Provider + API
     key + Model + Local runtime. NO Soul, NO Memory.
     ✓

## UX lesson

- **Mode-aware content has to live INSIDE the mode gate,
  not beside it.** The v3.10.103 comment said "BOTH
  MODES" — that's a label that lied to every future
  contributor. The Soul + Memory sections were
  intentionally mode-agnostic in 2026-04 (when v3.10.103
  was written, there was only one mode). When the
  mode split landed in v3.10.186, the comment became
  wrong but the JSX kept rendering the sections
  unconditionally. Renaming the comment from "BOTH
  MODES" to "BEHAVIOUR ONLY" + gating the JSX catches
  the drift for the next reader.
