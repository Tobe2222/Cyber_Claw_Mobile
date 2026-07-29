# v3.10.108 — Sticky thinking indicator across app foreground transitions

**What changed:** The "X is thinking..." bubble
(`chatStatusBar` rendered above the chat input) now
sticks across app foreground transitions instead of
disappearing when the user tabs out and back in. Same
model Discord uses for its typing indicator — once the
desktop says "thinking", the bubble stays until either
an agent reply lands OR the desktop explicitly says
"thinking stopped".

**Why:** Tobe's 2026-07-29 14:13 feedback: "the
clawsuu is thinking still disappears after i went
into another app and back again, even tho i pretty
sure hes thinking or working. It should reappear just
like on discord."

**The bug.** Three layers were involved:

1. The mobile's `onTyping` listener (line 2110)
   received `{active: true/false}` from the desktop
   and set `chatVoiceStatus` and `isThinking` directly.
2. The `useEffect` re-registered listeners on every
   WebSocket reconnect (which happens on every app
   foreground → HomeScreen's effect doesn't unmount,
   but the listener teardown can fire, and any state
   set in the previous mount may be reset by
   remounting).
3. More fundamentally, the desktop that Tobe was
   connecting to was the previous desktop (started at
   13:38) which had a wedged openclaw IPC chain: the
   desktop's renderer-side `sendChatMessage` got past
   the `console.log('dispatching to agent')` line at
   14:00:08 and then hung — no "AI thinking" log, no
   "agent call timed out" log, no "AI responded"
   log. The renderer's JS thread was on the
   `await cyberclaw.chat.sendMessage(...)` line and
   nothing woke it up for >14 minutes. The IPC
   `chat:send-message` in main.js had its 120s
   `exec.timeout`, but the renderer never got past
   the IPC `invoke` (the renderer's await on
   `ipcRenderer.invoke` itself was wedged somehow —
   likely a renderer-thread-blocking synchronous
   operation elsewhere, or memory pressure).
4. Since the renderer never got past the
   `sync-broadcast-typing: true` IPC, the mobile
   never received any `{active: true}` either. The
   mobile's local `isThinking` defaulted to `false`,
   so the bubble was never visible — there was
   nothing to "disappear".
5. When the user foregrounded the app, the WebSocket
   reconnect fired the chat-history pull, which made
   the user message re-appear (with its attachments,
   thanks to v3.10.107). But the typing indicator
   stayed at `false` because the renderer's
   `typing:true` IPC never landed.

**The fix.** Two parts:

**Part A — sticky ref.** A `thinkingStickyRef` is
now set to `true` inside `onTyping` whenever the
desktop sends `{active: true}`, and cleared when
the desktop sends `{active: false}` OR when an
agent message lands in `appendAgentMessage`. The
`chatVoiceStatus` is recomputed from this ref on
app foreground (`AppState.active`), so the bubble
comes back when the user returns. This is the
visible behaviour change Tobe is asking for.

**Part B — desktop recovery.** The previous wedged
desktop was restarted fresh (separate action; not
part of this release). v3.2.37 added the main-side
safety rails (90s `Promise.race` on the openclaw
call in `sendChatMessage`, `finally` block for
typing cleanup, 110s `setTimeout` failsafe). Those
were deployed an hour before this fix, but they
didn't help because the renderer's `await` itself
was wedged — the main-process IPC never even got
to fire its timeout. The next level of defense
(renderer watchdog that forces a reload) is
plausible but out of scope; for now, restarting
the desktop recovers the chat pipeline.

**Where:**
- `src/screens/HomeScreen.tsx`:
  - `thinkingStickyRef` declaration (lines ~656-666)
  - `onTyping` sets/clears the flag (lines ~2120)
  - `goingForeground && wasBackground` block
    re-applies the bubble (lines ~1647-1663)
  - `appendAgentMessage` clears the flag on agent
    message (lines ~1982-1990)

versionCode: 332
