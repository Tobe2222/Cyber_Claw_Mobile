# v3.10.177 — diagnostic bubbles for errors and timeouts on long agent runs

Tobe (2026-08-28 11:28, Discord #cyber-dev): "i would like it to give a small
log of what has been done and where it errored or timed out when such
things happens. Let the user know much more, since i know he started
the work but got cut off when the task is long"

Tobe (2026-08-28 11:51, same channel): "to be clear, this is ONLY for
errors" — no badges or extra UI on successful replies, just richer
detail when things go wrong.

The screenshot Tobe sent shows a long task ("make repos for each
software, folder for each, update the website") that the desktop's
chat pipeline terminated with `Error: agent CLI exited with code 1`.
The mobile showed exactly one line: `Error: agent CLI exited with
code 1`. No duration, no steps done, no indication of where it
failed, no recovery action. Just "the agent died".

## What changed

The mobile now captures a "task session" around every agent run
(from user-send → reply or error) and renders a structured error
card on the resulting bubble **only when the agent failed or
timed out**. Successful replies render exactly as before — no
extra footer, no badge, no log spam.

### Structured error / timeout bubble

When the desktop sends an error-prefixed agent message (the existing
`addChatMsg('error', 'Error: ...')` path), the mobile now classifies
the failure and renders a structured card below the raw error text:

- **⏱️ Model timed out** — error text mentions `timeout` or `timed out`
- **💥 Model crashed** — `exited with code N` or `agent CLI`
- **🌐 Network error** — `HTTP request failed` / `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT`
- **⚠️ Error** — fallback for everything else

The card shows:
- Category + duration (`failed after 2m 13s`)
- `N steps completed before failure:` with up to 6 captured events
  (e.g. "sent chat to desktop", "agent reply arrived", "tool: ...")
  — this is the "what was done" part of Tobe's request, surfaced
  as the partial-work record before the failure
- **↻ Retry** button — primes the input with the captured request
  text and re-fires `sendMessage` after a 300ms delay so the user
  can cancel by tapping the input if they want to edit.
- **📋 Copy details** — copies a structured summary
  (category / duration / error text / steps list) to the clipboard so
  the user can paste it into a bug report.

The error text itself is preserved above the card — no information
lost.

### Inline error bubble for `send_error` events

Previously, `send_error` IPC events (e.g. audio_input when the
mobile-to-desktop WS is down) only showed up as a status line. Now
they also render as a chat bubble with the same structured error
card, including any steps captured before the connection failed.

## How the task session capture works

A `TaskSession` is opened:
- in `sendMessage()` right after the typed-send log line, with the
  user's request text, agent id, and agent name
- as a safety net in `onTyping()` for voice-mode paths that don't
  go through `sendMessage()` (audio sent, transcribed by the
  desktop, then `typing:true`)

While the session is open, `addLogEntry()` mirrors each new entry
into the session's step list, mapping common log patterns to short
labels ("sent chat to desktop", "agent reply arrived", "voice mode
opened", etc.). Unknown errors and warnings are captured with their
raw text so the steps list reflects anything that went sideways.

The session is closed:
- on a non-user `chat` event (agent reply landed) → status `done`,
  no summary attached
- on a `chat` event with `Error:` text → status `failed`, classified
  by category, `taskSummary` attached to the bubble
- on a `send_error` IPC event → status `failed`, error category
  defaults to `network` for connection errors, `error` otherwise,
  mirrored error bubble rendered

All task state lives at module scope (pattern from v3.10.120's
`chatDraft` and v3.10.133's `thinkingEscalateTimerRef`) so the
session survives `HomeScreen` unmount when the user navigates to
Settings or Wake Mode while the agent is still working.

## What this does NOT do (yet)

- **No per-tool progress events from the desktop's in-app chat
  pipeline.** The desktop's OpenClaw session-tail watcher (in
  `openclaw-session-tail.js`) currently only emits `agent_tool`
  events for Discord-routed sessions, and the chat-pipeline path
  suppresses those broadcasts per the v3.2.25 fix. When the
  desktop re-enables tool-broadcasts for in-app pipelines (planned
  follow-up), the mobile's `onAgentTool` listener is already wired
  and will start producing per-step entries automatically. Until
  then, the "steps completed before failure" list reflects the
  mobile-side lifecycle events (typing, send, reply arrival) which
  are captured locally.
- **No retry that resumes the in-flight session.** Retry re-fires
  the original user message from scratch — a fresh task session,
  not a continuation. Resuming a partial session would require
  the desktop to support session resume + state replay, which is
  out of scope here.
- **No 60s log marker.** Tobe clarified this is for errors only;
  we removed the long-task log marker that v3.10.177 originally
  added. Successful long tasks remain silent — the existing
  30s/90s/4min thinking-bubble escalation (v3.10.133) is
  unchanged.

## Files

`src/screens/HomeScreen.tsx`:
- New module-scope `TaskSession` / `TaskStep` types and helpers
  (`startTaskSession`, `closeTaskSession`, `appendTaskStep`,
  `stepLabelFromLogEntry`)
- `addLogEntry()` mirrors into the active session inline
- `sendMessage()` opens a session on tap
- `onTyping()` opens a session as a safety net
- `onChat()` classifies errors, closes the session, attaches
  `taskSummary` to the resulting bubble (via state update on
  `messagesByAgent` + flat `messages`). Successful replies close
  the session but attach no summary.
- `onSendError()` closes the session as failed and renders a
  mirrored error bubble
- New `renderMessage` block: structured error card (category +
  duration + steps + Retry + Copy) for failed bubbles only.
  Successful bubbles render normally with no extra UI.
- New styles (`taskErrorCard`, `taskErrorHeader`, `taskStepsBlock`,
  `taskStepLine`, `taskActionsRow`, `taskActionButton`,
  `taskActionText`)

No desktop changes required — everything reads the existing
`addChatMsg('error', ...)` text and the existing `chat` event wire.

## Verification

- `npx tsc --noEmit` reports the same 12 pre-existing errors as
  `v3.10.176` HEAD — zero new TS errors.
- `npx eslint src/screens/HomeScreen.tsx` shows no new error
  categories introduced. The `task*` styles appear in the existing
  `useCallback` dependency warning that was already firing for
  the other styles.

## Lesson

**When asked for diagnostic detail, scope the change to the failure
path — don't add any UI on the success path.** Tobe's 2026-08-28
follow-up "to be clear, this is ONLY for errors" corrected the
v3.10.177 first cut which had a small success-badge footer. The
correct interpretation of "give a small log of what has been done
and where it errored" is:
- on failure: show the partial-work record + recovery actions
- on success: render normally, no extra UI

The general pattern: a UI affordance that's only useful in one
state shouldn't appear in the other state, even subtly. A
"worked through N steps in Xm Ys" badge on a successful reply
looks harmless, but it's a chime — and chimes are noise on the
99% success path. Keep the bubble for the user's reply; save the
recap for the moment it actually adds value (i.e. when the agent
didn't make it).

