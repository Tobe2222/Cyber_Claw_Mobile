# v3.10.121 — Kill skyStrip entirely, push arena closer to header, footer overlay

Three follow-ups to v3.10.120 from Tobe's
2026-08-01 12:37 screenshot:

1. "Yeah we dont need that cloud pill in light mode
   either, it looks terrible."
2. "And it looks like this now. We can move the
   arena even further up so close as possible to the
   settings button so the border almost touches the
   settings button."
3. "And it seems like there is a tiny bit of room at
   the bottom also, that space could be used by the
   chat. Lets optimize space more."

## Fix 1: skyStrip removed entirely

**The bug.** v3.10.120 hid the skyStrip + cloud
pill on dark mode only, leaving them on Sun + Forest
themes. Tobe's follow-up: the cloud silhouette in the
upper-right of the strip looks misplaced on light
modes too. Even without the dark-mode contrast
issues, the strip just isn't pulling its weight.

**The fix.** The skyStrip `<View>` render is
removed from the home screen entirely (no
`{!fullscreen && !isLandscape && t.name !== 'dark'
&& <View style={styles.skyStrip} />}` block, just
a comment marker). The `skyStrip` + `skyStripCloud`
styles are left in for now in case a future theme
wants a different decorative element; safe to delete
in a cleanup PR.

The freed ~14dp vertical space + the
header paddingBottom reduction (10 → 6, ~4dp) gives
back ~18dp total. ARENA_HEIGHT is bumped from
`Math.min(SCREEN_WIDTH * 0.62, 280)` to
`Math.min(SCREEN_WIDTH * 0.68, 320)` (~30-40dp
taller). The arena sits closer to the header, with
its top border almost touching the header's bottom
border on dark mode.

## Fix 2: arena closer to header

**The bug.** Between the header bottom border
(`borderBottomWidth: 1, borderBottomColor:
border.subtle`) and the arena's top border
(`borderWidth: 3, borderColor: brand.accent` /
`border.strong`), there's `paddingBottom: 10` on the
header + ~3dp borderTop on the arena = ~14dp empty
dark space. On a small phone that's about 4% of the
viewport wasted.

**The fix.** `headerBar.paddingBottom: 10 → 6`
(~4dp savings) + bump `ARENA_HEIGHT` (~30-40dp
gain) + remove skyStrip (~14dp gain) = ~50dp
vertical space reclaimed, almost all of which goes
to the arena.

Result: the arena's orange top border sits ~6dp
below the header's bottom border (was ~14dp). On a
390dp-wide phone (iPhone 14 base), the arena is now
`min(390 * 0.68, 320) = 265dp` tall (was
`min(390 * 0.62, 280) = 242dp`).

## Fix 3: floating footer overlay (chat uses bottom space)

**The bug.** Below the input row (the +/mic, text
field, ▶ send), the screen had ~80-90dp of dark
"paddingBottom: 8 + insets.bottom" space — the nav
bar inset (gesture-nav pill or 3-button nav). That
space is necessary to keep the input above the nav
bar, but it makes the chat list feel like it ends
abruptly above the input. The user wants the chat
list to USE that space (more messages visible
without scrolling).

**The fix.** Wrap the chat footer (status bar +
attachment previews + cross-agent banner + input
row) in a `footerOverlay` container with
`position: absolute, bottom: 0, left: 0, right: 0`.
The chat list (FlatList) extends behind it. The
overlay has `backgroundColor: t.bg.primary` so the
chat content behind it is hidden — the chat just
gets more vertical room for messages.

Padding bookkeeping:
- `chatList` contentContainerStyle now has
  `paddingBottom: 8 + 56 + insets.bottom` (was `8`).
  The `56` is an approximation of the footer height
  (input row content + paddingVertical). The
  `insets.bottom` is the nav bar height. The last
  chat message can still scroll above the footer.
- `footerOverlay.bottom: 0` so it sits flush against
  the chatScrollContainer's bottom edge.
- The overlay's own paddingBottom is computed
  inline: `Platform.OS === 'android' && keyboardHeight
  > 0 ? keyboardHeight : 8 + insets.bottom` (same as
  before; the keyboard-avoidance logic still works).
  Android 15+ edge-to-edge disables adjustResize so
  we manually push the input above the keyboard.

