# v3.10.17 — Fix double-messaging on voice transcripts

Tobe reported (screenshot of the chat):

> "and it should not double message. Just the one
> which shows from where is good."

The screenshot showed his voice message appearing
twice:
- "You" (gray bubble, left side) — local add
- "You [From: Android Phone]" — desktop echo

## Root cause

Two add paths for voice messages, only one of which
goes through `appendAgentMessage` (the shared helper
that dedupes via the `messagesByAgent` map):

**Path 1 (local add)**: in the `voice_transcript_result`
handler, when the desktop sends the transcript back:

```js
setMessages(prev => {
  const dupe = prev.some(m => m.isUser &&
    Math.abs(m.ts - Date.now()) < 5000 &&
    m.text === msg.transcript);
  if (dupe) return prev;
  return [...prev, {
    id: `user-${Date.now()}`,
    text: msg.transcript,
    isUser: true,
    ts: Date.now()
  }];
});
```

This adds directly to `messages` (the view state)
with its own dedupe (5s window). It does NOT touch
`messagesByAgent`.

**Path 2 (desktop echo add)**: when `sync-broadcast-chat`
arrives, `onChat` calls `appendAgentMessage`, which
checks `messagesByAgent[agentId]` for dedupe. Since
Path 1 didn't populate `messagesByAgent`, the dedupe
misses, and the message gets added a second time.

Tobe's typed-message path doesn't have this bug
because typed messages call `appendAgentMessage`
BEFORE sending to the desktop — so the typed message
is in `messagesByAgent` first, and the desktop echo
dedupes correctly.

## Fix

1. Route the local voice-transcript add through
   `appendAgentMessage` (with the agentId from the
   active chat companion). Now both adds live in
   `messagesByAgent`, and the dedupe is centralized.

2. Expand the dedupe window from 2s to 10s
   (matching ts) plus a defensive 30s (text-only)
   fallback. The 2s window was too tight for desktop
   echo timestamps that can lag the mobile local
   timestamp by several seconds (network + STT + IPC
   round-trip). The 30s text-only fallback catches
   the case where isUser is set wrong somewhere.

3. The voice-transcript handler also passes the
   agentId explicitly to `appendAgentMessage` (it was
   previously a no-arg add to the messages view, with
   no agent routing).

## Files

- `src/screens/HomeScreen.tsx`:
  - `appendAgentMessage` dedupe expanded (2s → 10s
    matching ts+isUser; new 30s text-only fallback)
  - `voice_transcript_result` handler: routes local
    add through `appendAgentMessage` instead of
    directly setting `messages`
- `package.json` — 3.10.16 → 3.10.17
- `android/app/build.gradle` — versionName
  3.10.16 → 3.10.17, versionCode 243 → 244

## Lesson

**When you have two add paths for the same data,
both should go through the same dedupe layer.** The
typed-message and voice-message paths originally
both appended to the visible chat but went through
different dedupe checks (typed: shared helper; voice:
local inline check on a different state slice). When
the desktop echo came back, only the helper's dedupe
was on the right state. The fix is to consolidate
the dedupe behind a single helper and make every
caller use it.

**Lesson: when fixing a bug, follow the symmetry.**
The voice-message path had a typed-message sibling
that worked correctly (single add, no duplicate).
Comparing the two would have surfaced the dedupe
mismatch immediately — the typed path uses
`appendAgentMessage`, the voice path used
`setMessages` directly. The asymmetry was the bug.