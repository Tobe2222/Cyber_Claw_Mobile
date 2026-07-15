# v3.10.29 — smarter no-response logging + redesigned enrollment bar

**Two issues from v3.10.28 testing:**

1. **"No response, retrying..." without a reason.** The 30s
   transcribing timeout fired and the user only saw a generic
   "no response from desktop" message. Was it the network?
   The desktop STT? The LLM? The WS was already disconnected
   when we tried to send? No way to tell from the log.

2. **Compact enrollment bar in voice mode looked like a bug.**
   v3.10.24 added a thin 3px bar at the top of voice mode.
   Tobe: "I don't see the learning bar. Actually it's in the
   top. But we need to style it differently, it looks more
   like a bug now. Add a small text also for voice mode."
   At 0% fill it was just a thin dark line — no label, no
   visual signal that it was a working bar.

## What shipped

### Specific no-response reason logging

**`src/screens/WakeModeScreen.tsx`:**
- Added `lastWsStateRef` + `lastSendErrorRef` to track the
  most recent WS state and send_error during a recording
  turn. Reset at the start of every turn.
- New `state_change` listener on syncClient — logs every
  WS transition (`[WS] State change: connecting`, etc.)
  to the per-turn log.
- New `send_error` listener on syncClient — logs the
  specific reason the WS rejected a send (`[WS] Send failed:
  type=audio_input reason=not_connected`).
- Rewrote the 30s transcribing-timeout reason to use the
  tracked state:
  - WS state: `disconnected` or `lost` → "audio never
    reached the desktop"
  - WS state: `reconnecting` → "connection dropped mid-
    conversation"
  - Last send_error: `not_connected` → "Last send error:
    type=audio_input reason=not_connected (Ns ago)"
  - WS state: `connected`, no errors → "desktop pipeline
    stalled"

The user-facing `⏰ No response, retrying...` line is
unchanged, but the diagnostic `addLogEntry` now says
exactly which scenario it was. Tobe's "No response,
retrying" reports will now have an actual cause to
investigate.

### Visual bar redesign

**`src/components/VoiceEnrollmentBar.tsx`:**
- **Compact (voice mode)** is now a small floating pill
  with:
  - Mic icon (🎙 while learning, ✓ when locked) on the
    left
  - Tiny text label ("Learning 247/1000" while learning,
    "Voice locked" when locked)
  - A thin 60×2px progress strip INSIDE the pill, not
    filling the full width
  - Gentle opacity pulse animation (0.82 ↔ 1.0 over 2.8s
    loop) while learning, so the user can see the pill
    is alive even at 0% progress
  - Solid emerald background + ✓ icon when locked (no
    pulse, no progress strip)
- **Full (settings)** now shows a "🎙 Calibrating…"
  placeholder during the initial status load (instead of
  an empty bar that looks like 0% fill).
- Locked state in settings now shows the match score
  inline below the bar.
- Color language stays consistent: cyan while learning,
  emerald when locked, both variants.

### Container style update

**`src/screens/WakeModeScreen.tsx`:**
- `enrollmentBarCompact` View changed from full-width
  container to `alignItems: 'flex-start'` so the pill
  sits at its natural width on the left (not stretched
  across the screen).
- Removed the `backgroundColor: 'rgba(0, 0, 0, 0.35)'`
  backdrop — the pill has its own background now, no
  need for a full-width dark band.

## Why the pill instead of a full-width bar

Tobe's feedback: "looks more like a bug now". Three
options I considered:
1. Keep the full-width bar, brighten the track.
2. Switch to a corner indicator (top-right chip).
3. Switch to a left pill (current choice).

(1) is the smallest change but doesn't add a label, so
the user still wouldn't know what it is. (2) is the most
discreet but invisible. (3) reads as a status pill (like
"recording" or "muted" indicators in other apps), gives
the user both a label and a progress strip, and is
unambiguously "a thing the app is showing me" rather
than "a UI element that loaded wrong".

## Why the pulse animation

Two reasons:
1. At 0% fill (very early in a session, before any
   voice has been processed), the pill is otherwise
   static. A pulse tells the user "this is working,
   just hasn't filled yet" without taking up screen
   space or competing with the YOUR TURN overlay.
2. The pulse stops the moment the profile locks. So
   the user gets a secondary signal: "the bar is
   pulsing = still learning", "the bar is still =
   locked". Subtle but useful.

The pulse is opacity-only (0.82 ↔ 1.0) — well below
the threshold of being annoying. A user looking at the
screen sees it as a "soft glow" not a "blink".

## Why a separate "Calibrating…" placeholder

In the v3.10.24 design, the very first render (before
the first 2s poll returns) was an empty track at 0% —
indistinguishable from "the system has heard you 0
times". The user reading the screen sees a flat dark
bar with a faint border and assumes "stuck on 0%". The
"Calibrating…" label + dim track + shimmer conveys
"the system is loading, the bar will fill once it's
ready" instead of "the system is broken, the bar is
stuck at 0%".

## Build artifacts

- `package.json`: 3.10.29
- `android/app/build.gradle`: versionCode 256, versionName 3.10.29
- Modified: `src/components/VoiceEnrollmentBar.tsx` —
  pill design, pulse animation, calibrating placeholder
- Modified: `src/screens/WakeModeScreen.tsx` —
  state_change + send_error listeners, ref tracking,
  detailed timeout reason, container style update
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors
  remain — unrelated to this release per the AGENTS.md
  "pre-existing TS errors" rule.

## What's NOT in v3.10.29

- **Reconnect button on the pill** — the pill could
  show a "Tap to retry reconnect" affordance when WS
  is disconnected. Deferred; the user can already
  trigger a reconnect from the Connection section in
  Settings, and adding tap-to-reconnect to the pill
  would break the `pointerEvents="none"` (currently
  the pill is intentionally non-interactive so it
  never eats WebView taps).
- **Mid-turn reconnect attempts** — if the WS drops
  while we're in the middle of a turn, we could
  automatically attempt a reconnect. The current
  behavior is to let the SyncClient's built-in
  reconnect happen, but the recording turn's
  audio is already in flight and won't be re-sent.
  Deferred; this is a deeper design change.
- **Audio response timeout shorter than 30s** — 30s is
  the current floor. Some scenarios (e.g. desktop
  process hung but not yet killed) could be detected
  faster with an 8s pipeline-stall hint (already
  wired in v3.10.14) + a 15s "still nothing" warning
  before the 30s hard timeout. Deferred.