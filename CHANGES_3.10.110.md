# v3.10.110 — Empty-tap-send log + cross-echo dedupe fix

## Two fixes bundled because they share a debugging session.

### 1. Empty-tap-send was silent (the visible "no thinking, no response" mystery)

When the user tapped Send with the input field empty
and no audio recording, `sendMessage()` would do:

```js
const text = inputText.trim();
if (!text && attachments.length === 0) return;
```

— silently. No log line, no toast, no feedback. The
user saw their tap register on the button (which was
orange, not greyed out) and nothing happened. They
interpreted this as "the chat pipeline is broken" or
"clawsuu is not answering", when in reality nothing
had been sent.

Tobe's 2026-07-29 18:30 report: "I wrote in the chat
but no thinking indication and no response. There is
the log in second image." Looking at the Log tab in
the second screenshot, the last `→ [...]` line was
for "Yoyo" at 6:27 PM — there was no `→ [...]` line
between then and the screenshot at 6:49 PM. The
intermediate "Testing" tap at 6:29 PM hit the
silent-empty-return path. The Log tab didn't show
anything because nothing was logged.

**Fix.** Added two log lines so any future empty-tap
is visible in the Log tab:

```js
addLogEntry('🟢 send: pressed', 'info');  // at function entry
// ...
if (!text && attachments.length === 0) {
  addLogEntry('⬜ send: empty input, ignored', 'warn');
  return;
}
```

The user sees the warn line and knows the tap was
received but the input was empty (likely they typed
and undid, or the field got cleared on foreground).

A toast / haptic is a future enhancement; the log
is enough to diagnose.

### 2. Cross-echo dedupe killed agent replies that overlapped user texts

Stage 3 of `appendAgentMessage` matched any message
within 5 minutes of the same normalized text and
silently dropped it. The dedupe was supposed to
catch the local-append ↔ desktop-echo pair (e.g. user
sends "Hi", desktop echoes back the same string
within a few seconds — only one should land), but
the check didn't filter by `isUser`. So:

```js
if (list.some(m =>
  matchingText(m) &&
  Math.abs(m.ts - msg.ts) < dupWindowMsCrossEcho
)) {
  return prev;
}
```

If user said "Yo" at 17:48 and the agent replied
"Yo, I can do that" at 17:50 (different strings, but
normalize-prefix-matched on "Yo"), the agent reply
was dropped as a "duplicate" of the user's "Yo". The
chat would skip an entry, and the agent's bubble
never rendered.

Tobe's 2026-07-29 18:27 case: user sent "Yoyo. The
Captcha and description looks good now." and the
agent replied (per the desktop log: "I'm bored and
thinking we should raid a captcha farm together,
just for fun. 🥐"). The mobile's chat history
showed the user's "Yoyo" bubble but NOT the agent
reply. Same text overlap pattern, even if exact text
didn't match — the simpler explanation is that
Stage 3 matched a substring / common word.

**Fix.** Added the `m.isUser === msg.isUser` guard
to Stage 3 so cross-echo dedupe only catches
**same-type** echo pairs (user↔user, agent↔agent),
not accidentally silence the OTHER side of the
conversation:

```js
if (list.some(m =>
  matchingText(m) &&
  m.isUser === msg.isUser &&
  Math.abs(m.ts - msg.ts) < dupWindowMsCrossEcho
)) {
  return prev;
}
```

This still catches the original "Hey" double-bubble
case (because both are user-type), but lets an
agent reply with shared text through.

**Where:**
- `src/screens/HomeScreen.tsx`:
  - `sendMessage` entry-point log (lines ~2847-2854)
  - Empty-tap-send warn log (lines ~2896-2905)
  - Stage 3 cross-echo dedupe (lines ~419-446)

**Not changed:**
- The other dedupe stages (Stage 1 — same text + same
  isUser within 60s, Stage 2 — same text + same
  isUser within 1h) are unchanged. Those already
  filter by isUser; they caught the within-session
  and cross-restart echo pairs. Only Stage 3 (the
  catch-all 5-minute window) needed the guard.

versionCode: 334
