# v3.11.35 — Image attachment: copy to permanent storage on picker

## Summary

Picked images are now copied into the app's permanent
`DocumentDirectoryPath/chat-attachments/<uuid>.<ext>` at picker
time. The bubble stores the new `file://` URI, which survives app
restarts on Android and is no longer subject to picker-activity
scoping.

## The bug

Tobe's 2026-10-07 report: 'a picture i sent earlier was visible
then, but now when i opened it again it was gone from that
message, it should stay, just like on discord.'

The Android gallery picker (`react-native-image-picker`) hands
back a `content://` URI. That URI is ONLY valid for the lifetime
of the picker activity — once the picker dialog dismisses, the URI
dead-ends. The bubble stores `{uri: 'content://...'}` and renders
via `<Image source={{uri}}/>`. On reopen, the URI is a zombie and
the bubble is empty.

## The fix

In `addAttachment`, after reading the base64 (v3.10.132's
inline-data fix), copy the file into `DocumentDirectoryPath`:

```
const targetPath = `${RNFS.DocumentDirectoryPath}/chat-attachments/${uuid}.${ext}`;
if (uri.startsWith('content://')) {
  await fs.writeFile(targetPath, dataBase64, 'base64');
} else {
  await fs.copyFile(readPath, targetPath);
}
stableUri = `file://${targetPath}`;
```

The bubble then stores `uri: 'file:///data/user/0/<app>/files/
chat-attachments/<uuid>.jpg'`. DocumentDirectoryPath survives
app restarts and is independent of the picker activity's
lifecycle.

The base64 `data` field is kept on the attachment as the inline
preview. The renderer already prefers `data` when present
(v3.10.132) and falls back to `uri`. So:
- During in-memory: data URI renders (no disk read needed).
- After reopen with data stripped: `file://` URI renders
 (permanent storage file is still there).
- After reopen with both preserved: data URI renders.

## Edge cases handled

- `content://` URIs (Android gallery) — `copyFile` doesn't
 reliably resolve content URIs across all Android versions, so
 we read the base64 (already done for inline preview) and
 `writeFile` it to permanent storage instead.
- `file://` URIs (camera shots in some configs) — `copyFile`
 works directly.
- Attachment dir missing — `mkdir` is called; the
 `exists`-then-`mkdir` race is swallowed (mkdir fails
 non-fatally if the dir already exists).
- Extension inferred from MIME type with a sensible default
 (`bin`) for unknown types.

## Cleanup

Not implemented in v3.11.35. The chat-attachments dir grows
unbounded across sessions. Future work:
- On app start, prune files in chat-attachments that no
 longer have a corresponding message in the chat cache.
- On message-deleted or after N days, garbage-collect.

For Tobe's usage pattern (a handful of images per session) the
unbounded growth isn't a problem in practice. Flag for a future
v3.11.X if disk usage becomes a concern.

## Files touched

- `package.json` — version bump 3.11.34 → 3.11.35
- `android/app/build.gradle` — versionCode 428 → 429, versionName
 3.11.34 → 3.11.35
- `src/screens/HomeScreen.tsx` — `addAttachment` copies to
 DocumentDirectoryPath.

## Manual QA
- [ ] Send an image in Quest A. Bubble shows the image.
- [ ] Force-quit the app (Settings → Apps → CyberClaw → Force
 Stop). Reopen. Image is still in the bubble.
- [ ] Pick from gallery vs camera — both work.
- [ ] Pick a non-image (e.g. PDF). Should still attach (the
 renderer falls back to the file icon for non-images).
- [ ] Long-running session (10+ images). App stays responsive.

## Risk

Low. The change is additive: the inline `data` field is
preserved (no behaviour regression for in-memory preview), and
the new `uri` is a strict superset of the old one (permanent
storage URI works everywhere the old picker URI did).

## Rollback

`git revert v3.11.35` restores the original behaviour. Existing
chat bubbles (persisted before this version) keep their old
`content://` URI which may be invalid on reopen — no automatic
backfill. New bubbles after the revert will exhibit the old bug.