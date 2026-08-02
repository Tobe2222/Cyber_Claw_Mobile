# v3.10.125 — chat scroll rubber-band fix + smaller arena controls

## 1. Chat scroll no longer rubber-bands at fake bottom

**Tobe's report (2026-08-02 16:46):**
> "the chat scroll is buggy now, when Im almost at the
> bottom and i try to scroll further down it takes me back
> where I started, like thats the bottom while there are text
> further down."

**Root cause:** v3.10.124 was a band-aid that added
`keyboardHeight` to the FlatList's
`contentContainerStyle.paddingBottom` when the keyboard was up
on Android. That grew the FlatList's `contentSize` by
`keyboardHeight`, which fired `onContentSizeChange` →
`scrollToEnd` → user ended up at the new padded bottom. The
last message was visible above the input (good), but the
FlatList had `keyboardHeight` of blank paddingBottom below
it, so any "scroll past the last message" gesture snapped
back at the new bottom — the user perceives the FlatList as
"stuck" with text hidden below.

The v3.10.121 absolute footerOverlay layout (chat list
extends behind the input, paddingBottom reserves scroll
space) was always a workaround for an actual layout problem.
With the keyboard hack layered on top, the rubber-band
appeared.

**Fix (v3.10.125):** Convert `footerOverlay` from
`position: absolute` to flex-flow.

- `chatScrollContainer` is now `flex: 1, flexDirection: column`.
- The FlatList is the first flex child (`flex: 1`), fills the
  available space.
- The `footerOverlay` (status bar / attachment row / cross-
  agent banner / input row) is the second flex child, takes
  its natural height.
- The existing `inputContainer.paddingBottom: keyboardHeight`
  (the v3.10.80 Android edge-to-edge workaround) grows the
  footerOverlay's natural height by `keyboardHeight` when the
  keyboard opens, which makes the FlatList flex-shrink by
  the same amount. The chat list's visible area now stops at
  the input's top edge — no matter where the input is on
  screen.

Net effect:
- Last message always scrolls fully above the input. ✅
- No more "fake bottom" — the FlatList ends exactly where
  the input begins. ✅
- No rubber-band. ✅
- iOS still uses `KeyboardAvoidingView` with `behavior='padding'`,
  unchanged.

**Trade-off:** the v3.10.121 "chat extends behind input"
optimization is sacrificed (~50dp of chat visual space).
The input is opaque (bg.primary), so chat behind it was
hidden anyway — the visible loss is small and the keyboard
behavior is now correct.

The reverted v3.10.124 paddingBottom trick is replaced by
nothing — the FlatList no longer needs any keyboard-aware
padding because the layout handles it.

---

## 2. Hide-arena controls smaller (the v3.10.124 strip still felt chunky)

**Tobe's report (2026-08-02 16:46):**
> "the hide arena don't seem to have changed size. Make it
> smaller."

Two things got smaller in v3.10.125:

### 2a. arenaStrip 28 → 22dp

The v3.10.124 strip at 28dp was already half of the original
52dp, but next to the slimmer 18-20dp tab row it still felt
chunky. 22dp matches the visual weight of a compact status
row.

- Label font 13 → 12
- Show button padding 10/3 → 8/2, radius 10 → 8
- Show button font 11 → 10
- Strip paddingHorizontal 14 → 12

### 2b. arenaHideButton (top-center pill) — v3.10.124 didn't touch this

Tobe was actually looking at the **▲ Hide arena** pill that
floats at the top-center of the full arena (not the strip).
The v3.10.124 work only changed the strip. The pill was
still at its v3.10.123 size: `paddingVertical: 6`, font 11,
width 104.

- paddingVertical 6 → 3
- font 11 → 10
- width 104 → 88
- radius 14 → 10
- top 8 → 6
- marginLeft -52 → -44

Net: the pill is now ~half the vertical footprint, matches
the slimmer strip.

---

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Reverted v3.10.124 contentContainerStyle.paddingBottom
    keyboardHeight addition
  - `chatScrollContainer`: added `flexDirection: 'column'`
  - `footerOverlay`: removed `position: 'absolute'` (and
    `bottom: 0, left: 0, right: 0, zIndex: 10`)
  - `arenaStrip`: height 28 → 22, label font 13 → 12, show
    button padding 10/3 → 8/2, show button radius 10 → 8,
    show button font 11 → 10, paddingHorizontal 14 → 12
  - `arenaHideButton`: paddingVertical 6 → 3, font 11 → 10,
    width 104 → 88, radius 14 → 10, top 8 → 6, marginLeft
    -52 → -44
- `package.json` — version 3.10.124 → 3.10.125
- `android/app/build.gradle` — versionCode 348 → 349

**v3.10.125 (versionCode 349).**

---

## Note on the quest-switch issue

Tobe also reported at 16:46: "I tried to activate a another
quest but it wont change when clicking the button. Likely due
to the quest changes."

I'm not sure this is related to v3.2.41 — the mobile's
`set_quest_active` WebSocket message flow goes through the
desktop's `sync-server.js → main.js → saveQuests →
broadcastQuestsList` chain, and the desktop log shows zero
`onSetQuestActive` calls since the desktop restarted at
16:11. Either the mobile isn't actually sending the WS
message (click not registering, or connection lost), or it's
hitting an error before the desktop sees it.

Investigating separately. Not included in v3.10.125.
