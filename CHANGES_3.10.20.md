# v3.10.20 — Inline attachment previews + tap-to-fullscreen

Tobe reported (after the v3.10.19 speaker enrollment
POC):

> "images dont attach themselves to the chat, such
> that one can Click them and look at them also, like
> discord does. It should. And i tried taking a picture
> with camera but it did not send it either."

## Root cause (two bugs)

**Bug 1 — attachments silently fail to send.**
HomeScreen's `sendMessage` calls
`syncClient.sendAttachment(b64, type, name)` but
that method **did not exist on SyncClient**. The
call landed in a `.then()` callback whose rejection
was unhandled. Tobe's screenshots show no attachment
preview and no log entry for the send — exactly
what a silent throw looks like.

**Bug 2 — no UI to display attachments.** Even if
the attachment had been sent, the chat only stored
`text: string` on each `ChatMessage`. No attachments
field, no `<Image>` rendering, no fullscreen viewer.

## Fix

### Bug 1: add `sendAttachment` to SyncClient

```ts
sendAttachment(base64, mimeType, fileName) {
  if (!this.connected) return false;
  try {
    this.send({ type: 'attachment', data: base64, mimeType, fileName });
    return true;
  } catch (e) {
    console.error('[SyncClient] Attachment send failed:', e?.message);
    return false;
  }
}
```

The `.then()` in `sendMessage` now checks the boolean
return value and logs success/failure accordingly.
Errors are no longer unhandled.

Also added `content://` URI fallback for camera capture
results that come back as content URIs with inline
data, not file URIs.

### Bug 2: inline image previews + tap-to-fullscreen

- Added `attachments?: Array<{ uri, type, name }>` to
  `ChatMessage` interface
- `sendMessage` includes attachments in the local
  user message so the previews show up immediately
  (before the send completes)
- `renderMessage` renders an inline row of 96×96
  image thumbnails inside the bubble. Tap a thumb
  to open the fullscreen viewer.
- Fullscreen viewer is a `Modal` with a dark
  backdrop, the image rendered at full-screen
  with `resizeMode="contain"`, and a close button
  in the top-right. Tap anywhere on the backdrop
  OR the close button to dismiss.

## Files

- `src/services/SyncClient.ts`:
  - New `sendAttachment(base64, mimeType, fileName)`
    method
- `src/screens/HomeScreen.tsx`:
  - Imports `Modal` from react-native
  - `ChatMessage` interface gains `attachments?` field
  - `fullscreenAttachment` state for the viewer
  - `sendMessage` includes attachments in the local
    message and checks the boolean return of
    `sendAttachment` for explicit error logging
  - `renderMessage` renders the attachments row
    with image previews + file cards
  - New `<Modal>` for fullscreen viewer
  - New styles: `attachmentsRow`, `attachmentImageWrap`,
    `attachmentImage`, `attachmentFileWrap`,
    `attachmentFileInner`, `attachmentFileIcon`,
    `attachmentFileName`, `fullscreenAttachmentBackdrop`,
    `fullscreenAttachmentContent`,
    `fullscreenAttachmentImage`,
    `fullscreenAttachmentFileCard`,
    `fullscreenAttachmentFileIcon`,
    `fullscreenAttachmentFileName`,
    `fullscreenAttachmentClose`,
    `fullscreenAttachmentCloseText`
- `package.json` — 3.10.19 → 3.10.20
- `android/app/build.gradle` — versionName
  3.10.19 → 3.10.20, versionCode 246 → 247

## Lesson

**Silent failures in unhandled promise chains are the
worst failure mode.** `syncClient.sendAttachment(...)`
in a `.then()` callback where the method didn't exist
would throw a TypeError — which would become an
unhandled promise rejection, swallowed by the JS
event loop with no log. The user sees "the camera
didn't send it" with no diagnostic surface.

Two-line fix: check the boolean return value in
the caller (`if (!syncClient.sendAttachment(...))`),
log a clear failure. But the deeper fix is to make
all WS sends return success/failure explicitly so
the caller can branch.

**Lesson: call sites and method definitions should
live in the same file when possible, or have
explicit integration tests.** HomeScreen and
SyncClient are in different files, and the only
way to catch "method doesn't exist on object" is
to actually call it at runtime. TypeScript
strict mode + `noImplicitAny` would have caught
this at compile time — worth adding if the
project isn't already using strict.

## What's NOT in this PR

The desktop-side handling of the `'attachment'` WS
message isn't covered. Right now, the mobile sends
the bytes but the desktop ignores them. Tobe's
primary complaint was "I can't see them in chat" —
which is now fixed (inline previews + tap to
fullscreen). If he wants the desktop to actually
process the image (vision LLM, etc.), that's a
desktop-side change to follow.