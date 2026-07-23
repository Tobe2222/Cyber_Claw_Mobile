# v3.10.87 — Discord replies now show up + better thinking indicator

## Reported by Tobe (via Discord, screenshot)

Tobe on Discord #cyber-dev after his previous
"buddy not answering" complaint:

> "@Clawsuu why answer in discord? I asked through
> cyberclaw.
>
> Lets fix that and lets add a better 'clawsuu is
> thinking' into the app, but keep it short and
> concise."

Screenshot showed the mobile chat with the user
having typed "Hello. Have you looked at it?" and
"Heeello" but no agent reply visible — the agent
had replied to Discord (committed at 15:56:42
CEST per the gateway log) but the mobile never
showed it.

## What this version does

Two changes, both relying on a new desktop-side
module (`desktop/src/openclaw-session-tail.js`,
shipped in desktop v3.2.21).

### 1. Discord replies now reach the mobile chat

The desktop's chat pipeline broadcasts agent
replies to the mobile via `sync-broadcast-chat`.
When the user types in **Discord** instead of
the mobile app, the agent's reply goes back to
Discord via OpenClaw's `message` tool — bypassing
the desktop's chat pipeline entirely. Result:
the mobile shows "thinking" forever and the
agent's reply lands in Discord instead.

The desktop now tails OpenClaw's session JSONL
files. When it sees a new assistant text message
in a Discord-routed session (`sessionKey` matches
`:discord:`), it broadcasts the message to the
mobile (via `syncServer.broadcastChatMessage`)
AND injects it into the renderer's chat history
(via IPC `openclaw-session-chat-message`) so
subsequent `request_chat_history` pulls see it.

Net effect: the user types in the mobile app,
the agent (potentially running via OpenClaw's
Discord routing) replies, the reply shows up in
both the mobile chat AND Discord. Whichever the
user checks first sees the reply.

### 2. Better thinking indicator (short and concise)

Old: "Clawsuu is thinking..." (static text, no
indication of what the agent is actually doing).

New: a per-tool-call friendly text, ~25 chars max,
no prefix. The desktop emits `agent_tool` events
when the agent runs an exec/read/write/etc. tool,
and the mobile updates the status bar:

- `exec` → "Running command..."
- `read` → "Reading file..."
- `write` → "Writing file..."
- `edit` → "Editing file..."
- `message` → "Sending message..."
- `browser` → "Browsing..."
- `web_search` → "Searching..."
- `process` → "Running process..."
- `cron` → "Scheduling..."
- `memory_search` → "Searching memory..."
- `memory_write` → "Saving to memory..."
- (unknown) → "Thinking..."

Tobe asked for "short and concise" — these are
all 25 chars or less. The text updates every
time the agent starts a new tool call, so the
user sees real progress ("Running command..."
→ "Reading file..." → "Running command..." → ...),
not a static message that lies.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - New `onAgentTool(msg)` handler that updates
    `chatVoiceStatus` to the desktop's friendly text
  - New `syncClient.on('agent_tool', onAgentTool)`
    listener + cleanup in the useEffect return
- `package.json` — version 3.10.86 → 3.10.87
- `android/app/build.gradle` — versionCode 310→311

## Companion desktop change (v3.2.21)

The mobile change is one half. The other half —
the OpenClaw session tailer, the tool-name
friendly-mapping, the IPC wiring — is in
desktop v3.2.21. See `cyberclaw/CHANGES_3.2.21.md`
for the architecture overview.

The two must be deployed together:
- Desktop v3.2.21 emits the new events
- Mobile v3.10.87 listens to the new events
If only one is deployed, the other half doesn't
work — the desktop emits but nothing receives,
or the mobile listens but nothing emits.

## Lessons

**Discord-routed replies are a real class of
bug that we keep rediscovering.** This is the
third time (after v3.1.26 mobile echo loops and
v3.10.79 agent messages missing) that the
discord-vs-chat-pipeline asymmetry has caused
user-visible bugs. The pattern: a side channel
(Discord) bypasses the desktop's chat pipeline
(mobile/voice/typed), so the mobile UI doesn't
see messages from that side. Each fix is
similar — bridge the side channel into the main
pipeline. The architectural lesson is to expect
this asymmetry and design for it upfront, not
patch it each time a new side channel ships.

**Tool-call visibility is more useful than
cycling text.** I considered a generic
"thinking → running command → thinking"
rotating text and rejected it — it gives the
user NO information about what the agent is
doing. The actual tool-call events give real
signal: when the agent reads a file, the user
sees "Reading file..." — that's useful debugging
info, not just visual noise. The data was
already there in the OpenClaw JSONL; surfacing
it was almost free.

**Keep the mobile change small when the heavy
lifting is on the desktop.** This entire mobile
change is ~30 lines (one handler, one listener
subscription, one cleanup line). All the
complexity is in the desktop's session tailer.
That ratio is right for a fix where the source
of truth lives in the desktop's filesystem —
the mobile just renders what the desktop tells
it.