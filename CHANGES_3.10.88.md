# v3.10.88 — bigger image previews in chat (tap-to-inspect)

## Reported by Tobe (via mobile chat, screenshot)

Tobe's mobile chat with his user message containing
an attached image of the broken miner page:

> "@Clawsuu also i would like to be able to Click the
> image that i have attached to inspect it like one
> can on discord"

Screenshot showed a small ~60dp thumbnail of the
attachment in the chat bubble. No obvious "tap to
inspect" affordance.

## Root cause

The tap-to-inspect modal was **already wired** in
v3.10.20 (HomeScreen.tsx:3091 — `onPress={() =>
setFullscreenAttachment(att)}` on the TouchableOpacity
wrapping the Image). The fullscreen modal also exists
(`fullscreenAttachment` state + `<Modal>` at line 3804
+ full-screen image display at line 3817).

What's broken is the **visual affordance**. The
`attachmentImageWrap` style was `width: 96, height: 96`
— thumbnail-sized. A 96dp square doesn't communicate
"tap me to inspect"; it just looks like a small icon.
Tobe's natural reaction: "I can't click this thing to
inspect it" — even though the click WAS wired.

## Fix

Increased the image preview from 96x96 to 180x180 with
a soft gold border (`rgba(247,147,26,0.4)`). The
border matches the chat accent color (used for
`chatStatusBar`, `questSeparator`, `setActive` button)
so it visually links the image to the rest of the
chat's interactive elements — "this is a clickable
thing in the chat, not just decoration."

180dp is the right size because:
- Big enough to read detail at-a-glance (no need to
  inspect for OCR / debugging screenshots, which is
  what Tobe uses them for)
- Small enough that 2-3 still fit in a single bubble
  side-by-side
- Smaller than full bubble width, so it doesn't
  visually compete with the message text

The tap-to-fullscreen behavior is unchanged — it was
already correct. The fix is purely cosmetic: make
the preview large enough that tapping it feels
natural.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `attachmentImageWrap` style: 96x96 → 180x180, added
    `borderWidth: 1, borderColor: 'rgba(247,147,26,0.4)'`
- `package.json` — version 3.10.87 → 3.10.88
- `android/app/build.gradle` — versionCode 311→312

## Companion desktop note

The desktop doesn't need a change for this feature.
The tap-to-inspect modal lives entirely on the mobile
side. The desktop just sends the attachment URI
through `chat-message` payload, which the mobile
already renders.

## Separate issue: agent_tool events from v3.10.87

Tobe also reported "still just says thinking" — the
mobile's chat-voice-status bar wasn't updating to
the per-tool-call text ("Running command...",
"Reading file..."). Investigation found two issues:

1. **sessions.json format mismatch.** The tailer was
   reading `sessions.json` expecting `parsed.sessions`
   (array), but the newer format is a dict keyed by
   `sessionKey`. Fixed in v3.10.87 commit
   `1f2998b...` (refreshSessionKeys now handles both
   formats).

2. **EADDRINUSE on desktop restart.** During this
   debugging session, the old electron process
   (started at 17:09) was still holding port 9247
   when I tried to start the new one with the fix.
   Result: the new instance got `EADDRINUSE` and
   stayed up but never bound to the port. The
   `agent_tool` events were emitted by the new code
   but never reached the mobile (no WebSocket
   connection on the new instance, mobile still
   pointed at the old one).

Fixed by force-killing all old electron processes
before starting the new one. The desktop now logs
`[openclaw-tail] broadcasting agent_tool tool=exec
friendly=Running command...` and the broadcasts go
out on port 9247.

Tobe should see the agent's tool name appear in the
status bar instead of static "thinking..." once the
mobile reconnects (pull-refresh the chat if it
doesn't reconnect automatically).

## Lessons

**Visual affordance > functional affordance.** The
tap-to-inspect was already wired and working, but
the small thumbnail size didn't visually invite the
interaction. Users don't read source code to discover
features; they read pixels. A 96dp square looks like
a thumbnail; a 180dp square with a soft gold border
looks like an interactive preview.

**Always assume the bug is on the data side until
proven otherwise.** When the desktop "should" be
broadcasting but the mobile "doesn't receive",
check the data flow end-to-end:
- Tailer detects entry? ✓ (logged "tool call detected")
- Tailer calls onChatMessage callback? ✓ (logged
  "broadcasting")
- _broadcast actually fires? ✓ (no error)
- WS connected? ✗ (EADDRINUSE — old instance had the
  port)
- Mobile receives? (unreachable — not connected)

The "is the data correct" check passed; the actual
problem was socket binding. Don't be too quick to
blame the model output or the JSON parsing when the
issue might just be port contention.

**Tagging cross-component fixes means restarting
BOTH sides.** When Tobe reported "still just says
thinking" on v3.10.87, the mobile side was correct,
but the desktop was still running v3.2.20 because the
restart didn't take. Without a port-forwarding
indicator, you can't tell from the mobile which
desktop version it's talking to.