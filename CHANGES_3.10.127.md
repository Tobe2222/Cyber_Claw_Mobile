# v3.10.127 — chat messages are selectable on mobile

## 1. Tap-and-hold to select text in chat

**Tobe's report (2026-08-02 20:34):**
> "I mean the characters, not the whole message as a property.
> ... and i meant on mobile actually. it might have worked
> on desktop. just so i can select characters and copy the
> text is what i want."

**Root cause:** React Native's `<Text>` is non-selectable by
default. Without the `selectable` prop, the text renders as a
single non-selectable block — you can tap-and-hold to
highlight the WHOLE message at once, but you can't drag
handles to pick individual characters or words.

The desktop chat uses CSS `user-select: text` (v3.2.47 fix)
so drag-to-select works there. On mobile the equivalent is
the React Native `selectable={true}` prop on `<Text>`.

**Fix:** Added `selectable={true}` to the chat-message Text
in `renderMessage`. Now:

- Tap-and-hold on any chat message → system text-selection
  handles appear (the standard iOS/Android gesture).
- Drag handles to pick individual characters or words.
- Tap "Copy" in the system menu to copy to clipboard.
- The full message text (without the [Name] prefix) is what
  gets copied.

**Note on `selectTextOnFocus`:** intentionally NOT set. That
would auto-select on every focus, which interferes with the
normal tap-to-scroll behavior. `selectable={true}` alone is
the standard mobile text-selection pattern — tap-and-hold,
drag, copy.

**Note on the [Name] prefix:** the agent label (e.g.
"[Clawsuu]") is rendered in a separate Text span and is NOT
selectable as part of the message body. To copy the prefix
plus message, the user can copy each part separately, OR we
could add a future "Copy with prefix" gesture. For now,
copying just the message body matches Tobe's "just so i can
select characters and copy the text" request — copy the
text they want to copy.

## Files changed

- `src/screens/HomeScreen.tsx` — chat-message `<Text>` gets
  `selectable={true}`.
- `package.json` — version 3.10.126 → 3.10.127
- `android/app/build.gradle` — versionCode 350 → 351

**v3.10.127 (versionCode 351).**
