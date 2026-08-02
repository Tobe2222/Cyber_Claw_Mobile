# v3.10.130 — bring back the 📋 paste button

## 1. The bug

**Tobe's report (2026-08-02 22:35):**
> "tested again. Attached a picture but it did not show up in
> the chat after."

The screenshot showed the user message bubble with just
text ("Okey we try again. Can you see this image?") — no
image preview. The desktop log confirmed: zero
attachments sent. The text message went through with
`attachments: 0`.

## 2. Root cause

v3.10.129 added a focus-based auto-attach handler that
called `Clipboard.getImage()` when the user tapped the
chat input. If the clipboard had an image, it was
auto-attached.

Tobe rejected the explicit button ("We dont need a new
button, we just have to make the pasted pictures see able
for the companion") so I removed the button and kept the
focus handler.

The focus handler is **unreliable**. Android's
`Clipboard.getImage()` returns null when:

- The clipboard has been read by another app since the
  last foreground state (Android sometimes clears the
  clipboard image cache on app backgrounding).
- The user copied the image, then opened the chat app,
  then tapped the input — the focus event fires too
  early in some Android versions and the image isn't
  yet readable.
- Android security policies on Android 13+ require the
  app to declare USE_BIOMETRIC or similar permissions
  for clipboard image access (varies by device).

In Tobe's test, the focus handler ran but
`Clipboard.getImage()` returned null. The user tapped
send. The send path had an empty `attachments` array
(only the focus handler was supposed to populate it).
Zero attachments made it through to the desktop.

## 3. Fix: bring back the explicit 📋 button

The focus handler stays (it's a nice convenience when it
works). The explicit button is now restored for the cases
where the focus handler fails:

```js
<TouchableOpacity
  style={styles.micButton}
  onPress={async () => {
    const b64 = await Clipboard.getImage();
    if (!b64 || b64.length < 100) {
      Alert.alert('No image', 'Copy an image first...');
      return;
    }
    addAttachment({
      uri: `data:image/png;base64,${b64}`,
      fileName: `pasted-${Date.now()}.png`,
      type: 'image/png',
    });
  }}
>
  <Text style={[styles.micButtonText, { fontSize: 18, lineHeight: 20 }]}>📋</Text>
</TouchableOpacity>
```

Tobe said the button wasn't necessary, but the focus-
only approach demonstrably fails on Android. The button
is small (one icon, between + and 🎙️), reliable, and
gives the user a clear "paste now" affordance. If Tobe
wants it gone later, we can add a fallback (e.g. retry
the clipboard on every keystroke) that doesn't require
UI.

The handler also logs to the Log tab so we can see what
happened — "📋 Paste: reading clipboard image..." then
either "attached N KB image" or "no image on clipboard".

## Files changed

- `src/screens/HomeScreen.tsx` — restored the 📋 button
  in the input row.
- `package.json` — version 3.10.129 → 3.10.130
- `android/app/build.gradle` — versionCode 353 → 354

**v3.10.130 (versionCode 354).**