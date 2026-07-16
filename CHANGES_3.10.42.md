# v3.10.42 — Normalize text in dedupe so voice transcripts no longer double

Tobe (post v3.10.41, screenshot:

```
Clawsuu  Lamasuu

[ You ] Left the buttons a little, now the worker list units are
bigger than necessary. Just put the buttons right under
connect etc.

And Hive stuff goes into the same section.

11:12 PM

[ You ] [From Android Phone] Left the buttons a little, now the
worker list units are bigger than necessary. Just put
the buttons right under connect etc.

And Hive stuff goes into the same section.

11:12 PM
```

> "the chat still has double texts."

## Root cause

Tobe's v3.10.17 dedupe was `(text === msg.text && Math.abs(ts_diff)
< 30s)`. The 30s window was supposed to catch within-session
echoes. Two things break it:

1. **Prefix mismatch.** Mobile's voice-mode local add at
   `src/screens/HomeScreen.tsx:2071` builds
   `localUserMsg.text = msg.transcript` (raw transcript). The
   desktop's `addChatMsg('user', msg.transcript)` at
   `src/js/app.js:4099` prepends `` `🎤 ${transcript}` ``
   before pushing into the per-companion history and
   broadcasting the chat event. The two `text` fields
   therefore differ by exactly 2 chars (`` `🎤 ` ``), and
   strict equality `m.text === msg.text` returns false.

2. **Cross-restart timestamp skew.** Tobe's mobile
   `cyberclaw-chat-byagent` AsyncStorage cache survives
   desktop restarts with yesterday's `ts` values intact.
   When the desktop boots fresh, its `chatHistoryByAgent`
   is empty, but `agent_history` requests pull the
   persisted localStorage copy on the desktop side, which
   mixes yesterday's `ts` with today's. A message cached
   from a session yesterday, with mobile `ts = 23:00`,
   surfaces again after a desktop restart, today, alongside
   `ts = 09:00`. The 30s defensive window misses.

## Fix

**Dedupe by NORMALIZED text.** Strip leading non-alphanumeric
chars (emojis, `[From X]` prefixes, whitespace) before
comparing. Same text on both sides after normalization = dup.

```ts
const normalize = (s) => (s || '').replace(/^[^\w[\(]+/, '').trim();
```

A new three-stage dedupe ladder:

1. `matchText && same isUser && ts_diff < 60s` — within-
   session echo (most common).
2. `matchText && same isUser && ts_diff < 3600s (1h)` —
   cross-restart within 1 hour.
3. `matchText` — final catch-all: identical text anywhere
   in the per-agent chat history is treated as a duplicate.

In practice, stage 3 is what catches the voice-mode
local-vs-echo pair (normalization strips the `🎤 ` prefix
on the desktop echo so it matches the raw `text` the
mobile added locally). Stage 1 catches timed repeats.
Stage 2 catches the cross-restart replay window.

The 60s/1h windows are generous on purpose — Tobe's chat
sessions are conversational, not rapid-fire; a 60s
within-session window catches the local-vs-echo pair
without dropping distinct messages that happen to share
text across longer sessions.

## Files

- `src/screens/HomeScreen.tsx` — `appendAgentMessage`'s dedupe
  ladder rewritten with normalized-text compare + 1-hour
  defensive window + unconditional catch-all.
- `package.json` 3.10.41 → 3.10.42
- `android/app/build.gradle` versionCode 268 → 269,
  versionName 3.10.42

## Side effects

- **Voice-mode doubled transcripts** (the symptom Tobe
  reported): resolved. The normalization strips the `🎤 `
  prefix the desktop prepends in `addChatMsg('user', ...)`
  at `src/js/app.js:4099`, so the mobile-local add and the
  desktop echo deduplicate correctly.

- **Cross-restart re-replay of cached messages**: deduped
  via stage 2's 1-hour window.

- **Possible edge case**: a user who genuinely sends the
  exact same long message within 1h of an older identical
  message gets the second one suppressed. No data loss
  in practice (the user can re-send). The stage 3
  unconditional match prevents both same-text user bubbles
  from coexisting across the whole session.

- **No server-side / desktop-side change required**: this
  is a pure-mobile dedupe fix. The desktop can keep its
  emoji-prefixed `addChatMsg` for the on-desktop renderer
  (which doesn't dedupe). The mobile normalizes before
  comparing, so the difference doesn't leak through.