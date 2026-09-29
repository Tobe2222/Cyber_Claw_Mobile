# v3.11.19 — render screenshot images from desktop on chat bubbles (companion to desktop v3.3.20)

## The bug

Tobe (2026-09-29 11:38, Discord #cyber-dev):

> "@Clawsuu I see that clawsuu is posting pictures in the
> desktop app but they dont come through to the mobile end.
> They should."

When the desktop's agent (clawsuu) emits a `[SCREENSHOT
target=cyberclaw]` directive in its reply, the desktop
shows a clickable thumbnail bubble in its chat panel. The
mobile, however, showed only the text reply — no
thumbnail. The mobile had no idea the screenshot existed.

## Root cause

The desktop's `addChatMsg('agent-image', { dataUri, ...
})` call (app.js:4131) renders an `<img>` in the
desktop's chat panel but does NOT broadcast over the
WebSocket to the mobile. The broadcast path in app.js
~4312 only fires `sync-broadcast-chat` for the `'agent'`
/ `'user'` / `'error'` types — `'agent-image'` is excluded
by the type guard, so the bubble is invisible to the
mobile.

This is the desktop-side bug. The mobile-side counterpart
is in this changelog: even if the desktop had broadcast
the image, the mobile's `onChat` handler (HomeScreen.tsx
~3596) didn't read `msg.attachments`, so the bubble
renderer wouldn't have rendered the thumbnail anyway. Both
sides needed a fix.

## The fix (mobile-side only — desktop fix in v3.3.20)

The mobile's `onChat` handler constructs an `incoming:
ChatMessage` from the broadcast. Add a one-line
passthrough for `msg.attachments`:

```ts
attachments: Array.isArray(msg.attachments) && msg.attachments.length > 0
  ? msg.attachments
  : undefined,
```

The bubble renderer in `renderMessage` (HomeScreen.tsx
~6190, the v3.10.20 attachment-rendering path) already
accepts `attachments: [{ uri, type, data, name, size }]`
and renders tap-to-expand image previews. We re-use the
existing renderer — no new bubble component needed.

The data shape on the wire (from the desktop v3.3.20
fix) is the same `AttachmentItem` shape the mobile already
understands for outbound user-attachment sends:

```ts
{ uri, data, type: 'image/png', name: 'screenshot-<target>', size }
```

`data` is the raw base64 string (without the `data:...`
prefix). The mobile constructs `data:${type};base64,${data}`
at render time (HomeScreen.tsx ~6243) — same as user
attachments.

## Why only `agent-image` for now

The desktop's broadcast guard now also catches `'agent-image'`,
but for text-only bubbles (`agent` / `user` / `error`) the
`attachments` field is `null`, which the mobile treats as
"no attachments" — same as the pre-fix behavior. We only
forward non-empty attachments to avoid inflating regular
text chats with empty arrays.

## Lessons

1. **Same architectural class as v3.3.19 / v3.3.13:**
   hand-written type whitelists drift as new types are
   added. The desktop's broadcast guard (app.js:4312)
   silently dropped `'agent-image'` for the lifetime of
   v3.2.83+ — ~6 weeks. The mobile-side fix is a
   defensive counterpart: when a broadcast payload
   contains an `attachments` field, pass it through,
   regardless of which message type carries it.

2. **The bubble renderer was already there.** When the
   user-attachment flow shipped in v3.10.20, we built the
   image-preview path inside `renderMessage` and tested it
   for outbound user-attachment sends. That investment
   paid off today: this fix is one field added to the
   ChatMessage constructor. New visual content types
   should reuse the existing renderer whenever possible.

3. **Test the cross-device behavior for every new bubble
   type.** The `agent-image` bubble type was added in
   desktop v3.2.83 with a thorough desktop-only test.
   The mobile side wasn't verified until Tobe noticed 6+
   weeks later. The rule: any new chat-message surface on
   one device needs a manual smoke test on the other.

## Persistence (intentional non-fix)

Image bubbles from the desktop are still NOT persisted to
mobile history (`agent_history` from `request_agent_history`
still only carries text bubbles from
`chatHistoryByAgentAndQuest`). The desktop v3.3.20 fix
also doesn't persist the image data. Both sides agree:
images are ephemeral, live-broadcast only. After a
desktop restart, the desktop's chat also loses the image
bubble (the file at `/tmp/clawsuu-shot-*.png` may also be
gone). Adding persistence is a separate design problem
(base64 screenshots are 50KB-500KB each — would blow
localStorage's 5-10MB cap).

If Tobe later wants images to survive a restart, the
cleanest path is: persist file paths in the bucket, copy
the file to `~/.openclaw/cyberclaw/attachments/` on
capture, resolve to dataUri on read. Out of scope here.

## Audit table

Layer | Field | Preserves | This fix
---|---|---|---
desktop addChatMsg broadcast | attachments | n/a | ✅ desktop v3.3.20
desktop IPC handler | attachments | n/a | ✅ desktop v3.3.20
sync-server payload | attachments | n/a | ✅ desktop v3.3.20
sync-server replay cache | attachments | n/a | ✅ desktop v3.3.20
mobile onChat handler | attachments | n/a | ✅ this fix
mobile ChatMessage type | attachments | already exists | ✅ no change
mobile bubble renderer | attachments | already accepts | ✅ no change
desktop persistence | attachments | n/a | ⏸ intentional
mobile history sync | attachments | n/a | ⏸ intentional