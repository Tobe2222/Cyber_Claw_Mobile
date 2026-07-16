# v3.10.33 — Remove "Arena ready" overlay + settle/cue on first voice-mode turn

Tobe (post v3.10.32):

> "We can remove the arena ready log text which appears in the arena
> and voice mode now. And i tested voice mode. This time we said hi
> back and forth and after the companion said hi it turned to response
> shortly after which gave me no room for my turn"

## 1. "Arena ready" overlay removed

`arena.html` is loaded by BOTH the home screen AND the wake/voice
mode screen (which passes `?mode=wake`). On load, the WebView's
`loadCatalog()` function called `setStatus('Arena ready', 'ok')`,
which set the `#status` div's textContent to "Arena ready" and
then a `setTimeout` cleared it 2.5s later.

In the home arena, this was a brief green status indicator at
the top — functional but noisy. In wake/voice mode the same
status text appeared at the top of the screen as "log text"
Tobe didn't want competing with the voice-mode status overlay
("YOUR TURN" / "Responding…" / etc.).

### Fix

1. **Removed the `setStatus('Arena ready', 'ok')` call** in
   `loadCatalog()`. The success path now silently sends the
   `arena_loaded` notification to React Native. The RN side
   already uses this event to know when the arena is ready —
   the user-visible status overlay was redundant.

2. **Removed the cleanup `setTimeout`** that auto-cleared
   "Arena ready" after 2.5s — no longer needed since we don't
   set the text in the first place.

3. **Added `body.wake-mode #status { display: none }`** to the
   CSS. Even if a future code path writes to `#status` during
   wake/voice mode (e.g. a JS error that triggers `setStatus(
   'JS error: ...', 'error')`), it won't appear over the
   voice-mode UI. Error paths in the home arena still surface
   normally because the rule only applies when the
   `wake-mode` body class is set (which only happens for
   wake/voice mode).

## 2. Settle delay + turn cue before the first recording turn

Tobe's voice-mode timing report (same message):

> "we said hi back and forth and after the companion said hi it
> turned to response shortly after which gave me no room for my turn"

### Root cause

The multi-turn loop in `onAudioResponse.afterPlayback` already
had a 4-second `RESPONSE_SETTLE_DELAY_MS` plus `playTurnCueAndWait`
before re-opening the recorder. This gave the audio HAL buffer
time to drain (MediaPlayer's OnCompletionListener fires when
the player's internal buffer is drained, but the speakers still
have ~100-300ms of buffered audio on them) and gave the user a
clear audio signal that the mic was about to be live.

The FIRST voice-mode turn — after the greeting ("Ready to chat")
— did NOT have this protection. The voice-mode entry effect
called `await speak(greetingText)` and then immediately called
`startRecordingTurn()`. The recorder started while the audio
HAL still had the tail of the greeting on the speakers.

What Tobe experienced:
1. Opens voice mode → "Ready to chat" greeting plays
2. Recorder starts IMMEDIATELY (no settle, no cue)
3. The recorder picks up the tail of the greeting audio —
   RMS > 0.010 → `recorderHasUserSpoken = true`
4. The silence window starts ticking from the END of the
   greeting tail
5. Tobe says "hi" within ~1s — silence window starts over
6. Tobe pauses to think about the next turn → silenceMs
   (6000ms) of silence → countdown (5s) → ~11s after the
   greeting, another response fires
7. Tobe feels like "the companion said hi, then immediately
   turned to response again" — the response-to-recording gap
   was effectively zero because the silence window was
   already mid-countdown by the time the greeting audio
   finished draining

### Fix

In `src/screens/WakeModeScreen.tsx` voice-mode entry effect,
before calling `startRecordingTurn()` after the greeting:

1. **Wait `RESPONSE_SETTLE_DELAY_MS` (4000ms)** for the
   audio HAL buffer to drain (same constant the multi-turn
   loop uses).
2. **Play the turn-cue sound** so the user gets a clear
   audio signal that the mic is about to be live (same
   `playTurnCueAndWait()` the multi-turn loop uses).
3. **Extract `RESPONSE_SETTLE_DELAY_MS` to module scope** so
   both the first-turn path and the multi-turn loop share
   the same constant. If we ever bump it again, both paths
   get the bump automatically.

The settle + cue are best-effort wrapped in try/catch — if
either fails (e.g. the cue asset failed to load), the
recording turn must still start.

### Why this matches the multi-turn loop

The same `RESPONSE_SETTLE_DELAY_MS` + `playTurnCueAndWait()`
pair was added to the multi-turn loop in v3.10.8/9 to fix
Tobe's reports about the cue sound interrupting speech at
the end and the post-response silence firing too soon. The
first turn had the SAME problem for the SAME reason (audio
HAL buffer drain delay), but the fix only landed for
turns-after-the-first. v3.10.33 lands the same fix for the
first turn.

## 3. Voice-mode chat history now visible in the chat tab

Tobe (same message):
> "i also noticed that that conversation is not in the chat for some
> reason. All voice mode chats should appear in the chat aswell."

(Same root cause and fix landed in **desktop v3.2.9** for the
source-of-truth shape; this change is the mobile-side defensive
fallback so cross-version pairings work too. See
`cyberclaw/CHANGES_3.2.9.md` for the desktop details.)

### Root cause (recap)

The desktop's `mobile-request-agent-history` IPC handler sent
back `chatHistoryByAgent[agentId]` entries in the internal
desktop shape `{type, text, name, emoji, ts}` — which has NO
`isUser` field. The mobile's `onAgentHistory` mapped each entry
with `isUser: m.isUser` (undefined), and `renderMessage`'s guard
(`typeof item.isUser === 'boolean'`) silently rejected every
loaded message as an empty `<View />`. Voice-mode sessions are
captured while WakeModeScreen is active (so HomeScreen can't
persist them locally); the only path for them to appear in the
chat is the desktop's agent_history replay on next HomeScreen
mount — which is exactly the broken path.

### Fix

Added defensive fallback in `HomeScreen.onAgentHistory`:

```js
isUser: typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user'),
agentId: m.agentId || m.name || aid,
agentName: m.agentName || m.name || null,
```

If the desktop sends the new normalized shape
(`{text, isUser, agentId, agentName, ts}` — desktop v3.2.9+),
these fallbacks are no-ops. If the desktop is older and still
sends `{type, text, name, emoji, ts}`, the fallbacks recover
the right values and the chat renders correctly.

The desktop fix in v3.2.9 is the source-of-truth change —
this mobile change is defense in depth so a mobile-only update
still works against an older desktop.

## Files

- `android/app/src/main/assets/arena.html` (loadCatalog + CSS rule)
- `src/screens/WakeModeScreen.tsx` (voice-mode entry effect +
  `RESPONSE_SETTLE_DELAY_MS` extracted to module scope)
- `src/screens/HomeScreen.tsx` (`onAgentHistory` defensive
  fallback for legacy desktop shape)
- `package.json` 3.10.32 → 3.10.33
- `android/app/build.gradle` versionCode 258 → 260, versionName 3.10.33