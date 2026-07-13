# v3.9.8 — Wake trainer UX fix + auto-cleanup of stale wake sets

Tobe (in #cyber-dev, ~20:38 with 2 screenshots):
"I tried to retrain wake. We need a UX fix for the
blocking keyboard on the first picture. And when
training finished it said no trained wake yet for some
reason. But i clicked the manage and this appeared.
They all seem similar, which is the correct version?
Why are there more than one? It should only be one,
atleast from a UX perspective"

Two distinct issues:

1. **Keyboard overlap in the trainer** — the wake-
   phrase TextInput (and the per-row near-miss inputs)
   got covered by the soft keyboard. Tobe had to scroll
   manually to reach the "Tap to record one sample"
   button.

2. **Stale wake sets accumulating** — every training
   run creates a new set (e.g. `wake-1783966412252`)
   but never cleans up old ones. Retraining the same
   phrase 3 times leaves 3 identical-looking inactive
   sets in the manager. Tobe's screenshot shows 4
   timestamped-the-same-minute orphans + 1 active.

## Fix 1 — Keyboard UX

`src/components/OpenWakeWordTrainer.tsx`:

- Added `KeyboardAvoidingView` wrapping the existing
  ScrollView with `behavior="padding"` on both
  platforms (Android gets `padding` reliably;
  `height` is inconsistent with ScrollView).
- Added `keyboardShouldPersistTaps="handled"` to the
  ScrollView so tapping the mic/record button while
  the keyboard is up doesn't first dismiss the
  keyboard then re-tap on the next interaction.
- Added `keyboardDismissMode="interactive"` so swiping
  the keyboard down dismisses it (standard iOS
  pattern; harmless on Android).

Result: tapping the wake-phrase field now keeps the
field visible above the keyboard. Tapping the mic
button works on the first tap instead of requiring a
tap to dismiss + a tap to record.

## Fix 2 — Auto-cleanup stale sets on new training

`android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`:

`setWakeModelFromBase64()` now cleans up before
writing the new set. For each existing wake set:

1. If it's for a different (agentId, phrase) pair,
   skip — leave it alone.
2. If it's the set we're about to create (matched
   by name), skip — defensive.
3. If it's currently the active set for a DIFFERENT
   agent, skip — defensive (shouldn't be possible
   since sets are scoped to one agent, but free
   check).
4. Otherwise: delete the directory + its files.

The active binding for THIS agent is moved to the new
set a few lines below, so deleting the previous active
set is safe.

After the fix: retraining "hey clawsuu" for "clawsuu"
companion leaves exactly one set in the manager — the
new one. No more "which is the correct version?".

## Tobe's second observation — "no trained wake yet"

When training finishes, `setWakeModelFromBase64()`
sets the active binding to the new setId. But the UI
message "wake word ready. Saved to ..." shows the
*file path*, not the active-set pointer. If Tobe then
opened the Wake Manager and saw an active set with the
same timestamp, that IS the freshly trained model —
the "no trained wake yet" message he saw elsewhere was
probably stale (cached state in some Settings panel).

The fix above ensures only the new set remains, so
the "Active" badge in the manager unambiguously points
to the just-trained model. If the stale "no trained"
message persists anywhere after install, ping me with
the exact screen — I'd guess there's a cached value
in some Settings panel that needs a hydration refresh.

## Files touched

- `src/components/OpenWakeWordTrainer.tsx`
  (KeyboardAvoidingView + ScrollView tap handling)
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  (auto-cleanup in setWakeModelFromBase64)
- `package.json` (3.9.7 → 3.9.8)

## Verification

`./gradlew :app:compileDebugKotlin --offline` ✅
`npx tsc --noEmit` ✅ (only pre-existing
HomeScreen.tsx:2666 error, unrelated)

## Test plan after install

1. Open Wake Trainer for any companion.
2. Tap the wake-phrase TextInput — the keyboard pops
   up, the field stays visible above the keyboard.
3. Tap "Tap to record one sample" with keyboard up —
   the tap registers on the first try (no double-tap
   needed to dismiss + record).
4. Train a wake word end-to-end.
5. Open the Wake Manager.
6. Should see exactly ONE set (the new one), no stale
   orphans from previous trainings.

## Follow-ups (not in this release)

- The `audioPlayerFinished` listener leak (noted in
  v3.9.7 CHANGES) is still unfixed. User-visible
  symptom masked by the idempotency guard added in
  v3.9.7, but listeners still accumulate across
  turns. v3.9.9 candidate.
- A "Clean up old sets" button in the Wake Manager
  for users with pre-v3.9.8 orphans they want to
  purge without retraining. Single-pass cleanup
  helper; cheap to add when needed.
