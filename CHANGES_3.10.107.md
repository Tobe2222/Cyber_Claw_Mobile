# v3.10.107 — Preserve attachments through chat-history re-deserialization

**What changed:** The mobile's chat-history
re-deserialization (the `msg.messages.map(...)` block
in `onChatHistory` handler, around line 2150 of
`HomeScreen.tsx`) now forwards the `attachments` field
on each historical message. Previously, every field
except `attachments` was mapped across, so any time
the desktop re-sent chat history (reconnect,
foreground transition, tab switch, broadcast reconcile)
the local bubbles lost their image preview.

**Why:** Tobe's 2026-07-29 feedback: "there is some bug
in the chat where the pictures sometimes dont get
sent or added to the message, not sure why.
Sometimes it gets into the message and other times it
vanishes and its only the text which gets sent."

What was actually happening: the local bubble HAD the
image preview at send time (we set it correctly on
the local `userMsg` object). The desktop received the
text via `sendChat` and the attachment bytes via
`sendAttachment`, but the desktop's renderer had no
listener for the `mobile-attachment` IPC message
(it was silently saved to disk and discarded). On the
next chat-history pull, the mobile's mapping threw
away the local `attachments` field — and the user saw
a text-only message that should have been a picture.

**The fix is partial.** This release only addresses
the local-preview-vanishing problem (the most
user-visible part of the bug). The deeper issue — that
the desktop never sees the attachment and so the LLM
can't see the image — is a separate fix that needs
changes on both sides (the desktop needs an
`ipcRenderer.on('mobile-attachment')` handler that
adds the saved attachment to the chat message, AND
the mobile needs to bundle the attachment path into
the chat payload so the desktop knows which message
to attach it to). Out of scope for this release.

**Side effect of the partial fix:** after upgrading,
image previews will be more reliable locally (no
longer wiped on reconnect), but the LLM still
won't see them. Tobe's chat will look better but the
agent won't yet understand the image content of an
attach. I'll wire that up in v3.10.108 if it comes up.

versionCode: 331
