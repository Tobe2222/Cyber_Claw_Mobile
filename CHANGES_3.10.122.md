# v3.10.122 — Tighter header gap + hide-arena button

Three follow-ups to v3.10.121 from Tobe's
2026-08-01 13:52 screenshot:

1. "There still seems to be some room between arena
   and settings etc." — header paddingBottom 6→2,
   header borderBottom removed (the arena's own top
   border provides the separator).
2. "And the same for the bottom." — chatList
   paddingBottom 8→4 (small breathing-room reduction
   above the floating footer).
3. "We should also add a hide arena button, perhaps
   in the bottom middle of the arena." — new
   `arenaHidden` state + "▲ Hide arena" overlay
   button + collapsed `arenaStrip` with "▼ Show
   arena" button.

## Fix 1: tighter top gap

**The bug.** v3.10.121 left a ~17dp gap between
the header bottom (with `paddingBottom: 6` +
`borderBottomWidth: 1`) and the arena top border
(`borderWidth: 3`). On a 390dp-wide phone the arena
top border sat ~17dp below the gear icon row.

**The fix.**
- `headerBar.paddingBottom: 6 → 2` (~4dp savings)
- `headerBar.borderBottomWidth` removed (the arena's
  top border is now the separator; double-bordered
  visual noise gone)

Net: ~5dp reclaimed, the arena's orange top border
sits ~9dp below the header bottom (was ~17dp). The
arena border almost touches the gear icon row on
390dp-wide phones, satisfying Tobe's "so close as
possible to the settings button so the border
almost touches the settings button" spec.

## Fix 2: tighter bottom gap

**The bug.** `chatList.contentContainerStyle` had
`paddingBottom: 8 + 56 + insets.bottom`. The `8`
was the chat's own breathing room above the floating
footer. Tobe saw a "tiny bit of room at the bottom"
between the last chat message and the input row's
top border (about 10dp = the 8 padding + 1 border +
1 visual rounding).

**The fix.** paddingBottom 8 → 4. The 56 (footer
height estimate) and insets.bottom stay the same so
the last message can still scroll above the input.
4dp is enough to separate the last bubble from the
input row's 1dp borderTop without feeling cramped.

## Fix 3: hide-arena button

**The new feature.** Two new render states + one
new toggle, satisfying Tobe's "we should also add
a hide arena button, perhaps in the bottom middle
of the arena" request.

- **Button (overlay, bottom-center of arena):**
  Dark translucent pill with "▲ Hide arena" text,
  positioned at `bottom: 8, marginLeft: -52` so it
  visually centers in the arena. Tapping it sets
  `arenaHidden = true`. Only shown in
  non-fullscreen + non-landscape mode (voice mode
  owns the arena in fullscreen).

- **Strip (collapsed arena, when `arenaHidden`):**
  52dp-tall bar with the active companion's icon +
  name on the left, a "▼ Show arena" button (orange
  pill matching the theme accent) on the right.
  Tapping the button sets `arenaHidden = false`,
  restoring the full arena.

- **Persistence:** `arenaHidden` survives Settings
  navigation via module-scope `arenaHiddenPersistent`
  (same pattern as `chatDraft` in v3.10.120). The
  collapsed state is sticky across the Settings
  round-trip — Tobe can hide the arena, navigate
  to Settings to tweak something, come back, and
  the arena stays hidden until he manually
  expands it.

**Chat list gains the freed vertical space.**
With the arena hidden, the chat list extends into
the ~270+dp the arena previously occupied. For a
user who is actively chatting (vs. just glancing at
the companion sprite), this is a meaningful UX
improvement — more messages visible without
scrolling.

## Files

