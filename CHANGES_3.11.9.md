# v3.11.9 — onChatHistory was reading activeChatQuestId (state, undefined on cold start) instead of the anchor

Tobe (2026-09-25 16:32, Discord #cyber-dev):

> "@Clawsuu i updated mobile app and started it
> again. Still started with no quest chat even tho i
> had database active on desktop and mobile."

After v3.11.8 (seed-fallback fix), the bug was still
present. The user has a quest active on both desktop
and mobile. The persisted anchor is correctly
restored by the bootstrap. Yet the chat shows the
legacy "no quest" DEFAULT bucket on cold start.

## Root cause

The mobile's `onChatHistory` handler — invoked when
the desktop responds to `request_chat_history` (sent
300ms after WebSocket auth) — had this gate from
v3.11.0:

```ts
if (
  activeChatQuestId === undefined ||
  activeChatQuestId === null
) {
  setMessages(loaded);
}
```

The intent: surface the legacy DEFAULT bucket
content into the visible chat ONLY when no specific
quest is active. The implementation: use
`activeChatQuestId` state as the gate.

On cold start, `activeChatQuestId` is `undefined`
(useState initial value) until the desktop's first
`quests_list` broadcast lands. The handler fired
~300ms after auth, often before the first broadcast.
With the gate reading `undefined`, the condition
succeeded and `setMessages(loaded)` ran with the
legacy DEFAULT bucket content.

The bootstrap (v3.11.6/7) had already set
`mobileActiveQuestAnchor = 'database'` by this point
(via the module-init IIFE's AsyncStorage read), but
the handler was reading the wrong variable —
`activeChatQuestId` state — instead of the anchor.

The projection effect's deps don't include the
chat_history event, so it didn't re-fire to undo
the clobber. User saw the DEFAULT bucket content
with no quest attribution, even though they had a
quest active.

This is the same family of bugs as the v3.11.8
seed-fallback issue: a path that reads
`activeChatQuestId` (which is `undefined` on cold
start) instead of the persistent anchor (which is
the source of truth). The v3.11.0 author didn't
have the anchor yet, so used the state. The anchor
is now the correct gate.

## Fix

Read `mobileActiveQuestAnchor` (the module-scope
anchor, set synchronously by the bootstrap or by
`handleSetActive`) instead of `activeChatQuestId`
state. The anchor is the source of truth.

```ts
if (mobileActiveQuestAnchor === null) {
  setMessages(loaded);
}
```

Edge case: when `anchor === null` (user has explicitly
deactivated), the chat_history's DEFAULT bucket
content is what the user wants to see — they have no
quest active. Same as v3.11.8's seed-fallback logic.

When `anchor !== null` (user has a specific quest
active, whether set by handleSetActive or restored
from bootstrap), the legacy DEFAULT bucket content
is NOT relevant to their active-quest view. The
projection effect's prior render stands — if the
active quest's bucket has content, that's what's
shown; if it's empty, the user sees an empty chat
(consistent with v3.11.8).

## Files changed

- `src/screens/HomeScreen.tsx`
  - `onChatHistory`'s gate changed from
    `activeChatQuestId === undefined || null` to
    `mobileActiveQuestAnchor === null`.
- Bumps: `package.json` 3.11.8 → 3.11.9.
- `versionCode` 404 → 405, `versionName` "3.11.8"
  → "3.11.9".

## Diagnostic tell-tale for layer 9

- User has a quest active on desktop.
- Anchor is correctly persisted (verified via
  AsyncStorage dump or by the fact that going into
  Quests and back fixes it).
- Mobile cold start shows the DEFAULT bucket
  (pre-v3.11.0 messages with no quest attribution).
- The chat_history handler ran on cold start.

The handler ran early (before the first quests_list
broadcast) because the desktop replies to
`request_chat_history` 300ms after auth. That's the
tell-tale.

## Compatibility

- Wire format: unchanged.
- No new dependencies.
- The change only affects what `setMessages` is called
  with inside `onChatHistory`. If the anchor is set,
  we no longer clobber `messages` with the legacy
  DEFAULT bucket content. Users who explicitly
  deactivated (anchor === null) still see the
  legacy DEFAULT bucket, same as before.

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-traced the timing:
  - Cold start, anchor='database' persisted.
  - Module init IIFE sets anchor='database' (within
    a few ms of process start).
  - HomeScreen mounts.
  - agents_list arrives ~50-200ms later.
    - Projection effect runs. Reads anchor='database'.
      messagesByAgent['companion']['database']
      doesn't exist yet → []. setMessages([]).
  - chat_history arrives ~300ms after auth.
    - With v3.11.9's fix: anchor='database', not null.
      Don't setMessages. Projection's prior
      `setMessages([])` stands.
  - quests_list arrives shortly after (broadcast
    from desktop, source='broadcast').
    - Case 2 fires (anchor matches broadcast).
      setActiveChatQuestId('database').
      Projection re-runs. Same as above: setMessages([]).
  - Final state: messages=[]. Empty chat (or
    active quest bucket content if any arrived
    earlier via seed or agent_history).

  Previously (v3.11.0–v3.11.8):
  - chat_history arrives ~300ms after auth.
    - With OLD check: activeChatQuestId === undefined
      (state hasn't been set yet). Condition
      succeeds. setMessages(loaded). messages =
      DEFAULT bucket content.
  - quests_list arrives. setActiveChatQuestId fires.
    Projection effect re-runs with anchor='database',
    setMessages([]).
  - But: React batches and prioritizes — the
    setMessages from chat_history may have already
    committed and won the race, especially if the
    chat_history's setMessages happened just before
    the projection's re-render and the projection's
    new render's setMessages([]) was a no-op because
    React skipped it due to `prev.length > 0` guard.
    Actually, React doesn't have that guard inside
    setMessages([]) — it always calls. So projection
    effect SHOULD override.
  - But timing-dependent. Sometimes projection
    fires first (correct), sometimes chat_history
    fires later (and clobbers, since the projection
    effect's deps don't fire again until something
    changes).

## This is the 9th fix in the chat-flash family

The playbook now has 9 layers. The cross-cutting rule
keeps growing: "every reader/writer of `messages`
consults the anchor." Layer 9 closes the
`onChatHistory` handler, which was the last
prominent setMessages call site that was reading
`activeChatQuestId` state instead of
`mobileActiveQuestAnchor`.

Full family:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. Cold-start persistence (v3.11.6)
7. Replay-on-subscribe (v3.11.7)
8. Seed-fallback data-only (v3.11.8)
9. **onChatHistory reads the anchor** (v3.11.9 — this)

**General pattern emerging across all 9 layers:**
the persistent module-scope anchor is the source of
truth; every code path that picks a chat bucket
should consult it. State mirrors of `activeChatQuestId`
are unreliable on cold start (they're `undefined`
until the first quests_list broadcast), so any check
that uses state will be wrong on cold start.

The fix is always the same shape: replace
`activeChatQuestId === null` with
`mobileActiveQuestAnchor === null` (or check `!==
null` to mean "has a quest active").

**Diagnostic checklist for future chats showing
wrong bucket on cold start:**

1. Is the anchor persisted? (`grep the AsyncStorage
   key` or verify by going into Quests and back.)
2. Is the bootstrap reading it? (v3.11.6/7.)
3. Is the projection effect re-running with the
   correct anchor? (v3.11.7 fix.)
4. Are the AsyncStorage hydration paths not
   clobbering? (v3.11.8 fix.)
5. Are ALL setMessages call sites reading the anchor
   instead of `activeChatQuestId` state? (v3.11.9
   fix.)

If the answer to 5 is "yes" and the bug still
happens, look for another path I haven't audited.
The chat_history legacy path was the smoking gun
for this iteration; the next one might be elsewhere.