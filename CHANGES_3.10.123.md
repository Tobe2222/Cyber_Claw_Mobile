# v3.10.123 — Hide-arena on top, smaller arena, tighter bottom

Three follow-ups to v3.10.122 from Tobe's
2026-08-01 15:22 screenshot:

1. "Lets put the hide arena in the top of the arena
   Instead." — moved the "▲ Hide arena" button from
   bottom-center to top-center of the arena.
2. "Lets reduce the Height a bit but keep same gap
   to settings. By perhaps 10% such that we lift the
   chat Height to replace. Chat needs to be taller
   while arena smaller." — `ARENA_HEIGHT` 0.68×w (cap
   320) → 0.61×w (cap 290). ~10% reduction; the freed
   ~30dp goes to the chat list.
3. "I think there is a little more room for the
   keyboard at the bottom, it perhaps can go lower,
   not sure." — slimmed the input row: `paddingVertical`
   8→4 + closed-keyboard `paddingBottom` 8+insets→insets.
   The chat list's footer-height estimate dropped
   56→44 to match. ~12dp recovered.

## Fix 1: hide-arena button to top

**The bug.** v3.10.122 placed the "▲ Hide arena"
button at `bottom: 8` of the arena frame. On a
390dp-wide phone the arena is ~265dp tall (after the
v3.10.122 bump), which puts the button ~257dp below
the top of the arena — well past the Quests/Voice
Mode buttons (top corners) but uncomfortably close
to the bottom edge of the arena + the "Clawsuu"
sprite label. Tobe's spec was clear: put it on top.

**The fix.** `arenaHideButton.top: 8` (was
`bottom: 8`). The button now sits in the top-center
of the arena frame, between the Quests button
(top-left) and the Voice Mode button (top-right).
104dp-wide pill, dark translucent background so it's
readable over both dark and forest arena bgs. Same
onPress (toggleArenaHidden).

## Fix 2: smaller arena (~10%)

**The bug.** v3.10.122 had `ARENA_HEIGHT =
Math.min(SCREEN_WIDTH * 0.68, 320)` → on a 390dp
phone the arena is `min(265, 320) = 265dp`. The chat
list has to share the remaining vertical space with
the tab bar (~50dp), companion tab bar (~50dp), and
the floating footer (~56dp). Tobe wants more chat,
less arena.

**The fix.** `Math.min(SCREEN_WIDTH * 0.61, 290)` →
on a 390dp phone the arena is `min(238, 290) = 238dp`.
~10% smaller (27dp savings). Cap stays at 290 (was
320) so the arena doesn't get huge on wider phones.

The `ARENA_HEIGHT` constant is passed to the WebView's
`Arena.init(width, height)` JS call so the canvas
inside the arena rescales to match. Verified: no
sprite distortion, no missing interactions.

## Fix 3: slimmer input row

