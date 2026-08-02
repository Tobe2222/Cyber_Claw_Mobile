# v3.10.129 — auto-attach clipboard image on chat input focus

## 1. No new button, just make pasted pictures visible

**Tobe's report (2026-08-02 21:23):**
> "We dont need a new button, we just have to make the
> pasted pictures see able for the companion"

(Built on Tobe's earlier 21:03 report: "I now have to
paste pictures of that whole conversation but it seems
that he cannot see the pictures i paste.")

v3.10.128 added a dedicated 📋 button AND a "Paste from
clipboard" menu option. Tobe didn't want either — he
just wants his existing paste gesture to work.

## 2. What was actually broken

React Native's `TextInput` has no `onPaste` handler for
images. When the user long-presses → Paste on an image,
the data is silently dropped. `onChangeText` only sees
the text the user types — no signal that an image paste
happened.

The user thought they were sending a screenshot; the
system saw nothing.

## 3. Fix: auto-attach on TextInput focus

The cleanest UX is to handle this BEFORE the user has
to think about it. When the user taps the chat input
(the `onFocus` event fires before the keyboard appears),
we check the clipboard for an image. If there's one,
we add it as an attachment via the existing
`addAttachment` pipeline — same preview UI, same send
flow.

```js
const handleTextInputFocus = useCallback(async () => {
  const b64 = await Clipboard.getImage();
  if (!b64 || b64.length < 100) return;
  // dedupe by content hash so re-focusing doesn't re-add
  const hash = `${b64.length}:${b64.slice(0, 64)}:${b64.slice(-64)}`;
  if (hash === lastClipboardHashRef.current) return;
  lastClipboardHashRef.current = hash;
  const dataUri = `data:image/png;base64,${b64}`;
  addAttachment({ uri: dataUri, fileName: `pasted-${Date.now()}.png`, type: 'image/png' });
}, []);
```

The dedupe (via a content hash stored in a ref) means
re-focusing the input doesn't add the same image a
second time. If the user types, focuses away, copies a
different image, focuses back — the second image gets
attached because its hash differs.

`Clipboard.getImage()` returns a base64 PNG string.
Wrapped as `data:image/png;base64,<b64>` so it goes
through the existing sendAttachment pipeline.

## 4. Why focus instead of onChangeText

A previous idea was to detect paste via `onChangeText`
(React Native's TextInput sometimes inserts placeholder
text on paste, and we could diff). But the library's
behavior is inconsistent across iOS/Android and the
edge cases (image paste vs text paste vs selection
replace) make the detection unreliable. `onFocus` is
deterministic — it fires exactly when the user is
about to type, which is exactly when we want to peek at
the clipboard.

## 5. Trade-off

- **Pro:** Zero UI changes. User's existing paste gesture
  works. No new muscle memory.
- **Pro:** Works for the "I just copied a screenshot
  and want to send it" common case.
- **Con:** Auto-attaches the clipboard image even if the
  user wasn't going to paste it. They can still tap the
  ✕ on the attachment preview to remove it. The dedupe
  hash prevents the same image from being re-added on
  every focus.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - Removed v3.10.128's 📋 button and "Paste from
    clipboard" menu option (Tobe didn't want new UI).
  - Added `handleTextInputFocus` callback that checks
    the clipboard and adds the image if present.
  - Wired `onFocus={handleTextInputFocus}` on the
    chat input's TextInput.
  - New `lastClipboardHashRef` ref for dedupe.
- `package.json` — version 3.10.128 → 3.10.129
- `android/app/build.gradle` — versionCode 352 → 353

**v3.10.129 (versionCode 353).**
