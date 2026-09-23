# v3.11.1 — Chat visibility race fix + Claude-style thinking bar

Tobe (2026-09-23 16:24, Discord #cyber-dev), 2026-09-23 — two
issues reported against the v3.11.0 chat:

> "i noticed a weird behaviour in the chat of cyberclaw.
> Picture might not explain much but the thing is that i dont
> recieve clawsuus replies before i send something myself, then
> right as i send the reply appears above my text. And i saw chat
> change behaviour this last time, indicating that a new reply
> had landed i think, but it did not appear."
>
> "Also, see if you can improve the clawsuu is thinking. Its still
> a little wonky and disappears sometimes shortly after i sent
> something when i know hes thinking or working. It never said
> working either, but i guess working and thinking are very
> similar, but it would be cool to have it like claude has its
> web interface where you see the actions more or less also."

## What changed

### Bug fix: chat reply doesn't render until the next user send

**Root cause.** In v3.11.0's `appendAgentMessage` helper, the
projection from `messagesByAgentAndQuest` (the canonical
per-(agent,quest) bucket store) into the flat `messages`
list (the FlatList's `data`) had a guard:

```ts
if (agentId === activeAgentId && activeQuestId !== undefined &&
    (activeQuestId === null ? questId === null : activeQuestId === questId)) {
  setMessages(next[agentId][bucketKey]);
}
```

The guard was meant to prevent a stale reply from a different
quest's bucket from clobbering the visible chat. But it was
over-strict and dropped the projection in two real cases:

1. **`activeChatQuestId === undefined`** (initial state, before
   the first `quests_list` broadcast from the desktop). The
   user was already chatting in the default bucket and a reply
   came in. The guard's `activeQuestId !== undefined` clause
   failed, so `setMessages` was skipped — the bucket got the
   message but the visible chat stayed stale.
2. **`activeChatQuestId === '<some-quest-id>'`** but the incoming
   reply was stamped with `null` (e.g. a ref/state race where
   `activeQuestRef.current` was still null when the `onChat`
   listener captured it). The guard's
   `activeQuestId === questId` clause failed (string vs null),
   so the projection was skipped again.

In both cases the bucket got the new message but the visible
flat list stayed stale — until the user sent their next
message, at which point `sendMessage()` ran through the same
guard (now passing because the active quest had settled) and
re-projected the bucket, including the missing reply. That's
exactly Tobe's screenshot: my 4:19 PM reply pops in above
Tobe's 4:20 PM "Ja" message, but only AFTER Tobe pressed Send.

**Fix.** Project from the **active** bucket, not the
message's bucket:

```ts
if (activeAgentId != null) {
  const activeBucketKey = questKeyForStorage(
    activeQuestId === undefined ? null : activeQuestId
  );
  const activeBucket =
    (next[activeAgentId] || {})[activeBucketKey] || [];
  setMessages(activeBucket);
}
```

The active bucket is the projection target regardless of where
the incoming message landed. If the message went to the active
bucket, the projection picks it up. If it went to a different
bucket (stale cross-quest reply), the active bucket is
unchanged so the projection is a no-op re-render at worst. The
stale reply sits in its own bucket and shows up next time the
user switches back.

### Bug fix: thinking indicator wipes on cross-bucket reply

**Root cause.** v3.10.108 wired `setChatVoiceStatus(null)`
into the agent-message branch of `onChat` so the
"Clawsuu is thinking..." indicator clears when a reply lands.
That works for the single-bucket world, but the desktop
emits typing=true/false **per-agent**, not per-quest — so a
late Quest A reply landing while the user is on Quest B
would clear Quest B's waiting indicator even though the user
is still waiting for their own quest's reply. Tobe's second
complaint: the indicator "disappears sometimes shortly after
i sent something when i know hes thinking or working".

**Fix.** Gate the indicator clear on the same
(active-bucket-match) check used in the projection fix:

```ts
const replyBucketKey = questKeyForStorage(
  incoming.activeQuestId === undefined ? null : incoming.activeQuestId
);
const activeBucketKey = questKeyForStorage(
  activeChatQuestId === undefined ? null : activeChatQuestId
);
const replyIsForActiveBucket =
  aid === activeChatAgentIdRef.current &&
  replyBucketKey === activeBucketKey;
if (replyIsForActiveBucket) {
  // ...clear thinking ref, timer, state
}
```

If the reply is for a non-active bucket, the sticky flag and
escalation timer stay armed — the indicator remains up until
the user actually gets a reply for THEIR active conversation.

### UX: Claude-style thinking bar with action log

The previous indicator was a single 12px italic line
("Clawsuu is thinking..."). Tobe asked for something more
like claude.ai's web UI — visible affordance for what the
agent is actually doing.

**v3.11.1 thinking bar:**
- **Pulsing dot.** An 8dp orange circle that scales 0.7 → 1.15
  and pulses opacity 0.35 → 1.0 on a 1.2s loop. Uses
  `Animated.loop` with `useNativeDriver: true` so the OS keeps
  it ticking without re-rendering React.
- **Fade in/out.** The whole bar cross-fades over 180ms when
  `chatVoiceStatus` flips null ↔ non-null, instead of popping
  in and out instantly. Driven by a second `Animated.Value`
  (`indicatorOpacity`) and a watcher useEffect on
  `chatVoiceStatus`.
- **Action log.** A new `chatActions: string[]` state holds
  the last 3 `agent_tool` events' `friendly` field. When the
  agent calls exec, read, etc., the user sees:
  ```
  ● Clawsuu is thinking...
    • Reading file notes.md
    • Running command ls -la
    • Writing file output.txt
  ```
  Older actions fade to 0.55 opacity so the most recent one
  pops. The list resets to empty when a new turn starts (the
  off→on transition of `chatVoiceStatus`).

**Why the action log is empty for now.** The desktop's
`onToolCall` callback in `main.js` is currently suppressed
for non-Discord sessions (see v3.2.25) — the comment says
"the mobile's chat panel should not react to activity from
conversations the user isn't having in the app." But that
distinction applies to Discord-routed sessions, not
mobile-initiated chats. The mobile-initiated chat pipeline
calls the gateway at `/v1/chat/completions` and never
surfaces tool calls. Surfacing tool events for mobile-routed
chats is a separate piece of work (the chat pipeline doesn't
see tool names because the gateway wraps them).

The mobile-side infra is fully wired up here: `onAgentTool`
already exists at line ~3620, `syncClient.on('agent_tool',
onAgentTool)` is already subscribed, `appendTaskStep` is
already called per tool, and the new `chatActions` state is
populated by `onAgentTool`. As soon as the desktop starts
emitting `agent_tool` events for mobile-routed chats, the
bar will start showing actions without any mobile changes.

## Files changed

- `src/screens/HomeScreen.tsx`
  - `appendAgentMessage` (line ~627): replaced the
    active-bucket-match guard with an
    active-bucket-keyed projection.
  - `onChat` (line ~3209): gated the
    `setChatVoiceStatus(null)` clear on the same
    active-bucket match.
  - `onAgentTool` (line ~3620): pushed each tool's
    friendly text into the new `chatActions` rolling
    list (max 3).
  - State additions: `chatActions`, `thinkPulse` (Animated
    Value), `indicatorOpacity` (Animated Value).
  - Effects: pulse loop, status-watcher for cross-fade
    + actions reset on off→on.
  - JSX: re-rendered `chatStatusBar` with pulsing dot +
    optional action log row.
  - Styles: `chatStatusBar`, `chatStatusRow`,
    `chatStatusDot`, `chatStatusText`, `chatActionsRow`,
    `chatActionText`, `chatActionTextFaded`.

- `CHANGES_3.11.1.md` — this file.

## Compatibility

- Sync protocol: unchanged. The new shape (`agent_tool`
  event) is the same wire format the desktop already uses
  for Discord-routed sessions.
- Voice mode + wake mode: untouched. The voice-mode status
  overlay (`voiceStatusOverlay`) is a separate component
  with its own state and is unaffected by these changes.
- iOS / Android: both supported. `Animated` with
  `useNativeDriver: true` works identically on both
  platforms for opacity + transform animations.
- Quests + per-quest chat: fully compatible with v3.11.0.
  The fix is a tightening of v3.11.0's projection guard,
  not a replacement.