**The bug.** The input row had `paddingVertical: 8`
+ inline `paddingBottom: 8 + insets.bottom` when
keyboard closed. Total height = 8 + 40 (content) +
8 + insets.bottom = 56 + insets.bottom. The chat
list's contentContainer reserved `paddingBottom: 4 +
56 + insets.bottom` to scroll the last message above
the input.

**The fix.** Two changes:
- `inputContainer.paddingVertical: 8 → 4` (input
  row content area 4dp shorter top + bottom)
- Inline `paddingBottom: 8 + insets.bottom → insets.bottom`
  (input row sits 8dp closer to the bottom of the
  screen)
- Chat list `paddingBottom: 4 + 56 + insets → 4 + 44 + insets`
  (footer-height estimate 56 → 44 to match the
  shorter input row)

Net: input row ~12dp shorter, chat list gains ~12dp
of vertical room. The nav bar inset is still respected
(the input sits at `bottom: insets.bottom` from the
screen edge, so the nav bar doesn't overlap it).

The keyboard-open path is unchanged (`paddingBottom =
keyboardHeight` still pushes the input above the
keyboard). The reading of Tobe's ambiguous
"more room for the keyboard at the bottom" is "the
input row can sit lower on the screen when the
keyboard is closed" — i.e. the closed-state padding
was wasted vertical space, now reclaimed by the
chat list.

## Files

- `src/screens/HomeScreen.tsx`:
  - `ARENA_HEIGHT: 0.68×w/320 → 0.61×w/290` (~line 269)
  - `arenaHideButton` comment update (~line 3652)
  - `arenaHideButton` style `bottom: 8 → top: 8`
    (~line 4502)
  - `inputContainer` inline `paddingBottom` 8+insets → insets
    (~line 4225)
  - `inputContainer` style `paddingVertical: 8 → 4`
    (~line 4768)
  - `chatList` contentContainerStyle `paddingBottom`
    4+56+insets → 4+44+insets (~line 3918)
- `package.json`: 3.10.122 → 3.10.123
- `android/app/build.gradle`: versionCode 346 → 347

## Notification reminder (still pending on Tobe's side)

Tobe also reported in the 15:22 message:
"And notification still ping me with old messages
when i open the app."

This is the same issue from v3.10.120 — the mobile's
`!msg.replay` check is gated on the desktop sending
`replay: true` on cached AI messages, which is the
v3.2.40 change. Verified `git ls-remote --tags
origin | grep v3.2.40` returns the tag. Tobe needs
to `pm2 restart 1` to pick up v3.2.40 from
`feature/companion-improvements`.

This isn't a v3.10.123 code change — it's a runtime
restart. The Discord reply notes it again.

## Lessons

1. **Position overlays away from dense UI zones.**
   v3.10.122 placed the hide-arena button at the
   bottom-center of the arena, which on most screen
   sizes overlaps or sits adjacent to the sprite
   label ("Clawsuu", "Lamasuu"). Tobe's screenshot
   showed the button landing right on top of the
   sprite label. Top-center is the safer default for
   overlays on the arena — it sits between the two
   top corner buttons (Quests + Voice Mode) without
   overlapping any sprite / status overlay.

2. **PaddingVertical and paddingBottom are
   independent dials.** The input row uses both for
   different reasons (vertical breathing room vs
   nav-bar safe area). v3.10.122 set both to 8
   (the default), then added `insets.bottom` to the
   bottom. v3.10.123 separates them: paddingVertical
   is the visual breathing room (now 4), paddingBottom
   is the safe-area handling (now just insets.bottom).
   Two knobs, two purposes, two values. Easier to
   reason about.

3. **Footer-height estimates must match actual
   footer height.** The chat list reserves
   `paddingBottom: 4 + FOOTER_HEIGHT + insets.bottom`
   so the last message can scroll above the input.
   If the footer shrinks (this release: 56 → 44),
   the estimate must shrink too — otherwise the chat
   list over-reserves space and you get the v3.10.122
   symptom where the input has visible breathing
   room below it. Keep them in sync.

## Pre-push checks

- `npx react-native bundle --platform android
  --dev false` → bundle written, no parse errors
- `npx tsc --noEmit` → 79 pre-existing errors,
  0 new errors

## What I didn't do

### Animated hide/show

The arena collapse is still instant. Could add
`LayoutAnimation.configureNext(LayoutAnimation.Presets
.easeInEaseOut)` before `setArenaHidden` to animate
the height transition (smooth shrink from 238dp →
52dp + chat list expanding). Adds 5 lines of code
and a `UIManager.setLayoutAnimationEnabledExperimental
(true)` call on Android. Out of scope for v3.10.123
— ship the toggle first, polish later.

### Per-tab persistence for arenaHidden

`arenaHidden` is global. Could be per-tab (e.g. hide
on chat tab, show on events tab). Most users probably
want it global ("I want my chat to be tall everywhere")
but per-tab is a 3-line change if needed. Out of scope.

### Bumping inset.bottom manually

On some Android devices the `useSafeAreaInsets` value
may not match the actual nav bar height. Could expose
a manual override in Settings (e.g. "extra bottom
inset" slider). Out of scope — the safe-area-context
lib is generally correct on Android 15+, and Tobe's
issue was about wasted padding, not about the inset
value itself.