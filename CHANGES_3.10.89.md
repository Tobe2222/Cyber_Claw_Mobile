# v3.10.89 — fix Stage 3 dedupe rejecting user messages against cached history

Tobe reported on v3.10.88 (2026-07-23 18:03):

> "@Clawsuu switched to lamasuu and back. It still did
> not show"

The "switched to lamasuu and back" was a direct test
of Hypothesis A (auto-scroll bug) vs Hypothesis B
(dedupe). Switching tabs re-mounts the chat with the
agent's full `messagesByAgent[clawsuu]` array. If
"Hey" was in the array, it would show. Since it didn't
show, it's Hypothesis B — the dedupe swallowed the
message before it landed in the array.

## Root cause

`appendAgentMessage` in `HomeScreen.tsx:328` had three
dedupe stages. The third one (added in v3.10.42 to fix
voice-transcript doubling) was:

```js
// Stage 3: same normalized text anywhere in history
// — final defensive dedupe. Normalization strips
// emoji prefixes so the mobile-local vs desktop-echo
// pair dedupes correctly.
if (list.some(m => matchingText(m))) return prev;
```

**No timestamp check.** It matched any historical
message with the same normalized text. The original
intent (v3.10.42) was to catch the mobile-local vs
desktop-echo pair when timestamps drifted far apart
(slow network, STT backlog).

But this also matched against cached messages from
PREVIOUS sessions stored in
`cyberclaw-chat-byagent` localStorage. When Tobe sent
"Hey" the second time (after a previous "Hey" had been
cached), Stage 3 matched the new "Hey" against the
cached "Hey" and dropped it. Both the local append
and the desktop echo got rejected — net result: no
"Hey" anywhere in the chat.

## Fix

Replaced Stage 3 (no time window) with a 5-minute
window:

```js
// Stage 3: same normalized text within 5 minutes —
// catches the mobile-local ↔ desktop-echo pair when
// timestamps drift far apart. 5 minutes is enough
// for the echo round-trip in normal conditions; longer
// than that means it's a fresh send, not an echo.
const dupWindowMsCrossEcho = 5 * 60 * 1000;
if (list.some(m =>
  matchingText(m) &&
  Math.abs(m.ts - msg.ts) < dupWindowMsCrossEcho
)) {
  return prev;
}
```

**The 5-minute window** matches typical echo round-
trips (network + IPC + agent response). Past 5 minutes
we trust that any matching text is a re-send by the
user, not an echo. Tradeoff: a hypothetical >5min
echo round-trip would double-message. In practice
echoes are within seconds.

**The other two stages are unchanged:**
- Stage 1 (60s window) catches within-session echoes
- Stage 2 (1h window) catches cross-restart echoes

Both Stages 1 and 2 require `isUser` match, so they
don't accidentally cross-dedupe a user message
against an agent message with the same text.

## Diagnostic (ruling out other causes)

Before this fix I asked Tobe to switch to Lamasuu and
back. That forces a fresh `setMessages(messagesByAgent[clawsuu])`
from the byAgent bucket. If "Hey" was in messagesByAgent,
it would show. It didn't → ruled out auto-scroll bug,
confirmed dedupe bug.

Other things I checked:
- Desktop log shows `[LOG] 💬 Mobile chat received —
  "[From: Android Phone] Hey"` — message DID reach
  desktop
- Desktop log shows `[RI] [addChatMsg] Broadcasting
  user message to mobile` — desktop DID broadcast
  echo back to mobile
- Chat pipeline ran, agent replied "Hey — back for
  round two..." — that DID appear on mobile

So the only place "Hey" could be lost is in the
mobile's appendAgentMessage dedupe. ✓ Confirmed.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - `appendAgentMessage`: Stage 3 dedupe changed from
    "anywhere in history" (no time window) to "within
    5 minutes" window
- `package.json` — version 3.10.88 → 3.10.89
- `android/app/build.gradle` — versionCode 312→313

## Lessons

**Defensive dedupe needs an explicit time window.**
v3.10.42 added Stage 3 as "final defensive" with no
time window. The author intended it as a catch-all for
echoes, but it also catches re-sends against cached
history. The 1-hour window of Stage 2 was the right
ceiling — anything beyond that is a fresh send, not
an echo.

**"Anywhere in history" is a footgun.** Cache
mechanisms (localStorage, AsyncStorage, IndexedDB)
mean "the history" is not just the current session.
Defensive dedupes that say "anywhere in history"
without a time window will eventually reject legitimate
re-sends. Always pair "same text" with a time window
and an `isUser` check.

**The dedupe's comments told the wrong story.** Stage
3 was originally described as "same text anywhere in
history" for "final defensive" purposes. The actual
behaviour it was catching (mobile-local ↔ desktop-echo
pair) is already handled by Stage 1 and Stage 2. Stage
3 was leftover defensive code that produced false
positives. When refactoring, check what each stage
ACTUALLY catches, not what its comment says it
catches.

**Tab-switch test for "is the data there?"** When
something doesn't appear in the chat, switching tabs
forces a fresh `setMessages(messagesByAgent[currentAgent])`.
If the message was in the array, it'd show. If it
doesn't show after tab-switch, the data isn't in the
array → dedupe or upstream dropped it. Tobe's tab-
switch test conclusively ruled out auto-scroll.