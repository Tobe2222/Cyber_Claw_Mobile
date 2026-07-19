# v3.10.56 — Remove redundant setId from active-wake panel

Tobe (post v3.10.55):

> "the set is displayed extra underneath there, it
> does not need to since it is in the training set
> manager"

The active-wake panel on the Wake sub-page showed the
set's setId (`hey-clawsuu-1784421358373`) as a small
green line under the displayName ("Hey Clawsuu"). The
Wake Sets manager (separate screen) shows the setId
as the primary identifier for each set, so the same
identifier was being shown twice. Redundant.

## Fix

`src/screens/CompanionSettingsScreen.tsx` —
removed the setId `<Text>` element from the
active-wake panel entirely (v3.10.6 had it
conditionally hidden when it equalled the
displayName/phrase, but Tobe's setId is a
timestamped slug that never equals the displayName,
so the conditional never fired in practice).

The panel now shows only:
- Display name (big, white)
- .tflite path (small, grey, monospace, single-line)

The displayName is what the user recognises. The
.tflite path is useful for debugging ("does this
file exist on disk?"). The setId is a programmatic
identifier — not useful on this panel because the
manager already shows it.

## Files changed

- `src/screens/CompanionSettingsScreen.tsx` —
  removed setId `<Text>` and its conditional wrapper.
- `android/app/build.gradle` — versionCode 282→283,
  versionName 3.10.55→3.10.56.
- `package.json` — version 3.10.55→3.10.56.

## Lesson

When a piece of information has multiple "homes" in
the UI, pick the primary one and let it be the
source of truth. Don't show the same identifier
twice. The Wake Sets manager is the canonical home
for the setId — every other screen should reference
sets by displayName + path (or displayName + phrase
if the path is implicit).

v3.10.6's "hide when equal to displayName" was a
narrow fix that worked for the rename case
(Tobe renamed a set to "Hey Clawsuu", so all three
identifiers converged) but not for the timestamped-
slug case (the common case, since setIds are always
generated as `<slug>-<timestamp>`). Removing the
line entirely is the right answer for both.

## Verification on device

Open Companion settings → Wake. The active-wake
panel should show only "Hey Clawsuu" (big, white)
and the .tflite path. No setId line. The Wake Sets
manager (Manage wake sets button below) still shows
the setId as the primary identifier — that hasn't
changed.