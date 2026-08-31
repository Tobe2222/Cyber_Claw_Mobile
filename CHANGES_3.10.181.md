# v3.10.181 — Chat scroll position restored on HomeScreen remount (Quests → Back)

Tobe (2026-08-31 07:31, Discord #cyber-dev): "the chat seems to
always force scroll to the bottom, even if i just go into quests
and out again it starts up high and Auto scrolls down when i
earlier already had it at the bottom. It should remember its
position so it does not need to do that."

## Background

v3.10.178 fixed the cold-start force-scroll-to-bottom and
documented (in its CHANGES file) that **the Quests→Back case was
intentionally out of scope** because it required either (a) a
larger refactor to hoist the FlatList out of its tab-conditional
mount, or (b) correct handling of the activeChatAgentId-arrives-
late race on remount. The CHANGES doc flagged option (b) as the
minimum-friction fix. v3.10.181 implements option (b) plus one
related unmount-flush that turned out to matter in practice.

The v3.10.178 path was correct for cold starts (activeChatAgentId
synchronously available from the cached agents list). It was
broken for *remounts* — Quests→Back, Wake Mode→Back, Voice
Mode→Back, Settings→Back — for two reasons that compounded into
the visible "starts at top then snaps to bottom" flash.

## Root causes

### 1. The saved offset never got captured on remount

The AsyncStorage hydrate useEffect (added v3.10.126) ran
synchronously on HomeScreen mount. Its capture logic was:

```js
if (activeChatAgentId && cleaned[activeChatAgentId] !== undefined) {
  chatRestoreOffsetRef.current = cleaned[activeChatAgentId];
}
```

On a *cold start*, `activeChatAgentId` was already populated from
the agents-cache hydrate before the offset hydrate ran — so the
capture worked. On a *remount*, both `messagesByAgent` and
`activeChatAgentId` start as `{}` / `null` (HomeScreen fully
unmounted). The offset hydrate ran first, found
`activeChatAgentId === null`, and SKIPPED the capture. The
desktop's `agents_list` broadcast arrived a frame or two later
and set activeChatAgentId, but by then the offset hydrate was
already done and `chatRestoreOffsetRef.current` stayed `null`.

Result: the onLayout tryRestore (gated on `chatHydrateDoneRef`)
polled, saw `chatRestoreOffsetRef.current === null`, and bailed.
The FlatList sat at its natural top.

### 2. The auto-scroll clobbered any hope of restoration

`chatAtBottomRef.current` defaults to `true` on every HomeScreen
remount (line ~904). The `onContentSizeChange` handler does
`if (chatAtBottomRef.current) scrollToEnd()` on every content-
size event. On a remount:

- FlatList mounts with empty data → no contentSize event.
- chat history hydrates → messages populate → FlatList re-renders
  with N items → contentSize changes from 0 to N×rowHeight →
  `onContentSizeChange` fires.
- `chatAtBottomRef.current === true` (default) → `scrollToEnd()`.

That's the "starts at top, then jumps to bottom" flash. It was
masked on cold start because the v3.10.178 restore path *did*
fire `scrollToOffset` in onLayout before the first contentSize
event, but the onContentSizeChange still fired right after and
`scrollToEnd`'d because `chatAtBottomRef` was never updated by
the onLayout restore path (it didn't compute
distanceFromEnd). On remount the restore path bailed, so the
contentSize event was the FIRST thing to move the FlatList, and
it moved it to the bottom.

### 3. The debounced save lost recent scrolls on unmount

The onScroll handler debounces AsyncStorage writes 250ms. If the
user scrolled within 250ms of tapping Quests, the timer never
fired before HomeScreen unmounted and the latest offset never
made it to storage. Next mount: restored from the *previous*
saved offset. Most users hit this only occasionally, but it
meant the saved-position contract was "best effort, eventually
consistent" rather than "what you see is what you get".

## What changed

### 1. Reactive capture of the restore offset

Replaced the synchronous capture in the AsyncStorage hydrate
with a *reactive* capture useEffect that watches
`activeChatAgentId` and runs the capture when it becomes non-null
*after* hydrate has completed. The hydrate itself just loads the
map into `chatScrollOffsetRef.current`; the capture lives
downstream and waits for the right combination.

`HomeScreen.tsx` line ~1180: new `useEffect` keyed on
`activeChatAgentId`. Gated on `chatHydrateDoneRef.current` and
one-shot (latches via the existing
`chatRestoreOffsetRef.current !== null` check).

### 2. Single source of truth for the initial scroll decision

`HomeScreen.tsx` line ~1215: new "initial scroll decision"
useEffect. Fires when **all three** conditions are met:

- `messages.length > 0` (FlatList will render real content)
- `activeChatAgentId != null` (per-agent offset lookup has a key)
- `chatHydrateDoneRef.current === true` (with a polling backoff
  for the rare case where messages hydrate before offset hydrate
  resolves)

Sets a new `chatInitialDecisionRef` latch (one-shot per mount)
and runs the decision:

- `chatRestoreOffsetRef.current` is a real positive number
  → `scrollToOffset(savedOffset)` (twice: once now, once after
    a 300ms settle because FlatList measures lazily). Don't
    pre-compute `chatAtBottomRef` — let the upcoming onScroll
    event update it with the actual contentSize. Pre-computing
    without a known contentSize was unreliable.
- `chatRestoreOffsetRef.current === null`
  → leave the FlatList at its natural top. Set
    `chatAtBottomRef.current = false` so the next
    onContentSizeChange doesn't auto-scroll (Discord default).

### 3. Gate `onContentSizeChange` on the initial decision

`HomeScreen.tsx` line ~5282: `onContentSizeChange` now returns
early if `chatInitialDecisionRef.current === false`. This is
the actual flash fix — until the decision has been made, no
auto-scroll runs, so the FlatList sits at whatever position
the initial decision lands it at. After the decision, the
existing `chatAtBottomRef.current` gate takes over for the
"new incoming message while at bottom → auto-scroll" behaviour
that we want to preserve.

### 4. Defensively slim down the v3.10.178 onLayout path

`HomeScreen.tsx` line ~5397: the onLayout handler still exists
(it's the safety net for the rare race where messages populate
before activeChatAgentId, causing the new useEffect to bail
on `!activeChatAgentId` while onLayout fires). It now:

- Bails immediately if `chatInitialDecisionRef.current === true`
  (the new useEffect already handled it)
- If hydrate is done but the new useEffect hasn't fired yet,
  makes the same decision inline (with the same logic) and
  sets the latch so the new useEffect won't double-fire
- If hydrate is still in flight, defers entirely to the new
  useEffect's polling backoff

No code path can fire the decision twice.

### 5. Unmount-flush the debounced scroll-offset save

`HomeScreen.tsx` line ~1419: extended the existing unmount
cleanup useEffect to:

- `clearTimeout` the pending `chatScrollSaveTimerRef`
- Write the latest `chatScrollOffsetRef.current` to
  `cyberclaw-chat-scroll-byagent` (fire-and-forget)

AsyncStorage writes on unmount are fine: the user is navigating
away, the JS thread is still alive for a tick or two, and the
write is fast on warm devices. Backgrounding the app is out of
scope (AppState change would be a separate hook) but in
practice the navigation flow is the dominant cause.

## Files

`src/screens/HomeScreen.tsx`:
- New `chatInitialDecisionRef` (line ~930)
- Hydrate useEffect (line ~1115) no longer captures
  `chatRestoreOffsetRef` synchronously — only loads the map
- New reactive capture useEffect (line ~1180) — watches
  `activeChatAgentId` after hydrate
- New initial-decision useEffect (line ~1215) — single source
  of truth, fires when messages + agent + hydrate are all ready
- FlatList `onContentSizeChange` (line ~5282) — gated on
  `chatInitialDecisionRef.current`
- FlatList `onLayout` (line ~5397) — defers to the new useEffect
  in the common case; only acts as a safety net
- Unmount cleanup (line ~1419) — flushes the pending scroll
  save to AsyncStorage

`package.json` 3.10.180 → 3.10.181,
`android/app/build.gradle` versionCode 388 → 389,
versionName 3.10.180 → 3.10.181.

## Verification

- `npx tsc --noEmit` reports the same 12 pre-existing
  HomeScreen.tsx errors as v3.10.180. Zero new TS errors.
- The fix is contained to HomeScreen — no other files touched.
- Wire-compatible with the desktop. No sync protocol change.

## Lesson

**Two refs that look equivalent (`activeChatAgentId` state vs
the captured value at hydrate-time) are NOT equivalent when
one is async and the other is sync.** The v3.10.126/v3.10.178
hydrate path captured `chatRestoreOffsetRef` synchronously
inside the async AsyncStorage callback — which means it captured
the *initial* `activeChatAgentId` (always null on remount), not
the eventual value. The closure captured was the wrong value.

The pattern to remember: any "capture X on hydrate" logic needs
to be either (a) synchronous (via Promise.all before the first
render — heavy), or (b) reactive on the dependency it actually
needs (this fix). Option (b) is what we want for cheap async
loads; option (a) only matters if the capture needs to be
visibly synchronous with the first render.

Companion lesson: **debounced writes to persistent storage need
unmount cleanup.** 250ms is fine for "user is scrolling
continuously", terrible for "user scrolls and then taps a
button". Anytime a write is debounced, the cleanup function
should flush it. The cost of the sync write on unmount is
trivial; the cost of losing a write is a confused user.