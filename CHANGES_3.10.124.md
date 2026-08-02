# v3.10.124 — chat scroll + smaller arena strip

## 1. Can scroll to the bottom of chat with keyboard up

**Tobe's report (2026-08-02 15:22):**
> "for some reason i cannot scroll all the way down now when i have the keyboard up."

**Screen state:** Keyboard open, last message visible but its bottom
half sat behind the input row. The user could scroll up and down
freely, but no scroll position could land the message fully above
the input.

**Root cause:** Android keyboard avoidance has two pieces.

1. The `inputContainer` adds `paddingBottom: keyboardHeight` on
   Android so the input row's content sits above the keyboard
   (the v3.10.80 workaround for Android 15+ edge-to-edge
   `adjustResize` being broken). That makes the input container
   TALLER by `keyboardHeight` when the keyboard is up.
2. The FlatList wraps the chat messages with
   `contentContainerStyle.paddingBottom: 4 + 44 + insets.bottom`
   (~82dp) to keep the last message visible above the closed-state
   input.

The two pieces need to know about each other. The footerOverlay
wrapping the input is `position: absolute`, so it doesn't shrink
the FlatList. The FlatList still extends to the bottom of the
`chatScrollContainer`. So when the keyboard is up:

- FlatList bottom = screen bottom
- Last message sits at `82dp` above the FlatList bottom
- Input content sits at `keyboardHeight + ~50dp` above the screen bottom
- If `keyboardHeight > ~82dp`, the input covers the last message — and
  no amount of scrolling can pull the message up because the
  FlatList's paddingBottom is the only "space" the user can scroll
  into. The user just knows the bottom feels unreachable.

iOS already worked because `KeyboardAvoidingView` with
`behavior='padding'` shrinks the entire tabContent by keyboardHeight
(the FlatList AND the input move up together), so the closed-state
82dp of paddingBottom is always enough.

**Fix:** Add `keyboardHeight` to the FlatList's
`contentContainerStyle.paddingBottom` when the keyboard is up on
Android. iOS path is unchanged.

```js
contentContainerStyle={[styles.chatList, {
  paddingBottom: 4 + 44 + insets.bottom
    + (Platform.OS === 'android' && keyboardHeight > 0
        ? keyboardHeight : 0),
}]}
```

**Why I tied the fix to `keyboardHeight` itself instead of
recomputing the inputContainer height:** the inputContainer's
effective height is already `contentHeight + keyboardHeight +
paddingVertical*2` thanks to the same `keyboardHeight` value. Adding
the same value to the FlatList padding keeps the two in sync without
extra constants. If the input container's design changes later, this
still tracks.

**Lesson:** Manual keyboard avoidance (paddingBottom tricks) only
works when EVERY container that needs to know about the keyboard
height is told about it. The OS-driven path (KeyboardAvoidingView /
adjustResize) is a single point that handles all children; the
manual path is N points that have to stay in sync. When you do the
manual path, audit every sibling that scrolls or anchors to the
bottom.

---

## 2. Hide-arena strip almost half the size

**Tobe's report (2026-08-02 15:22):**
> "the hide arena can be smaller. Almost half the size"

**Change:** `arenaStrip.height` 52 → 28dp. Trimmed the label font
(14 → 13), button padding (12/6 → 10/3), border radius (14 → 10),
and show-button font (12 → 11) to match the slimmer row.

Net: the collapsed-arena strip is now ~24dp shorter. Chat list
gains ~24dp of vertical room when the arena is hidden.

The strip is still readable — the show button is the same shape,
just smaller. The companion name + icon on the left still has room
to display without truncation.

---

## Files changed

- `src/screens/HomeScreen.tsx` — FlatList paddingBottom
  (keyboardHeight-aware on Android), arenaStrip styles
- `package.json` — version 3.10.123 → 3.10.124
- `android/app/build.gradle` — versionCode 347 → 348,
  versionName 3.10.123 → 3.10.124

**v3.10.124 (versionCode 348).**
