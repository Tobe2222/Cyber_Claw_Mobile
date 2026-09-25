# v3.11.7 — Cold-start race: replay anchor to subscribers registered after bootstrap

Tobe (2026-09-25 12:01, Discord #cyber-dev):

> "@Clawsuu Okey updated and tested. I still started
> with the no quest chat on startup, even tho i had
> website quest active. It refreshes to the correct
> after i go into quests and out again"

Two screenshots: first one shows the chat scrolled
into the legacy/DEFAULT bucket (the pre-v3.11.0
messages with the "No Quest" pill), with v3.11.6 in
the topbar. Second one (after navigating into Quests
and back) shows the correct website quest bucket with
three Clawsuu → CYBERHIVE_WEBSITE V3 messages.

## Root cause

The v3.11.6 bootstrap IIFE had a race window between
module-load and HomeScreen's first effect run:

```
T0  Module load → IIFE kicks off AsyncStorage.getItem
T1  HomeScreen mounts → first render commits
T2  Projection effect fires with anchor=null → DEFAULT
    bucket rendered
T3  HomeScreen effects run → subscribe() registers
    the subscriber
T4  AsyncStorage.getItem resolves (fast on Hermes —
    often <50ms, sometimes within a single frame)
T5  notifyAnchorSubscribers fires
```

If T4 happens BEFORE T3 — i.e. the storage round-trip
beats React's first effect — the Set is empty at T5,
no React state update fires, and `anchorHydrateTick`
stays at 0 forever. The projection effect never
re-runs. The chat stays on the DEFAULT bucket that the
projection effect picked on first render.

The v3.11.6 author was aware of the trade-off window
(see CHANGES_3.11.6.md "The trade-off window (~50-200ms)
between HomeScreen mount and bootstrap completion: the
chat shows DEFAULT briefly, then re-projects to the
right bucket") but assumed the bootstrap would always
finish AFTER the subscriber registered. On Hermes
with a pre-warmed JSI bridge, AsyncStorage can be
fast enough to resolve inside the first frame, before
React commits effects. That breaks the assumption.

Tobe's repro proves this is the bug, not a transient
flash: his chat stays on the no-quest view across the
entire session. Navigating into Quests and back
triggers `handleSetActive` (or a HomeScreen remount),
which re-seeds the projection via the fresh `activeChatQuestId`
and `anchorHydrateTick` deps, so the chat fixes
itself.

## Fix

Add a `_anchorBootstrapResolved` flag that the IIFE
sets when it finishes (regardless of whether a value
was found). The subscribe function then checks the
flag: if the bootstrap already resolved, replay the
current `mobileActiveQuestAnchor` value to the new
subscriber so React gets a re-render trigger.

```ts
let _anchorBootstrapResolved = false;

export function subscribeMobileActiveQuestAnchor(fn) {
  _anchorSubscribers.add(fn);
  if (_anchorBootstrapResolved) {
    try { fn(mobileActiveQuestAnchor); } catch (_) {}
  }
  return () => { _anchorSubscribers.delete(fn); };
}

(async () => {
  try {
    const v = await AsyncStorage.getItem(ANCHOR_STORAGE_KEY);
    let next;
    if (v === null) next = undefined;
    else if (v === '__null__') next = null;
    else next = v;
    if (next !== undefined) {
      mobileActiveQuestAnchor = next;
    }
  } catch (_) { /* storage failed */ }
  _anchorBootstrapResolved = true;
})();
```

### Why replay instead of e.g. awaiting the bootstrap

Awaiting would require `subscribeMobileActiveQuestAnchor`
to become async, which forces every caller to handle
a Promise. The subscriber is registered inside a
React `useEffect` whose return value is the cleanup —
making it async breaks the synchronous return contract.

The replay-on-subscribe pattern is also more robust:
any future subscriber (QuestsScreen, App.tsx, etc.)
gets the right initial value regardless of when it
registers relative to the bootstrap.

### Why set the flag in the `try`/`finally` shape

The previous version only mutated state inside the
`if (next !== undefined)` branch. That meant a
first-run install (no persisted value, `next ===
undefined`) would leave the flag conceptually
"unresolved" — which doesn't matter for replay (we
don't want to replay `undefined` to a fresh subscriber;
the first broadcast will seed Case 1 anyway), but the
inconsistency was confusing when reading the code.

The new version wraps the AsyncStorage read in
try/catch and unconditionally sets the flag at the
end. Success path: flag is true after the read. Error
path: flag is true after the catch. Either way, future
subscribers know the IIFE has finished and can decide
to replay based on the current anchor value.

### Race-conditions closed

| Scenario | Before v3.11.7 | After v3.11.7 |
| --- | --- | --- |
| Bootstrap resolves BEFORE subscribe | notify fires on empty Set, no re-projection. User sees DEFAULT forever. | Subscribe replays the current anchor to the new subscriber. Projection effect re-runs with the right qid. ✓ |
| Bootstrap resolves AFTER subscribe | notify fires on populated Set, subscriber fires, projection re-runs. ✓ | Same. ✓ |
| Bootstrap fails (storage error) | notify never fires, no re-projection. User sees DEFAULT forever if anchor was persisted. | Subscribe replays `mobileActiveQuestAnchor` (still null from module init) on flag set. `setAnchorHydrateTick(1)` fires. Projection runs but with qid=null → DEFAULT (matches "haven't picked yet" semantics). The next broadcast seeds Case 1. ✓ |
| Bootstrap returns no value (first install) | Same as failure path. | Same as failure path. The "first install" case has no persisted value to replay, so `fn(undefined)` would be a no-op anyway. ✓ |
| User explicitly deactivated (persisted `'__null__'`) | Bootstrap restores `null`, but the projection effect already ran with `qid=null` on first render — same result. The user gets DEFAULT, which is what they want. ✓ | Same. The replay would call `fn(null)`, which still bumps `anchorHydrateTick`, which re-projects to DEFAULT. Same outcome, but with an explicit re-render cycle. ✓ |

## Files changed

- `src/screens/HomeScreen.tsx`
  - New module-scope flag `_anchorBootstrapResolved`
    (default `false`, set `true` at the end of the IIFE).
  - `subscribeMobileActiveQuestAnchor` now replays the
    current anchor value to the new subscriber if the
    bootstrap has resolved.
  - The IIFE's notify call moved out of the
    `if (next !== undefined)` branch; the flag is now
    set unconditionally at the end.
- `package.json` — bumped to `3.11.7`.
- `android/app/build.gradle` — `versionCode 403`.

## Compatibility

- Wire format: unchanged. No new sync messages; the
  anchor is purely local state.
- AsyncStorage key: `cyberclaw-mobile-active-quest-anchor`.
  Same as v3.11.6. Existing v3.11.6 installs that have
  a persisted value continue to work — the new flag
  just means the replay happens on subscribe instead of
  via the (often-missed) notify call.
- No new dependencies.

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-trace Tobe's repro:
  1. Cold start → module-init IIFE kicks off
     AsyncStorage read.
  2. HomeScreen mounts → projection effect fires with
     anchor=null → DEFAULT bucket (briefly visible).
  3a. **Bootstrap completes before subscribe registers**
     (the race path): IIFE sets
     `_anchorBootstrapResolved = true` and assigns
     `mobileActiveQuestAnchor = website.id`.
  3b. **HomeScreen's useEffect runs**: subscribe is
     called. The new replay path checks the flag (true)
     and immediately calls `fn(website.id)`. The
     subscriber bumps `anchorHydrateTick`. Projection
     effect re-runs with `qid = website` → website
     bucket. ✓
  OR
  3a'. **Bootstrap completes after subscribe registers**
     (the happy path): notify fires on a populated
     Set, subscriber bumps `anchorHydrateTick`,
     projection re-runs with `qid = website`. ✓
- Either way, the user sees the correct bucket on
  cold start. The transient DEFAULT flash from
  v3.11.6 is also gone in the race path because the
  projection re-fires immediately on subscribe, not
  50-200ms later.

## This is the 7th fix in the same family

The cross-cutting rule "broadcast is a hint, not a
directive" keeps growing in layers. Each layer closes
a path that the previous layers revealed:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. Cold-start persistence (v3.11.6)
7. **Replay-on-subscribe** (v3.11.7 — this)

The shared pattern across all seven:
**module-scope persistent state for the user's
last-known view-target, with every reader/writer
consulting it.** The latest layer extends "every
reader" to "every reader, regardless of when it
registers."

**Diagnostic tell-tale for "race between module
bootstrap and React effects":**

- User picked a value once.
- Persisted value is on disk (verified via
  AsyncStorage dump).
- Cold start still shows the wrong bucket.
- Going into Quests and back fixes it (forces a
  re-read via remount or `handleSetActive`).
- The wrong bucket is the legacy DEFAULT bucket,
  not a randomly-selected quest bucket.

The "going into Quests and back fixes it" is the
specific tell-tale. That confirms the module-scope
variable is correct (otherwise going into Quests
wouldn't help). The issue is that the React
projection effect doesn't get re-triggered by the
bootstrap's notify.