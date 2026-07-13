# v3.10.0 — Trainer + manager pushed as routes (not inline-expand); defensive wake-picker

Tobe (in #cyber-dev, ~21:40 with screenshot after v3.9.9):
"It still says in the text there that no wake is trained
yet, hardcoded text. It should not say that if its not
true. [...] But. Both manage and train buttons should
really open new pages rather than expanding down the
current. This should be the case for exit also."

Two things in this release:

## 1. Trainer / manager / exit-trainer as full-screen routes

Previously:
- Tapping "Train new wake phrase" / "Manage wake sets" /
  "Train new exit phrase" toggled inline conditional
  renders INSIDE the same ScrollView as the wake settings
  page. Result: trainer UI and manager UI scrolled into
  the same surface as the wake / exit settings, with
  their own "← Back" buttons that did different things
  depending on which sub-state was active.
- Tobe: "Manage and Train buttons should really open new
  pages rather than expanding down the current. This
  should be the case for exit also."

Now:
- The three trainer / manager screens are first-class
  routes in App.tsx alongside 'home' / 'settings' /
  'voice-mode' / 'companion' / 'quests'.
- CompanionSettingsScreen receives three new props:
  `onPushWakeTrainer`, `onPushWakeManager`,
  `onPushExitTrainer`. Each takes a context object
  (companionId, companionName, optional presetPhrase)
  and the App.tsx route renders the appropriate screen
  with that context.
- Back button on each trainer / manager screen pops
  back to the companion settings page (same
  CompanionSettingsScreen instance, so state is
  preserved — the active companion doesn't change,
  trained data isn't lost).

Implementation: App.tsx screen state machine extended
with `'wake-trainer'` / `'wake-manager'` /
`'exit-trainer'` values. Each has an associated context
state (e.g. `wakeTrainerCtx`) that holds the
companionId + name + presetPhrase. The push callback
sets both. The pop callback (called by trainer
onComplete / onCancel, manager onBack) clears the
context and sets `screen='companion'`.

The inline render blocks in CompanionSettingsScreen
were deleted along with the now-unused state
(`showOwwTrainer`, `showWakeSetManager`,
`showExitPhraseTrainer`, `trainingCompanionId`,
`editingWakePhrase`, `editingExitPhrase`,
`trainingCompanionName`). The back-button handler no
longer toggles those flags.

## 2. "No trained wake phrases yet" hardcoded text fixed

Tobe: "It still says in the text there that no wake is
trained yet, hardcoded text. It should not say that if
its not true."

The WakePhrasePicker in CompanionSettingsScreen had a
hardcoded hint "No trained wake phrases yet. Tap..."
that rendered whenever the parent's `savedWakeModels`
state was empty. Tobe's case: `savedWakeModels` was
empty (parent's useEffect on `[availableCompanions.length,
activeWakeCompanionId]` hadn't refetched yet, OR the
active-only filter in v3.9.9 missed an edge case),
but the Wake Manager (separate code path) clearly
showed an active set. The hardcoded hint was a false
claim.

Two-part fix:

a) **Removed the false claim.** Replaced "No trained
   wake phrases yet..." with a neutral hint: "Tap the
   buttons below to train a new wake phrase or open the
   manager." Doesn't lie if there is a trained set
   somewhere we can't see.

b) **Defensive re-fetch in the picker.** The picker
   now ALSO calls `getSavedWakeModels` on mount and
   whenever `savedModels` size changes. Merges the
   result with the parent's state (parent wins on
   conflict — parent has the freshest data). If the
   parent's state is stale or incomplete for any
   reason, the picker's local fetch catches it.

This is belt-and-suspenders: the parent's useEffect
should be sufficient, but if it misses a render
cycle (e.g. async hydration race), the picker no
longer renders a false "no trained" claim.

## Files touched

- `App.tsx` (screen state machine + new route handlers)
- `src/screens/CompanionSettingsScreen.tsx` (removed
  inline expand state + render blocks, added push
  callback props, defensive picker fetch)
- `package.json` (3.9.9 → 3.10.0)

## Verification

`npx tsc --noEmit` ✅ (only pre-existing
HomeScreen.tsx:2666 error, unrelated).
`./gradlew :app:compileDebugKotlin --offline` ✅ (no
native changes in this release).

## Test plan after install

1. Open Clawsuu → Wake settings. The two buttons
   ("Train new wake phrase" / "Manage wake sets") now
   push full-screen routes when tapped. Back arrow
   returns to the wake settings page (NOT inline-expand
   below it).
2. Same for the Exit page — "Train new exit phrase"
   pushes a full-screen trainer.
3. If a wake set IS trained: the picker shows the row
   (defensive fetch + parent state both work). If not:
   shows the neutral hint "Tap the buttons below..."
   instead of the false "No trained" claim.

## Follow-ups not in this release

- v3.9.7 noted: `audioPlayerFinished` listener leak
  (subscribed but never cleaned up) is still
  unfixed. Idempotency guard masks the symptom.
- v3.9.8 noted: a "Clean up old sets" button in the
  Wake Manager for users with pre-v3.9.8 orphans is
  now redundant (the v3.9.9 dedupe handles it). Can
  be removed if it exists; otherwise not needed.

## Companion release

Nothing desktop-side. This is a UX-only refactor.
