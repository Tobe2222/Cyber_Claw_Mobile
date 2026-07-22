# v3.10.71 — KeyboardAvoidingView disabled on Android (lingering gap bug)

Tobe followed up on v3.10.70:

> "@Clawsuu that bottom gap appears after i have
> opened keyboard and then removed it again"

Key detail: the gap only appears AFTER the keyboard
has been opened and dismissed. That's not the Android
nav-bar inset (v3.10.70 fixed that one). It's a
`KeyboardAvoidingView` lingering-padding bug.

## Root cause

`HomeScreen` wraps the whole tab content in:

```jsx
<KeyboardAvoidingView style={styles.tabContent}
                      behavior='padding'>
```

On iOS, `behavior='padding'` works correctly: when
the keyboard opens, the view adds `paddingBottom` equal
to the keyboard height; when the keyboard closes, the
padding is subtracted back.

On Android, `behavior='padding'` is a known source of
bugs. Specifically:

1. The KeyboardAvoidingView uses `Keyboard.addListener
   ('keyboardDidShow', …)` + `keyboardDidHide` to track
   keyboard state.
2. When the keyboard hides, the event fires, the
   component sets its `paddingBottom` back to 0 — in
   theory.
3. In practice, on Android the layout reflow doesn't
   always pick up the new padding immediately. The view
   stays at its old (keyboard-open) height for a few
   frames, leaving visible empty space below the input
   row until the user scrolls or the layout reflows
   for another reason.

Tobe's pattern of "open keyboard, close keyboard, see
gap" is exactly the symptom.

## Fix

`<KeyboardAvoidingView enabled={Platform.OS === 'ios'}>`

When `enabled={false}`, the component renders as a
plain `<View>` and does nothing — no event listeners,
no padding adjustments. On Android, the
`adjustResize` window flag (already set in
AndroidManifest.xml) handles keyboard avoidance
natively: the window shrinks when the keyboard opens,
and the flex-end `inputContainer` is pushed up by the
layout reflow. When the keyboard closes, the window
grows back and the inputContainer returns to its
natural position. No component-level intervention
needed, no leftover padding to chase.

On iOS we still need KeyboardAvoidingView because
there's no native `adjustResize` equivalent and the
window doesn't resize.

## The v3.10.70 inset fix is still correct

The `paddingBottom: 8 + insets.bottom` from v3.10.70
handles the Android nav-bar inset (always present).
This v3.10.71 fix handles the keyboard-dismiss gap
(only appears after keyboard interaction). They're
orthogonal — leave both in place.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `<KeyboardAvoidingView behavior='padding'>` →
    `<KeyboardAvoidingView behavior='padding' enabled=
    {Platform.OS === 'ios'}>`
- `android/app/build.gradle` — versionCode 296→297,
  versionName 3.10.70→3.10.71
- `package.json` — version 3.10.70→3.10.71

## Lessons

**When the user describes WHEN a bug appears, that's
the debugging fingerprint.** "It appears after I open
the keyboard and then remove it" is a totally
different bug than "there's always a gap below the
input." v3.10.70's fix addressed the second; this one
addresses the first. Reading the report literally
matters — paraphrasing "there's a gap below the input"
would've left this one unfixed.

**`KeyboardAvoidingView behavior='padding'` on Android
is a known footgun.** The standard workarounds are
either `behavior='height'` or `enabled={false}` with
native `adjustResize`. The simplest is `enabled=
{Platform.OS === 'ios'}` — keeps the JSX structure
intact, no conditional rendering needed, just gates the
behavior on iOS only.

**Don't stack two keyboard-avoidance systems.** The
project had both `KeyboardAvoidingView` (RN-level) and
`adjustResize` (Android-native) running on Android.
They mostly worked in parallel but didn't
synchronize on hide, hence the bug. The fix: turn
one off on Android (`adjustResize` stays because it
handles the resize natively). Same lesson as "don't
have two event listeners that should agree but don't."