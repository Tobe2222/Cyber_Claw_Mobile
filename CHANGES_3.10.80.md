# v3.10.80 — Android keyboard hides chat input (Android 15+ edge-to-edge fix)

Tobe reported (2026-07-23, on the Discord channel after testing v3.10.79):

> "@Clawsuu Okey so i tried to chat in the app but the
> input field etc seems stuck on the bottom now. It
> should be above the keyboard, see picture."

Screenshot showed the chat list, then a thin gap, then
the keyboard — with the input row nowhere visible.
It was being rendered behind the keyboard.

## Root cause

v3.10.71 disabled `KeyboardAvoidingView` on Android
and relied on Android's native
`windowSoftInputMode="adjustResize"` (in
`AndroidManifest.xml`) to resize the window when the
keyboard opens. The reasoning was correct: on
Android, `adjustResize` shrinks the window to make
room for the keyboard, and the flex-end `inputContainer`
rides up with the bottom edge.

That worked on Android <15. It doesn't work on Android
15+ anymore, because Android 15 enforces edge-to-edge
when `targetSdk >= 35`. The app's `targetSdk` is 36
(see `android/build.gradle`), so the system bars are
transparent and the OS **silently disables
`adjustResize`** for edge-to-edge apps. Result: the
window doesn't resize, and the chat input stays at
the bottom of the unresized window — behind the
keyboard.

Confirmed in the Android 15 community discussion
(react-native-community/discussions-and-proposals #827):

> "Currently, when running on Android 15 with the
> app's targetSdk set to 35, adjustResize gets
> disabled."

This is independent of `edgeToEdgeEnabled=false` in
`gradle.properties` — that flag is for the React
Native opt-in, not the OS-level enforcement that
kicks in at `targetSdk=35`.

## Fix

Track the keyboard height ourselves with
`Keyboard.addListener('keyboardDidShow', ...)` and
apply it as `paddingBottom` on the `inputContainer`
on Android. When the keyboard is open, the input
container grows by the keyboard height, the chat
scroll container (which is `flex: 1`) shrinks to
match, and the visible input row (at the top of the
input container's content area) lands just above
the keyboard.

```tsx
const [keyboardHeight, setKeyboardHeight] = useState(0);

useEffect(() => {
  const show = Keyboard.addListener('keyboardDidShow', (e) => {
    setKeyboardVisible(true);
    setKeyboardHeight(e?.endCoordinates?.height ?? 0);
  });
  const hide = Keyboard.addListener('keyboardDidHide', () => {
    setKeyboardVisible(false);
    setKeyboardHeight(0);
  });
  return () => { show.remove(); hide.remove(); };
}, []);

// At the inputContainer render site:
<View style={[styles.inputContainer, {
  paddingBottom: Platform.OS === 'android' && keyboardHeight > 0
    ? keyboardHeight
    : 8 + insets.bottom,
}]}>
```

iOS keeps using `KeyboardAvoidingView` with
`behavior='padding'` (enabled only on iOS), which
handles the keyboard via the iOS-native path and
doesn't have the Android 15+ problem.

## Why padding on the inputContainer, not on the chat container

Putting the keyboard's height as paddingBottom on the
inputContainer makes the inputContainer grow taller
when the keyboard opens. The chatScrollContainer has
`flex: 1`, so it shrinks to make room. The visible
input row sits at the top of the inputContainer's
content area (children of the inputContainer are
`alignItems: 'flex-end'`, which aligns to the
cross-axis end = bottom of the row container, but
the paddingBottom pushes the children up from the
bottom by the keyboard height). End result: input
row's bottom edge is at `screen_height - keyboardHeight`,
which is exactly the top of the keyboard.

Alternative considered: `marginBottom: keyboardHeight`
on the inputContainer. Works too, but slightly fiddlier
to compute the exact offset (need to subtract the
existing paddingBottom). PaddingBottom is simpler.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - New `keyboardHeight` state
  - Keyboard listeners updated to capture
    `endCoordinates.height`
  - inputContainer's `paddingBottom` switched between
    `keyboardHeight` (Android, keyboard open) and
    `8 + insets.bottom` (everything else)
  - Updated the v3.10.71 comment block to reflect
    the new reasoning
- `android/app/build.gradle` — versionCode 303→304,
  versionName 3.10.79→3.10.80
- `package.json` — version 3.10.79→3.10.80

## Lessons

**Don't trust "the OS handles this" without testing on
the target platform version.** v3.10.71's reasoning
about `adjustResize` was correct for Android <15.
The author's device (and mine) tested fine on the
older targetSdk. But the app's `targetSdk` is 36,
which puts it on Android 15+'s enforcement path.
The fix worked; the reasoning was correct; the world
changed underneath. Always validate native-handled
behavior on the actual target platform version, not
just "what the docs say works."

**Android 15+ edge-to-edge enforcement is invisible
until you trip over it.** The Android docs describe
the change as "you must use WindowInsetsCompat to
handle system bars." But `adjustResize` failing
silently isn't called out anywhere. The community
discussion (#827) has the gory details but you have
to know to look for them. Tag this as a recurring
trap: any time we change `targetSdk` or Android
version handling, audit ALL native-handled
behaviors (window insets, `adjustResize`,
`adjustPan`, system bar styling, etc.) for silent
breakage.

**PaddingBottom on the inputContainer is a
self-contained keyboard-avoidance primitive.** It
works regardless of edge-to-edge mode,
`adjustResize`, `adjustPan`, or any other OS-level
window management, because it manipulates the input
container's own layout directly. It's the most
defensive approach: if the OS ever changes how it
handles keyboard resize again (which it has done
twice in recent Android majors), this fix still
works.

**Belt-and-suspenders: keep iOS handling separate.**
The iOS path (KeyboardAvoidingView with
behavior='padding') doesn't have this problem and
is well-tested. Don't generalize "Android broke,
so iOS is probably broken too" — branch the fix on
Platform.OS and trust each platform's native path
unless you have specific evidence otherwise.