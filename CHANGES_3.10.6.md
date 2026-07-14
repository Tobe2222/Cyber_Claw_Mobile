# v3.10.6 — Voice mode section + cleanup of the active-wake panel

Tobe tested v3.10.5 and reported (channel `#cyber-dev`,
two screenshots of the Settings + Wake sub-page):

1. **The "Send word" and "Your-turn cue sound" sections
   live inside Companions**, but they're universal —
   one send phrase across all companions, one cue
   sound. They should move out into their own
   top-level section.

2. **The active wake panel on the per-companion Wake
   page shows the name twice.** "Hey Clawsuu" appears
   big in white AND small in green. The two are the
   same string because when Tobe renamed the wake set,
   the `setId` became "Hey Clawsuu" too — so the panel
   is rendering `displayName`, `phrase`, and `setId`,
   all equal.

3. **The "Manage wake sets" button on the active
   wake panel is redundant** — there's already a
   "Manage wake sets for {name}" button further down
   the same page.

## Fixes

### #1 — New "🎙️ Voice mode" top-level Section

Moved:
- ✉️ **Manual send voice message** (the text input,
  Save button, Train button, trained-model badge)
- 🔔 **Your-turn cue sound** (Off / Bird / Bell /
  Ding / Chime)

…out of the 🐾 Companions Section and into a new
top-level `🎙️ Voice mode` Section that sits between
Companions and Background recording. Same orange
border as the other top-level Sections, so it reads
as a peer (not as a sub-detail of Companions).

Description: *"Voice-mode behaviour shared across every
companion. Per-companion settings (engine, voice
picker, silence timeout) live in each companion's
detail page."* — explicit signal that these settings
are NOT per-companion.

The SendPhraseTrainer modal route is unchanged.
Only the placement of the settings/shortcuts
inside the page moved.

### #2 — Active wake panel: hide setId when it duplicates the name

`activeWakeDirect` carries `displayName`, `phrase`,
`setId`, and `path`. The v3.10.5 panel rendered
`displayName || phrase` (large, white) and `setId`
(small, green, monospace). When Tobe renamed a set
to "Hey Clawsuu", all three fields collapsed to the
same string — so the panel displayed "Hey Clawsuu"
twice (once in white, once in green) for no useful
reason.

v3.10.6 only renders the setId line when it differs
from `displayName || phrase`. When it differs, it
still shows in the same green monospace below the
phrase (useful as a technical handle when debugging
which .tflite is loaded). When they're the same, the
setId line is omitted entirely.

### #3 — Removed redundant "Manage wake sets" button from the panel

The active wake panel had a "📂 Manage wake sets"
button that pushed the WakeSetManagerScreen route.
But the Wake sub-page already has a "📂 Manage wake
sets for {companion}" button further down — the same
screen, just at a different scroll position. v3.10.6
removes the button from the panel. The panel's job is
to show what's currently active, not to navigate.

Removed the corresponding `activeWakeManageBtn` and
`activeWakeManageBtnText` styles (no longer used).

## Files

- `src/screens/SettingsScreen.tsx` (line count grew
  from 1577 → 2361; the gain is mostly the moved
  content with added explanatory comments): created
  the new `🎙️ Voice mode` Section, removed the
  Send word + Your-turn cue blocks from the
  Companions Section, updated the Companions
  Section's trailing comment to point at the new
  location.
- `src/screens/CompanionSettingsScreen.tsx`
  (≈+25 / -12): hide setId when it equals the
  display name; remove the redundant Manage button
  from the active wake panel; drop the unused
  activeWakeManageBtn* styles; update the panel's
  block comment.
- `package.json` — 3.10.5 → 3.10.6
- `android/app/build.gradle` — versionName
  3.10.5 → 3.10.6, versionCode 232 → 233

## General lessons

**1. Visual grouping implies semantic grouping.**
A sub-header inside a Section reads as "child of
this Section". When the sub-header is for a thing
that's actually universal (not per-companion),
moving it up to its own Section makes the
universality explicit. Tobe's complaint was
implicit: "this stuff is under Companions, so it
must be per-companion". He had to spend mental
cycles figuring out the actual scope. The Section
border is the right primitive to fix this — the
visual scope now matches the semantic scope.

**2. When the same string appears twice in a
panel, one of them is wrong.** The panel was
showing `displayName`, `phrase`, and `setId`. The
designer (me, v3.10.5) didn't predict that a
`rename` operation could collapse all three to the
same value. Fix: when the fields happen to be
equal, hide the redundant one rather than render
both and hope nobody notices. The principle: a
panel's information density should match its
entropy — if two values are perfectly correlated,
you don't need to show both.

**3. Two buttons to the same screen = UI noise.**
"Manage wake sets" appeared on the active-wake
panel AND further down the page. Both navigate
to the same screen. Remove one. Don't make the
user wonder which one to tap.

**4. Renames propagate to setId.** When the user
renames a wake set in the manager, the trainer
folder AND the meta `setId` get renamed
(`renameWakeSet` at WakeWordModule.kt:1787 — only
touches setId for the folder, then `writeMeta(
newDir, meta.copy(setId = newSetId))` updates the
JSON). So a renamed set can have a human-looking
setId ("Hey Clawsuu") instead of the default
`<safePhrase>-<timestamp>`. The UI must handle
both shapes gracefully — which is exactly the
deduplication fix above.

**5. sed -i 'Nd,Md' + edit is a workable
multi-edit pattern.** Used here to delete 115
lines (the entire Send word + cue sound block
from inside the Companions Section) and then
insert the new Voice mode Section in its place.
Two passes (delete, then insert-after-the-prev-
edit's-unique-anchor) is more reliable than one
giant edit with a long oldText that may have
invisible whitespace mismatches. Pattern worth
remembering for larger surgical refactors in
files where you can't easily `apply_patch`.