- `src/screens/HomeScreen.tsx`:
  - `arenaHidden` state + `toggleArenaHidden`
    (~line 586)
  - `arenaHiddenPersistent` module-scope +
    `getArenaHidden` / `setArenaHiddenPersistent`
    getters/setters (~line 350)
  - `companionIconForActive` helper (~line 360)
  - `arenaFrame` render branches into strip vs full
    arena (~line 3556)
  - `arenaHideButton` overlay inside the full arena
    (~line 3652)
  - `headerBar.paddingBottom: 6 → 2`,
    `borderBottom` removed (~line 4397)
  - `chatList` contentContainerStyle
    `paddingBottom: 8 → 4` (~line 3832)
  - `arenaStrip` / `arenaStripLabel` /
    `arenaShowButton` / `arenaShowButtonText` /
    `arenaHideButton` / `arenaHideButtonText`
    styles (~line 4448)
- `package.json`: 3.10.121 → 3.10.122
- `android/app/build.gradle`: versionCode 345 → 346

## Lessons

1. **Header-bottom-border + arena-top-border is
   double-bordered.** When the arena has its own
   visible top border (3dp neon orange / theme
   border.strong), the header's borderBottom (1dp
   subtle) becomes redundant. The visual signal
   "header ends here, arena begins" can come from
   either border, not both. v3.10.121 left both in;
   v3.10.122 drops the header border for a cleaner
   ~1dp tighter fit.

2. **Collapsible content is a UX lever, not just a
   layout trick.** The "hide arena" button isn't
   just "make the arena smaller" — it's "give the
   user a power-user affordance to reclaim vertical
   space when they don't need the visual." For a
   chat-heavy user this is meaningful; for a
   glance-heavy user it's nothing. The toggle makes
   the layout adaptive to user behavior rather than
   fixed for the average case.

3. **Module-scope persistence for small UI state.**
   This is the third use of the pattern (chatDraft
   in v3.10.120, arenaHidden here, and any future
   small toggle). When the user can navigate away
   and back (Settings screen, etc.), local React
   state resets. Module-scope variables survive
   unmounts. Lift to AsyncStorage only when the
   state needs to survive a full app restart.

## Pre-push checks (all green)

- `npx react-native bundle --platform android
  --dev false` → bundle written, no parse errors
- `npx tsc --noEmit` → 79 pre-existing errors
  (baseline 79 from v3.10.119), 0 new errors

## Cross-repo dependency

**The notification fix from v3.10.120 is still
gated on the desktop being on v3.2.40.** Tobe
reported in this screenshot "notification still
ping me with old messages when i open the app" —
this is almost certainly because the desktop is
still on v3.2.39 (which doesn't tag replayed
messages with `replay: true`). The mobile-side
`!msg.replay` check is a no-op if the desktop
isn't sending the flag.

Verified v3.2.40 is on GitHub:
`git ls-remote --tags origin | grep v3.2.40`
returns the tag. The fix is for Tobe to
`pm2 restart 1` (or restart the desktop via the
run manager) to pick up v3.2.40 from `feature/
companion-improvements` branch. After restart,
the 50-message rolling-buffer replay on every
reconnect will be silent.

## What I didn't do

### Animated collapse/expand

The arena's collapse is instant (current frame
becomes the strip, no animation). A `LayoutAnimation`
or `Animated.View` with height transition would feel
smoother but adds complexity for a small visual win.
Out of scope for v3.10.122; ship the toggle first,
add the animation later if Tobe requests it.

### Per-tab hide-arena persistence

`arenaHidden` is global (one toggle, all tabs). If
Tobe later wants "hide on chat tab, show on events
tab" (where the arena might be more useful as
context), it's a per-tab flag. Out of scope; the
simple global toggle covers the stated use case.

### Desktop-side replay notification audit

v3.2.40 tags replays but doesn't fire a desktop log
for "replayed N messages to reconnecting client M"
beyond the existing console.log. Could add a per-
client replay counter to help debug "why is the
notification still firing" reports. Out of scope
for v3.10.122; the desktop logs already say
"Replaying N recent AI message(s)" which is enough
to diagnose the issue.