The footer overlay contains (top to bottom):
1. `chatStatusBar` ("Clawsuu is thinking...")
2. `attachmentPreviewRow` (image thumbnails with ×)
3. `crossAgentBanner` ("Lamasuu — 3 new messages")
4. `inputContainer` (the +/mic, text field, ▶ send)

All of these used to live in the flex flow above
the input row. Now they all float together at the
bottom.

The footer overlay has `backgroundColor: t.bg.primary`
(opaque page bg) so chat content behind it is
hidden — the visual is identical to before (no
"see-through" effect), just with more chat room.

## Files

- `src/screens/HomeScreen.tsx`:
  - `ARENA_HEIGHT` 280 → 320 cap (~line 269)
  - skyStrip render removed (~line 3522)
  - skyStrip + skyStripCloud styles marked dead
    (~line 4318)
  - `headerBar.paddingBottom: 10 → 6` (~line 4397)
  - `inputContainerFloating` renamed to
    `footerOverlay`, wrapped around the chat footer
    block (~line 3963 + ~line 4103)
  - `chatList` contentContainerStyle bumped to
    `[styles.chatList, { paddingBottom: 8 + 56 +
    insets.bottom }]` (~line 3832)
- `package.json`: 3.10.120 → 3.10.121
- `android/app/build.gradle`: versionCode 344 → 345

## Pre-push checks

- `npx react-native bundle --platform android
  --dev false` → bundle written, no parse errors
- `npx tsc --noEmit` → 79 pre-existing errors
  (baseline 79 from v3.10.119), 0 new errors
- Bundle compiles, footerOverlay wrap structurally
  correct (1 open + 1 close `</View>` per block)

## Lessons

1. **Float the input row when you want to use the
   bottom safe-area inset for content.** The pattern
   is straightforward (position:absolute, bottom:0,
   left:0, right:0, opaque bg) but easy to forget
   when the design started with input in the flex
   flow. The trade-off is "input always visible
   above the nav bar, content extends behind it." For
   a chat UI this is the right trade-off — the input
   is the user's primary action, but a chat with
   many messages shouldn't waste vertical space below
   it.

2. **Decorations that work in one theme usually
   don't work in another.** v3.10.115 added the
   skyStrip + cloud for Forest theme (pale blue +
   white cloud on green arena). It looked fine on
   Forest. It looked bad on Sun (different palette,
   same element = awkward). It looked broken on Moon
   (high-contrast white on dark = slider pill).
   Three themes, three readings. Rule of thumb: if
   a decoration is theme-specific, ship it
   theme-conditional; if it's meant to be
   cross-theme, it must use ONLY theme tokens (no
   hardcoded white / pale blue). v3.10.121 takes the
   simpler path: kill the decoration entirely. The
   freed space goes to the arena, which is the
   primary content.

3. **Padding reservation > absolute positioning
   when you have scrollable content.** The
   footerOverlay floats at bottom:0 but the
   FlatList's contentContainer gets a paddingBottom
   equal to the overlay's height + nav bar inset.
   Without that padding, the last chat message would
   be hidden behind the floating overlay forever
   (FlatList doesn't know the overlay is there). The
   padding tells the FlatList "your scrollable area
   ends here" so users can scroll the last message
   up above the input.

## What I didn't do

### Dynamic footer-height measurement

`paddingBottom: 8 + 56 + insets.bottom` uses a
hardcoded 56dp for the footer height. If the
attachment preview row is showing (with 1+ image
thumbnails ~80dp tall) or the cross-agent banner
is showing (~50dp), the actual footer height can be
130-200dp and 56dp is too small — the last message
can't scroll above the banner. Could measure the
footer's actual rendered height via onLayout and
adjust dynamically. Out of scope for v3.10.121;
filed as a known issue. Workaround for now: the
FlatList's natural paddingBottom gives the user at
least the input-row visibility; banner/attachment
overlap is rare and not visually broken.

### Removing the floating footer on iOS

iOS uses KeyboardAvoidingView (the parent of
chatScrollContainer) for keyboard avoidance, so the
floating footer's Android-specific `keyboardHeight`
paddingBottom isn't needed. The current fix applies
the same wrapper to both platforms; on iOS the
keyboardHeight is always 0 so it's a no-op there.
Cleaner would be a `<Platform.OS === 'android' ?`
guard around the overlay. Out of scope for v3.10.121
— the iOS path works correctly as-is.