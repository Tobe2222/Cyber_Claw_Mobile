# v3.11.10 — distinguish "bootstrap pending" from "user deactivated" via _anchorBootstrapResolved

Tobe (2026-09-25 20:14, Discord #cyber-dev):

> "@Clawsuu hmm. There is still times when i open
> the app where it loads the no quest chat Instead
> of the one i have selected, so i have to go into
> quests and back out to get the correct one."

After v3.11.9 the bug is still intermittent. Same
"go into Quests and back fixes it" pattern, which
indicates the projection effect's correct render is
working post-remount — but something during cold
start is racing ahead of it.

## Root cause

There are TWO paths that read "anchor is null" as
"show DEFAULT bucket" without distinguishing
"bootstrap pending" from "user explicitly
deactivated":

### Path 1: `onChatHistory` handler

```ts
// v3.11.9
if (mobileActiveQuestAnchor === null) {
  setMessages(loaded);  // legacy DEFAULT bucket content
}
```

The v3.11.9 check was correct for "user has
explicitly deactivated" but wrong for "bootstrap is
pending."

On a slow first start (AsyncStorage.getItem takes
>300ms on Hermes with cold JSI bridge), chat_history
fires before the bootstrap reads the persisted
anchor. At that moment, `mobileActiveQuestAnchor`
is `null` (module-scope, set by bootstrap which
hasn't run yet). v3.11.9's check succeeds, and
`setMessages(loaded)` runs with the legacy DEFAULT
bucket content.

The projection effect's deps don't include the
chat_history event, so it doesn't re-fire to undo
the clobber. When the bootstrap completes shortly
after, the subscriber bumps `anchorHydrateTick` and
the projection effect re-runs — but by that point
the chat-history clobber may have already committed,
or the re-render's `setMessages([])` may have lost
the race against the messagesByAgent DEFAULT bucket
that chat_history populated.

### Path 2: projection effect's else branch

```ts
} else if (activeQuestRef.current !== undefined) {
  qid = activeQuestRef.current?.id ?? null;
} else {
  qid = null;
}
// later:
const bucketKey = questKeyForStorage(qid);  // null → DEFAULT_QUEST_KEY
const bucket = agentBuckets[bucketKey] || [];  // DEFAULT bucket content
setMessages(bucket);
```

If anchor is null AND activeQuestRef is undefined
(fresh useRef on a fresh mount), qid becomes null,
bucketKey becomes DEFAULT, and the lookup returns
the DEFAULT bucket content if chat_history populated
it in the gap.

## Fix

Both paths now check `_anchorBootstrapResolved`
first. Bootstrap pending → empty render (don't fall
through to the legacy DEFAULT lookup). Bootstrap
resolved → existing behavior (anchor === null means
user deactivated → DEFAULT is correct).

### `onChatHistory` (path 1)

```ts
if (_anchorBootstrapResolved && mobileActiveQuestAnchor === null) {
  setMessages(loaded);
}
```

### projection effect (path 2)

```ts
let qid: string | null;
let skipBucketLookup = false;
if (mobileActiveQuestAnchor !== null && mobileActiveQuestAnchor !== undefined) {
  qid = mobileActiveQuestAnchor;
} else if (!_anchorBootstrapResolved) {
  // Bootstrap pending. Show empty; bootstrap will
  // resolve and re-run via setAnchorHydrateTick.
  qid = null;
  skipBucketLookup = true;
} else if (activeQuestRef.current !== undefined) {
  qid = activeQuestRef.current?.id ?? null;
} else {
  qid = null;
}
// ...
const bucket = skipBucketLookup ? [] : (agentBuckets[bucketKey] || []);
setMessages(bucket);
```

## Files changed

- `src/screens/HomeScreen.tsx`
  - `onChatHistory`: gate tightened from
    `mobileActiveQuestAnchor === null` to
    `_anchorBootstrapResolved && mobileActiveQuestAnchor === null`.
  - Projection effect: added `skipBucketLookup`
    flag that fires when anchor is null AND
    bootstrap is pending; forces empty bucket
    instead of falling through to DEFAULT.
- Bumps: `package.json` 3.11.9 → 3.11.10.
- `versionCode` 405 → 406, `versionName` "3.11.9"
  → "3.11.10".

## Diagnostic tell-tale for layer 10

- User has a quest active on desktop, anchor is
  persisted correctly.
- Cold start shows the legacy DEFAULT bucket content
  despite the bootstrap reading the right anchor.
- Going into Quests and back fixes it (forces a
  remount where the bootstrap has already resolved
  and the race is gone).
- The bug is intermittent — sometimes cold start
  works, sometimes it doesn't.

The "intermittent" + "works on remount" combination
is the smoking gun. It means a race between the
bootstrap IIFE and one of the WS-driven handlers
(`onChatHistory`, projection effect, agent_history,
etc.).

## Compatibility

- Wire format: unchanged.
- No new dependencies.
- Behavior change: when the user has explicitly
  deactivated (anchor === null AND bootstrap
  resolved), everything works the same as before.
  When the bootstrap is pending and the user has a
  quest to load (anchor === null but won't stay
  null), the chat now shows empty until the
  bootstrap resolves — instead of showing legacy
  DEFAULT content. This is consistent with the
  v3.11.8 / v3.11.9 fixes (other paths already
  show empty during bootstrap-pending).

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-traced all four timing windows:
  - **Cold start, bootstrap slow (>300ms)**:
    - chat_history fires at 300ms. anchor=null.
      v3.11.9 would setMessages(loaded). v3.11.10
      sees _anchorBootstrapResolved=false → skip
      setMessages. messages stays at [] (initial
      render) or whatever the projection effect had
      set previously.
    - Bootstrap completes shortly after. anchor=
      'database'. subscriber bumps tick. Projection
      re-runs. messages = messagesByAgent['companion']
      ['database-key'] || [] = [] (or content if
      agent_history populated it).
    - **No more leakage.** ✓
  - **Cold start, bootstrap fast (<300ms)**:
    - Bootstrap completes first. anchor='database'.
      subscriber bumps tick. Projection re-runs.
      messages = [].
    - chat_history fires at 300ms. v3.11.10 sees
      _anchorBootstrapResolved=true, anchor='database'
      (not null) → skip setMessages. messages stays
      at [].
    - **No leakage.** ✓
  - **Cold start, first run (no persisted anchor)**:
    - Bootstrap completes with null. anchor stays
      null. _anchorBootstrapResolved=true.
    - chat_history fires. v3.11.10 sees both true →
      setMessages(loaded). User sees DEFAULT bucket
      (which is what "no quest active" means).
    - **Correct behavior.** ✓
  - **Cold start, user explicitly deactivated
    ('__null__' persisted)**:
    - Bootstrap completes with null. anchor=null.
      _anchorBootstrapResolved=true.
    - chat_history fires. v3.11.10 sees both true →
      setMessages(loaded). User sees DEFAULT bucket.
    - **Correct behavior.** ✓

## This is the 10th fix in the chat-flash family

The cross-cutting rule has expanded to:

> "Every reader/writer of `messages` and every
> bucket-key lookup must distinguish 'anchor is
> null because bootstrap pending' from 'anchor is
> null because user deactivated.' The
> `_anchorBootstrapResolved` flag is the source of
> truth for this distinction."

Full family:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. Cold-start persistence (v3.11.6)
7. Replay-on-subscribe (v3.11.7)
8. Seed-fallback data-only (v3.11.8)
9. onChatHistory reads the anchor (v3.11.9)
10. **Bootstrap-pending is distinct from
    user-deactivated** (v3.11.10 — this)

**Lesson (added to MEMORY.md):**

When a "null" value has two meanings ("haven't
decided yet" vs "explicitly set to null"), you
need a separate flag to distinguish them. The
tri-state `string | null | undefined` was supposed
to handle this (undefined = pending, null =
explicit, string = value), but in practice most
code checks `=== null` which conflates both.

The fix: introduce an explicit
`_anchorBootstrapResolved` boolean (set by the
bootstrap IIFE) and check it alongside `anchor`
whenever the distinction matters.

**Diagnostic checklist for future chats showing
wrong bucket on cold start:**

1. Is the anchor persisted? (AsyncStorage dump.)
2. Is the bootstrap reading it? (v3.11.6/7.)
3. Does the projection effect re-run with the
   correct anchor? (v3.11.7 fix.)
4. Are the AsyncStorage hydration paths not
   clobbering? (v3.11.8 fix.)
5. Are ALL setMessages call sites reading the
   anchor instead of `activeChatQuestId` state?
   (v3.11.9 fix.)
6. Does every "anchor is null" check distinguish
   bootstrap-pending from user-deactivated? (v3.11.10
   fix.)

If the answer to 6 is "yes" and the bug still
happens, look for paths I haven't audited. Two
possible next suspects if this isn't enough:

- WS reconnect: when the mobile WS reconnects
  after a network blip, the desktop replays
  cached state. The mobile's listeners may treat
  these as fresh and mutate state in ways that
  conflict with the anchor. (Already partially
  addressed by v3.11.3 cache-replay data-only,
  but not for all listeners.)
- WebView hot-reload: if Metro/React Native
  re-runs the JS bundle while the app is in
  foreground, the module-scope state is wiped but
  the React tree persists. This is a partial
  reset that's hard to detect.