# v3.10.24 — visible speaker-profile progress bar (full + compact)

**TL;DR:** v3.10.23 stripped all speaker UI. Tobe's follow-up:
"the progress bar was good, just put it in Voice mode settings.
Plus a small one in voice mode at the top so one can see it
moving up as one uses it." v3.10.24 adds both bars. Same
component, two sizes that read as the same indicator.

## What shipped

### New component: `src/components/VoiceEnrollmentBar.tsx`

A single shared React Native component with two variants:

- **`variant="full"`** — used in SettingsScreen at the top of
  the Voice mode section (above "Manual send voice message",
  right after the "shared across every companion" intro
  paragraph). 8px-tall bar with a label above
  ("🎙 Learning your voice — 247/1000 samples" while
  accumulating, "✓ Voice profile locked (1247 samples)"
  once locked). Locked state also shows a one-line match-
  score note.

- **`variant="compact"`** — used at the very top of
  WakeModeScreen. 3px-tall bar, no text. Translucent dark
  backdrop so it reads as a permanent indicator. pointerEvents
  set to "none" so it never eats taps for the WebView.

Both use the same color/animation language so they read as
the same thing regardless of where you see it:

- **While learning:** cyan fill (#06b6d4) with a translucent
  white shimmer that sweeps across the bar on a 1.6s loop.
- **When locked:** solid emerald fill (#10b981), no shimmer,
  thin emerald border around the track.

Progress math: max of (samples/1000, wakes/5). Either threshold
reaching first counts as 100%. The wakes path can fill the bar
much faster than samples alone (a user actively using voice
mode hits 5 confirmed wake-fires in minutes; the sample path
takes ~30s of continuous speech).

### Wiring

- **SettingsScreen.tsx** — `<VoiceEnrollmentBar variant="full" />`
  inserted at the top of the `<Section title="🎙️ Voice mode">`
  block. Imports added next to the other component imports.
- **WakeModeScreen.tsx** — `<VoiceEnrollmentBar variant="compact" />`
  pinned in a new `enrollmentBarCompact` View at `top: 0`,
  zIndex 100, padded below the iOS notch. Renders above the
  voice-status overlay (which is at `top: 60`) so the bar is
  always visible while the user is in voice mode.

### Polling

The bar polls `WakeWordModule.getSpeakerStatus()` every 2s.
Cheap native call (in-memory reads of three int counters and
one optional cosine score). 2s cadence is fast enough that the
bar visibly moves while learning, slow enough to not flood the
bridge. Cancels the interval + sets `cancelledRef` on unmount
to prevent setState-after-unmount warnings.

### Native side

Unchanged from v3.10.23. The `getSpeakerStatus()` method
already returns `{samplesTotal, bufferSize, hasEnrollment,
profileLocked, confirmedWakeFires, matchScore}` — everything
the bar needs. No Kotlin diff in v3.10.24.

## What I got wrong first time (and the fix)

v3.10.23 stripped the per-companion progress bar entirely
because Tobe said "lift it out entirely". I overcorrected:
the design intent was "lift it OUT of per-companion settings"
(single global profile), NOT "remove the visible feedback
entirely". The progress bar was always a good UX — it lets
the user see when the system has learned enough to gate
other speakers.

Tobe's clarifying sentence this morning: "i dont see the bar
anywhere. I liked the progress bar idea just as an indication.
It can be in voice mode settings. Or perhaps just at the top
in voice mode itself so one can see it moving up as one uses
it."

The right read was BOTH — full version in settings (so the
user can find + read it when looking for it), compact version
at the top of voice mode (so the user sees it move as they
talk). Plus a distinct look that lets the user intuite
they're the same bar regardless of context.

## Lesson (process)

When a user says "X should be elsewhere", the third option
is often "X should be everywhere relevant, just framed
globally". v3.10.23 took "settings per-companion → voice
mode settings" and dropped the bar entirely because the
UI in settings was per-companion (not the bar's fault).
The bar itself was correct; only its location was wrong.

For any "where does this UI live?" question, decompose:
1. What does this UI represent? (state of the global
   voice profile — single global)
2. Who needs to see it? (the user, when looking for it AND
   when using voice mode)
3. Where is the user when they need it?
   - Looking for it → SettingsScreen → Voice mode section
   - Using voice mode → WakeModeScreen → top of the canvas

Both placements are correct. The component is the same.

## Build artifacts

- `package.json`: 3.10.24
- `android/app/build.gradle`: versionCode 251, versionName 3.10.24
- New file: `src/components/VoiceEnrollmentBar.tsx` (1 file,
  ~250 lines including comments)
- Modified: `src/screens/SettingsScreen.tsx` (2 lines +
  import)
- Modified: `src/screens/WakeModeScreen.tsx` (style + JSX +
  import)
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors remain —
  unrelated to this release per the AGENTS.md "pre-existing TS
  errors" rule.

## What's still NOT in v3.10.24

- **Exit + send speaker-gating** — still v3.10.25.
- **EMA drift** — still v3.10.25 (paired with exit/send
  gating for that release).
- **Transcription personalization** — v3.11+.
- **Manual "forget my voice" button** — not in scope per
  Tobe's "no button" direction. The bar shows the state;
  clearing is a debug surface that could go in advanced
  settings later if needed.