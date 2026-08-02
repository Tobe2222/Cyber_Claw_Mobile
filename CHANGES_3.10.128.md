# v3.10.128 — paste-from-clipboard for chat attachments

## 1. Companion can now see pasted images

**Tobe's report (2026-08-02 21:03):**
> "i just found out that i have had a long conversation with
> clawsuu where i thought he was doing work but actually did
> not. I now have to paste pictures of that whole conversation
> but it seems that he cannot see the pictures i paste."

The chat screenshot showed: Tobe said "Sweet, lay it on me
— paste it and I'll see what's there" (Clawsuu), then
Tobe pasted an image, then Tobe said "I did paste it",
then Clawsuu said "I don't see it, dumbass — your phone
probably didn't send the file."

**Root cause:** React Native's `TextInput` has no
`onPaste` handler for image content. When the user
long-presses → Paste on an image, the TextInput's
`onChangeText` only sees the text string the user
typed — the image data is silently dropped. The
companion gets "I did paste it" as text but no image
attachment. The user thought they were sending a
screenshot; the system saw nothing.

## 2. Fix: dedicated paste button + menu option

Two ways to paste from the clipboard:

1. **One-tap 📋 button** in the input row, next to the
   `+` (attach) and 🎙️ (voice) buttons. Same handler.
2. **Tap `+` → "Paste from clipboard"** as the third
   option in the existing Alert menu (alongside Camera
   and Gallery).

Both call `Clipboard.getImage()` from
`@react-native-clipboard/clipboard`. The library returns
a base64 PNG string (no `data:` prefix). We wrap it as
`data:image/png;base64,<b64>` so it goes through the
existing `addAttachment` pipeline — same preview UI, same
send flow, same WS attachment message.

The library has no `hasImageAsync` (it was on an older
version), so we call `getImage()` and check for an empty
or near-empty result. If the clipboard has no image,
the user gets an Alert: "No image — copy an image first
(long-press an image → Copy), then tap paste."

## 3. UX choice — dedicated button + menu option

The dedicated button is faster for the common case
(pasting a screenshot). The menu option is the
discoverability path for users who haven't noticed the
button yet. Cost of both is one extra icon in the input
row (~24px). Worth it because paste is a now-recoverable
failure that previously lost messages silently.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `handleAttach` Alert gets a third option, "Paste from
    clipboard", that reads via `Clipboard.getImage()`.
  - New 📋 TouchableOpacity between `+` and 🎙️ in the
    input row with a one-tap paste handler.
- `package.json` — version 3.10.127 → 3.10.128
- `android/app/build.gradle` — versionCode 351 → 352

**v3.10.128 (versionCode 352).**
