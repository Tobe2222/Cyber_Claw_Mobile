# v3.11.6 — Persist `mobileActiveQuestAnchor` to AsyncStorage for cold-start

Tobe (2026-09-24 ~22:19, Discord #cyber-dev):

> "Okey. Now it opened the no quest chat. I then
> clicked quests to see if i was on a quest or not.
> It still said the website quest and when i exited
> quests the chat turned to website chat, which is
> good. But the initial startup chat should be the
> currently selected quest chat also."

## Root cause

The per-device active-quest anchor
(`mobileActiveQuestAnchor`, module-scope) survived
component remounts (v3.11.2) but did NOT survive cold
process starts. On app cold start:

1. Module re-initializes → `mobileActiveQuestAnchor = null`.
2. HomeScreen mounts → `activeChatQuestId = undefined`
   (useState-initialized).
3. Projection effect fires (deps change on mount) →
   reads anchor (null), falls to ref (undefined), sets
   `qid = null` → DEFAULT bucket.
4. First broadcast arrives (~50-200ms later) →
   `onQuestsList` Case 1 fires, seeds anchor to
   whatever the desktop says (website, per the disk).
5. Projection effect re-fires (state changed) → reads
   anchor (now website), shows website bucket. ✓

But step 3 → step 5 is visible — the user sees the
DEFAULT bucket flash before it corrects.

## Fix

### 1. Persist the anchor to AsyncStorage

`setMobileActiveQuestAnchor` now mirrors to the
key `cyberclaw-mobile-active-quest-anchor` (async,
fire-and-forget). `'null'` is encoded as the sentinel
string `'__null__'` so we can distinguish "user
explicitly deactivated" from "never picked yet."

```ts
export function setMobileActiveQuestAnchor(qid) {
  mobileActiveQuestAnchor = qid;
  try {
    if (qid == null) {
      AsyncStorage.setItem(ANCHOR_STORAGE_KEY, '__null__').catch(() => {});
    } else {
      AsyncStorage.setItem(ANCHOR_STORAGE_KEY, qid).catch(() => {});
    }
  } catch (_) { /* defensive */ }
}
```

### 2. Module-init bootstrap

A module-scope IIFE reads the persisted value at
process start and applies it to
`mobileActiveQuestAnchor` before any component
mounts. The read is async (storage round-trip) but
kicks off immediately at module load:

```ts
(async () => {
  try {
    const v = await AsyncStorage.getItem(ANCHOR_STORAGE_KEY);
    let next;
    if (v === null) next = undefined;
    else if (v === '__null__') next = null;
    else next = v;
    if (next !== undefined) {
      mobileActiveQuestAnchor = next;
      notifyAnchorSubscribers(next);
    }
  } catch (_) { /* storage failed */ }
})();
```

### 3. Subscriber re-trigger

HomeScreen subscribes via a new
`subscribeMobileActiveQuestAnchor` API. When the
bootstrap completes, the subscriber bumps a counter
state (`anchorHydrateTick`) that's added to the
projection effect's deps. The effect re-runs with
the now-hydrated anchor and shows the right bucket:

```ts
const [anchorHydrateTick, setAnchorHydrateTick] = useState(0);
useEffect(() => {
  const unsubscribe = subscribeMobileActiveQuestAnchor((qid) => {
    setAnchorHydrateTick(t => t + 1);
  });
  return unsubscribe;
}, []);

// ...projection effect...
}, [activeChatAgentId, activeChatQuestId, anchorHydrateTick]);
```

## Files changed

- `src/screens/HomeScreen.tsx`
  - Module-scope: new `ANCHOR_STORAGE_KEY` constant,
    `_anchorSubscribers` Set, `subscribeMobileActiveQuestAnchor`
    export, module-init IIFE that reads and applies
    the persisted anchor.
  - `setMobileActiveQuestAnchor` mirrors to
    AsyncStorage on every change.
  - `HomeScreen` component: new `anchorHydrateTick`
    state + subscription effect. Both projection
    effects' deps include `anchorHydrateTick`.
- `package.json` — bumped to `3.11.6`.

## Compatibility

- Wire format: unchanged. No new sync messages; the
  anchor is purely local state.
- AsyncStorage key: `cyberclaw-mobile-active-quest-anchor`.
  Existing v3.11.5 installs have no entry; the bootstrap
  falls through to "undefined" and the first broadcast
  seeds the anchor normally. After upgrade to v3.11.6
  + one user pick, the anchor is persisted.
- The trade-off window (~50-200ms) between HomeScreen
  mount and bootstrap completion: the chat shows DEFAULT
  briefly, then re-projects to the right bucket. If
  this becomes a UX issue, the fix is to pre-warm the
  AsyncStorage JSI bridge at native module init (a
  larger change touching the Android Java layer).

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-trace Tobe's repro:
  1. Cold start → module-init IIFE kicks off
     AsyncStorage read.
  2. HomeScreen mounts → projection effect fires with
     anchor=null → DEFAULT bucket (briefly visible).
  3. Bootstrap completes → mobileActiveQuestAnchor =
     website.id → subscriber fires → setAnchorHydrateTick(1)
     → projection re-runs → reads anchor=website → website
     bucket. ✓
- Tag on origin verified with
  `git ls-remote --tags origin | grep v3.11.6` →
  annotated at `cba68a8`.

## This is the 6th fix in the same family

The cross-cutting rule "broadcast is a hint, not a
directive" keeps growing in layers. Each layer closes
a path that the previous layers revealed:

1. Per-device anchor (v3.11.2)
2. Source-tag refinement (v3.11.2 revised)
3. Cache-replay data-only (v3.11.3)
4. Remount-fallback (v3.11.4)
5. Anchor as primary source for projection (v3.11.5)
6. **Cold-start persistence** (v3.11.6 — this)

The shared pattern: **module-scope persistent state
for the user's last-known view-target, with every
reader/writer consulting it.** The latest layer
extends "persistent" from "across component remounts"
to "across process restarts."
