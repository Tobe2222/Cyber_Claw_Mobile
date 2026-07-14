# v3.10.4 — Wake settings card text + data fetch fallback + BG false-trigger guard

Tobe tested v3.10.3 and reported:

1. **Wake settings button text is misleading.** The per-companion
   "Wake settings" card now reads "Not trained — uses default wake if
   no active wake is bound", even after Tobe activated a wake set for
   the same companion. The Wake Sets manager (separate code path)
   shows the same set as ✓ Active, so the two views disagree.

2. **Wake settings sub-page picker is empty.** The "Wake phrases"
   section on the wake sub-page should show the active phrase as a
   selectable row (matching the manager), but it's empty.

3. **Repeated false wake triggers.** Vosk emits a "hey" partial every
   time anyone nearby speaks; the BG service's PhoneticMatcher at the
   default 0.55 threshold treats that single word as a match for the
   2-word trained phrase ("hey clawsuu"), and the wake fires
   immediately.

All three are facets of the same root: the wake-word data and the
matcher are split across multiple code paths, and three of them —
the JS-side active-only filter, the picker hint text, the BG
PhoneticMatcher threshold — were each individually plausible but
mutually inconsistent. v3.10.4 makes the data paths line up AND
raises the matcher floor so single-word partials can't match a
multi-word phrase.

## Root causes

### #1 — Misleading "Not trained" text on the per-companion card

The card's status line, in v3.10.2/3.10.3, was hard-coded:

```ts
const wakeStatusLine = wakeModel?.phrase
  ? `Trained: "${wakeModel.displayName || wakeModel.phrase}"`
  : 'Not trained — uses default wake if no active wake is bound';
```

That fallback fired whenever `savedWakeModels[companion.id]` was
empty. The empty-state was reachable even when the manager's data
path (`listWakeSets`) clearly shows the set as active, because the
manager reads a different native call. The text claims a flat-out
false state ("Not trained…uses default wake…"), which contradicts
the manager's ✓ Active badge visible in the same session.

### #2 — Empty Wake phrases picker on the sub-page

