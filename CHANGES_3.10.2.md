# v3.10.2 — Settings list cleanup + your-turn cue key bug fix

Tobe tested v3.10.1 and reported:

1. **"no wake yet" still in Settings** — for both
   Clawsuu and Lamasuu, even though the Wake Manager
   showed "Hey Clawsuu" as the active set.

2. **Settings UI redesign** — per-companion list
   should NOT show wake status. The status belongs in
   the per-companion detail page. The page should also
   show exit status (currently only wake status was
   shown anywhere).

3. **No your-turn sound** — after waking + entering
   voice mode, no cue sound plays even though Tobe had
   a sound selected.

## Root causes

### #1 — "no wake yet" in Settings

The Settings list row used to display
`wake: "<phrase>"` or `no wake word yet` based on the
`savedWakeModels` map. Tobe saw `no wake word yet`
for Clawsuu even though the Wake Manager showed the
trained set as active.

The root cause: Tobe actually intended the row NOT
to show this text at all (see #2). The user's
direction is to move per-companion status into the
detail page, not to fix the `savedWakeModels`
hydration. So the fix in v3.10.2 is to remove the
text from the Settings list entirely (the
hydration/refresh fix from v3.10.1 remains in place
because the per-companion detail page now reads the
same state and benefits from the AppState 'active'
refetch).

### #2 — Settings UI redesign

Two parts:

- **Removed the per-row wake status line**. The
  Settings companion list now shows only emoji + name
  (and the active-wake dot when this companion is the
  active wake). Per-companion status is in the
  detail page.
- **Added wake + exit status lines to the
  per-companion overview cards** (Wake settings /
  Exit settings on the phase=null page). Wake shows
  `Trained: "<phrase>"` when the active model has a
  phrase, otherwise a "Not trained" hint. Exit shows
  `Trained: "<phrase>"` when there's a trained
  neural exit, or `Default: "<phrase>"` when only
  the v3.7.1 `voiceExitPhrase` default is in use.

The wake + exit status lines are computed at the
screen level (not inside `renderCompanionOverview`)
because the dispatch calls different render-functions
on different renders, and putting `useState` /
`useEffect` inside a non-always-called render
function would break React's same-hook-order rule
(same v3.7.1 bug class that bit the voice picker
state). Lifted state is shared cleanly with the per-
page render functions when the user drills in.

### #3 — No your-turn cue sound

Tobe selected a cue sound in Settings → it never
played.

**Root cause: key mismatch.** `WakeModeScreen` read
the cue setting via the constant

```js
export const TURN_CUE_KEY = 'cyberc…-turn-cue';
```

(NOTE the `…` is a Unicode ellipsis, not three
periods. The intent was probably `cyberclaw-` but
someone typed `cyberc…` as a paste / shorthand
error and it shipped unnoticed.) Meanwhile
`SettingsScreen` wrote and read the cue to/from
`cyberclaw-voice-turn-cue`.

So:

- User sets cue to "bird" in Settings →
  `cyberclaw-voice-turn-cue = "bird"`
- WakeModeScreen reads `cyberc…-turn-cue` →
  `null` → defaults to `'off'` → no cue plays

The two keys never matched. The cue was always
disabled in practice, even when the user thought
they'd enabled it.

**The fix:**

- `TURN_CUE_KEY` is now `'cyberclaw-voice-turn-cue'`
  (matches SettingsScreen exactly).
- `LEGACY_TURN_CUE_KEY` keeps the old typo'd key as
  a fallback for any user who happened to write to
  it directly (mostly a no-op safety net; in
  practice no one ever set it because nothing
  wrote to it).
- A `migrateLegacyTurnCueKey()` one-shot runs on
  every app start (App.tsx initial effect). If the
  user has a value at the legacy key AND nothing at
  the canonical key, it copies the value over and
  clears the legacy key. Idempotent: safe to run
  forever.

The cue now plays after each assistant response in
the multi-turn voice loop, "BEFORE starting the
recording turn" (per the original v3.9.8 spec).

## General lesson: the "two AsyncStorage keys" anti-pattern

The bug was preventable by exporting a single
canonical key constant and using it from BOTH places
(SettingsScreen and WakeModeScreen). The current
codebase has analogous pairs elsewhere (e.g.
`cyberclaw-bg-listening`, `cyberclaw-active-wake-
companion`, etc.) — most of these are written/read
from one place, but the turn-cue was written/read
from two. Whenever a key has multiple producers or
consumers, the constant MUST be shared.

Audit checklist for "shared AsyncStorage key" bugs:
- `grep -rn "<key>" src/` should return exactly one
  definition (the constant) and N usages, all
  reading the same constant.
- If grep returns multiple definitions
  (`TURN_CUE_KEY`, `LEGACY_TURN_CUE_KEY`, an inline
  literal somewhere), one of them is wrong.

## Files

- `src/services/VoiceSettings.ts` — fixed
  `TURN_CUE_KEY` typo, added `LEGACY_TURN_CUE_KEY`
  and `migrateLegacyTurnCueKey()`
- `App.tsx` — call `migrateLegacyTurnCueKey()` on
  app start
- `src/screens/CompanionSettingsScreen.tsx` — added
  wake + exit status lines to the per-companion
  overview cards (lifted state, not nested hooks)
- `src/screens/SettingsScreen.tsx` — removed the
  per-row wake status text
- `package.json` — 3.10.1 → 3.10.2
- `android/app/build.gradle` — versionName 3.10.1 →
  3.10.2, versionCode 228 → 229

## Bonus questions I still want answers to

### "no wake yet" — was the data actually missing?

The v3.10.1 hydration/refresh code paths exist and
should work for normal warm-launch flows. Tobe's
"still says no wake yet" in v3.10.1 might mean:

a) **Tobe was still on v3.10.0** — the v3.10.1 CI
   build at 05:33 GMT took ~20 min to deploy. Tobe
   installed around 07:53. v3.10.2 deploys in
   parallel; both will be available on the Play
   Store + GitHub Releases shortly.
b) **A genuine getSavedWakeModels gap** — if a
   companion's `.tflite` is gone from disk (e.g.
   cleared by user / device, but the active binding
   lingers), the response returns empty for that
   agent and Settings shows "no wake yet". The
   `useEffect` deps never changed, so no refetch.
   v3.10.1's AppState 'active' refetch only helps
   if the user navigates between screens.

In v3.10.2 both screens also refetch on every App
State 'active' transition, which catches case (b)
on the next foreground event. If Tobe still sees
this in v3.10.2, we'll need to add logging to find
out whether `getSavedWakeModels` is returning the
expected data.

In the meantime, the Settings UI redesign moves the
"no wake yet" hint out of the list rows entirely,
so this specific complaint dissolves.

### Cue play timing

The cue plays AFTER each assistant response in the
multi-turn voice loop, not at the start of voice
mode. If the user expects a cue when voice mode
opens (before the first user utterance), that's a
different fix — let me know and I'll add a "voice
mode opened" cue.
