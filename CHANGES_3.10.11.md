# v3.10.11 — Voice message transcript stays in chat

Tobe reported (channel `#cyber-dev`, screenshot of the
chat with the orange user bubble at the top):

> "I saw my interpreted voice message in the chat but it
> vanished. It should stay in the chat."

## Root cause

Voice messages travel a different code path than typed
messages:

**Typed message flow** (works):
1. User types text in the chat input → tap send
2. `appendAgentMessage(userMsg, ...)` adds to local
   chat immediately
3. `syncClient.sendChat(text, aid)` sends to desktop
4. Desktop echoes back via `chat` event with `isUser=true`
5. Mobile `onChat` SKIPS it (line 1636 in v3.10.10)
6. Local add + skip → exactly one entry, correct

**Voice message flow** (broken):
1. User records audio, recorder sends via
   `syncClient.sendAudioInput(base64, 'audio/wav')`
2. Desktop STT transcribes
3. Desktop calls `sync-broadcast-chat` with
   `isUser=true` and the transcript
4. Mobile receives `chat` event with the transcript
5. Mobile `onChat` SKIPS it
6. **No local add ever happened** (voice path never
   calls `appendAgentMessage`) → transcript never
   appears in chat

The transcript never reached the chat UI because:
- Voice path doesn't add locally
- Server echo is filtered out by the `msg.isUser`
  skip

Tobe saw the transcript "vanish" — what he actually
saw was the desktop UI briefly echoing the
transcription (the desktop does display it), and then
the mobile showed... nothing.

## Fix

Removed the `if (msg.isUser) return` skip in
`HomeScreen.onChat`. User messages are now added to
the chat history along with assistant messages.

**Dedupe:** the existing dedupe in `appendAgentMessage`
checks `(ts, text)` within 2 seconds — this prevents
duplicates when the user TYPES a message (typed path
adds locally first, desktop echoes back, ts+text match
triggers dedupe on the echo).

For voice messages, the desktop STT's transcript
might differ slightly from what was said (punctuation
additions, "um" removal). The ts+text match might miss
in that case, leading to two entries: the typed one
(deduplicated) and the voice one (not deduped). Since
voice never adds a local copy, missing the dedupe just
means the voice transcription is the only entry — no
duplicate. Acceptable trade-off.

Also fixed: the `incoming.isUser` field was hardcoded
to `false`. Changed to `!!msg.isUser` so user messages
display as user bubbles (orange/left-aligned) instead
of assistant bubbles (purple/right-aligned).

## Files

- `src/screens/HomeScreen.tsx` (+30 / -10): removed
  the `if (msg.isUser) return` skip, set
  `isUser: !!msg.isUser` on the incoming message.
- `package.json` — 3.10.10 → 3.10.11
- `android/app/build.gradle` — versionName 3.10.10 →
  3.10.11, versionCode 237 → 238

## Lesson

**Different input paths need different filtering
rules.** The `msg.isUser` skip in `onChat` was added
to prevent the typed-message echo from creating a
duplicate. But it also blocked the voice-message
echo, which is a different scenario with different
needs (voice never adds locally, so there's no
duplicate to skip). The right primitive is "dedupe
when we have something to dedupe against" not "skip
all user messages."

The existing ts+text dedupe handles both cases
correctly — voice (no local copy, so echo wins) and
typed (local copy first, echo deduped). Just needed to
let the user messages through to the dedupe layer.

**Lesson: filter at the level of intent, not
identity.** "Skip user messages to prevent duplicates"
was the intent, but "skip messages where
`msg.isUser===true`" was the implementation. The
implementation broke the voice case because voice and
typed messages both have `msg.isUser===true` but
should be handled differently (typed: dedupe; voice:
keep). Filter by what you want (dedupe), not by what
you're afraid of (duplicates).