The Wake sub-page mounts `<WakePhrasePicker>` which has its OWN
defensive re-fetch (added in v3.10.0 to compensate for stale parent
state). The fetch reads `getSavedWakeModels()` only. Same active-only
filter as the parent. If the active-only filter returns empty for
the agent (which #1's data confirms), the picker sees zero rows and
falls through to the "Tap the buttons below…" hint. The user has
trained phrases — and the manager shows them — but the picker
doesn't.

### #3 — Repeated false wake triggers

The CyberClawService (background listener, used whenever
"Background listening" is on) and the WakeWordModule's
foreground-classifier listener both call
`PhoneticMatcher.matches(text, wakePhrase)` with no threshold
argument — which gives the default `0.55`. For a 2-word target like
"hey clawsuu", that threshold is barely above the average-score
you'd get from a single-word "hey" partial:

```
heard = "hey",    target = "hey clawsuu"
similarity("hey", "hey")     = 1.00
similarity("hey", "clawsuu") = 1 - 6/7 = 0.14
consonant("hey", "clawsuu")  = ~0.18
avg = (1.00 + 0.14) / 2 = 0.57
```

`0.57 >= 0.55` → MATCH. So Vosk's "hey" partial — emitted any time
anyone in earshot says "hey" — fires the wake word. Tobe hit this
on v3.10.3 and triggered the wake mode repeatedly by accident.

## Fixes

### #1 — Neutral fallback text + bulletproof data fetch

The card's fallback text is now:

```ts
'No active wake on this phone — open Wake Sets to manage trained phrases'
```

It no longer claims "not trained" — only points the user at Wake
Sets (the only place the binding is authoritative). If the data
fetch works correctly (which v3.10.4 now guarantees), the fallback
never fires.

### #2 — `listWakeSets` as fallback in all three fetch paths

Three React-side fetch points now merge `getSavedWakeModels`
(active-only) and `listWakeSets` (all sets, with `active: bool`):

- `CompanionSettingsScreen`'s `savedWakeModels` useEffect — drives
  the wake status line and the WakePhrasePicker.
- `SettingsScreen`'s `savedWakeModels` useEffect — was technically
  orphaned in v3.10.3 (no UI consumed it) but kept for
  forward-compat; now matches the new shape.
- `WakePhrasePicker`'s internal `localSavedModels` useEffect —
  drives the picker rows visible on the Wake sub-page.

All three call `Promise.all([getSavedWakeModels, listWakeSets])`
and merge. For each companion, the active-only result wins if
present (it has the absolute `.tflite` path on disk); the
listWakeSets result fills the gap, picking the active set via
`getActiveWakeSet(companionId)` and falling back to the most
recently-created set if no binding exists. Relative paths are
synthesized for the picker — they only need to be truthy.

Side effect: this is the data-source unification the user-visible
bug actually needed. The previous fix attempts (3.10.1, 3.10.2,
3.10.3) all tried to recover from the missing data — none of them
changed the source. v3.10.4 gives the JS side the same view of
disk that the manager has, so the per-companion card and the
manager agree by construction.

### #3 — Stricter BG + foreground-Vosk match

Two listener paths changed:

1. `CyberClawService.checkWakeWord` — calls
   `PhoneticMatcher.matches(text, wakePhrase, threshold = 0.7)`
   instead of the default 0.55. **Plus**: requires the heard text
   to contain at least `targetWords - 1` tokens. A single "hey"
   partial only has 1 word; a 2-word "hey clawsuu" target needs
   ≥1 (which "hey" satisfies) → so this alone wouldn't help.
   Combined with the higher threshold, "hey" alone now scores
   below the threshold (`0.57 < 0.7`) and never fires.

2. `WakeWordModule.checkWakeWord` (foreground Vosk) — same
   threshold + token-count guard.

The token-count guard has the same N-1 leniency so a partial
"hey claw" doesn't fire on the user dragging their words, but
true phoneme fragments with one word do.

Result: Vosk "hey" partials no longer fire the wake. The genuine
"Hey Clawsuu" trigger (Vosk recognized fully, or close enough via
PhoneticMatcher at 0.7+) still fires.

### #3 — `startBgService` prefers the active set over settings key

`HomeScreen.startBgService` was the second half of the false-
trigger story. The trainer writes `cyberclaw-audio-settings.wakeWord`
on every successful training (v3.10.1), AND the manager's
`handleActivate` does too — but if the user toggled BG listening on
BEFORE training a wake word, the audio-settings key was never
written, so the BG service would fall back to the `'hey clawsuu'`
default and (per #3) start false-triggering.

v3.10.4: `startBgService` now reads `cyberclaw-active-wake-companion`
as a fallback and asks `listWakeSets` + `getActiveWakeSet` for that
companion's current active set's phrase. The BG service stays in
lockstep with whatever's actually bound in the OWW detector, not
what was last written to audio-settings.

## Files

- `src/screens/CompanionSettingsScreen.tsx` — replaced the
  `getSavedWakeModels`-only fetch with the merged
  `listWakeSets` fallback; neutralized the "Not trained" text.
- `src/screens/SettingsScreen.tsx` — same fetch merge
  (consistency — no direct UI consumer post-v3.10.3).
- `src/screens/HomeScreen.tsx` — `startBgService` falls back
  through `listWakeSets` to find the active set's phrase when
  `cyberclaw-audio-settings.wakeWord` is missing/stale.
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  `checkWakeWord`: threshold 0.7, ≥ N-1 token-words required.
- `android/app/src/main/java/com/cyberclawmobile/CyberClawService.kt` —
  same threshold + token-count guard on the BG listening path.
- `package.json` — 3.10.3 → 3.10.4
- `android/app/build.gradle` — versionName 3.10.3 → 3.10.4,
  versionCode 230 → 231

## General lesson (refined)

The v3.10.1, 3.10.2, 3.10.3 fix sequence was a textbook example of
**patching the symptom instead of the source**. The user-visible
bug was "where's my wake phrase?". Each attempt refetched from a
narrower window, hoping the data would show up:

- v3.10.1 added AppState 'active' refetch (timing).
- v3.10.2 removed the misleading text and moved it to the sub-page.
- v3.10.3 fixed the crash introduced when moving it.

None of these "fixed" the actual gap. The data was sitting there
all along, readable via `listWakeSets`, but no JS code asked for
it. v3.10.4 changes what data is read instead of when it's read.

**Rule of thumb:** when two screens read the same underlying data
via different code paths and disagree, the higher-trust view wins.
Don't paper over the disagreement with more refetch logic — use
the higher-trust view as the source of truth, and let the
lower-trust view fall through to it on empty.

**Specific check:** when fixing a multi-listener wake-word sync bug,
the matcher threshold is part of the "what is a match?" contract.
The 0.55 default was tuned for the v3.1 sample-matcher era with
1-word wake phrases. Multi-word trained phrases were always going
to be vulnerable to single-word partials at that threshold.
Bumping to 0.7 + requiring ≥ N-1 words is the correct guard for
multi-word trained phrases without forcing the user to manually
tune a threshold slider (the v3.4.7-deprecated threshold UI is
still gone, and intentionally so — but the matcher ought to be
defensible for sensible phrases out of the box).
