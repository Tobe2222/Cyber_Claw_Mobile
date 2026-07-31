# v3.10.117 — Quests page: explicit ↻ Refresh button

## The report

Tobe (Discord #cyber-dev 2026-07-31 14:58 GMT+2):

> "we need to add a refresh button in the quest page.
> Clawsuu on mobile swears he has created a quest but i see
> nothing on mobile. Fix that and push latest please"

The bug: the chat pipeline confirmed a quest creation, but
the Quests page showed nothing. The mobile's `quests_list`
broadcast handler relies on the desktop's WebSocket
broadcast landing at the right time. If the broadcast
arrived before the Quests screen mounted, or was missed
entirely (network blip, race condition between
`create_quest` ack and the subsequent broadcast), the
mobile shows an empty list — even though the quest is
definitely on the desktop.

The existing `syncClient.requestQuestsList()` method
already does the right thing (sends a `request_quests_list`
WebSocket message; the desktop answers with the canonical
list). It was just never wired to a user-visible trigger.

## What ships

A `↻ Refresh` button in the Quests page header, next to
`+ New`. When tapped:

1. Calls `syncClient.requestQuestsList()` — same call as
   the mount-time useEffect, just user-initiated.
2. The button label switches from `↻ Refresh` to `⏳ …`
   and dims to 70% opacity, so the user has a visual
   cue that something's happening.
3. The spinner stops on either:
   - **(a) the `quests_list` broadcast arrives** — early
     success, cleared inside the existing handler. This
     is the normal path; the desktop usually replies
     within ~100ms.
   - **(b) a 2s safety timeout** — fallback for the
     desktop being offline or slow. Without this, a
     missed broadcast would leave the spinner spinning
     forever.
4. Double-tap guard — tapping while a refresh is
   already in flight is a no-op.

## Why a button instead of an automatic re-poll

Alternatives considered and rejected:

- **Auto-poll every N seconds** — wastes battery, wastes
  bandwidth, and clutters the WebSocket traffic. The
  normal path (broadcast on every CRUD) works fine; the
  refresh button is the escape hatch for the rare miss.
- **Pull-to-refresh on the list** — would have worked,
  but Tobe's bug was "I don't even know there's a problem
  to pull from" — pull-to-refresh is invisible until
  you notice the list is wrong. An always-visible button
  in the header is more discoverable.
- **Make the broadcast retry logic smarter on the
  desktop side** — better long-term, but Tobe needs the
  fix now and this is 90 lines of code, not a week-long
  backend investigation.

## Files

- `src/screens/QuestsScreen.tsx` — added:
  - `refreshing` state + `refreshingRef` mirror
  - `refreshTimerRef` for the 2s safety timeout
  - `handleRefresh()` action handler
  - Early-stop logic in the existing `quests_list`
    broadcast handler
  - Ref-sync useEffect for `refreshing` → `refreshingRef`
    (same pattern as `editorOpenRef` / `detailRef`)
  - Header `↻ Refresh` button in a new
    `headerActionsCluster` row that groups `+ New` and
    `↻ Refresh` on the right side of the header
  - 5 new StyleSheet entries (cluster, button, button
    text, active state)
  - Cleanup of the safety timeout in the existing
    useEffect's return (prevents setRefreshing on
    unmounted component)

## Race conditions handled

The `quests_list` broadcast handler lives inside a
`useEffect` with empty deps (per the v3.7.6 architecture
that predates v3.10.117). This is the same stale-closure
trap that the v3.8.0 `editorOpenRef` / `detailRef`
pattern exists for. v3.10.117 follows the same pattern:

- `refreshingRef` mirrors the `refreshing` state via a
  small `useEffect([refreshing])` so the broadcast
  handler can read the latest value without going stale.
- `refreshTimerRef` lets the handler cancel the safety
  timeout early when the broadcast arrives.

Without these refs, the early-stop logic would either
run with a stale `refreshing === false` (and never
trigger) or leak the timer past the screen unmount.

## Pre-push checks (all green)

- `npx react-native bundle --platform android --dev false`
  → no parse errors
- `npx tsc --noEmit` → 0 new errors (baseline 79
  unchanged; the 1 pre-existing `insets possibly
  undefined` error in QuestsScreen.tsx just shifted line
  number because of the additions above it)
- Module-scope free-variable grep on bundle → 0
  suspicious references (the v3.10.113 bug class)

## Lessons

1. **Always-visible affordances > invisible ones for
   recovery from network races.** Pull-to-refresh is
   elegant but discoverable only when you know the list
   is wrong. A header button is always visible and self-
   documenting ("refresh" is a recognizable verb even
   without UI conventions).

2. **A safety timeout beats a permanent spinner for
   user-initiated async actions.** If the desktop goes
   offline mid-refresh, the user would be stuck watching
   `⏳ …` forever. The 2s fallback is a UX contract:
   "this button will always stop spinning within 2s, no
   matter what". Better to spin less and lose a possible
   late-confirmation than to spin forever.

3. **Mirror state into refs when an effect-with-empty-
   deps handler needs to read the latest value.** This
   is the v3.8.0 pattern. Every time I add a new
   state-driven UI affordance that needs to coordinate
   with the broadcast handler, I have to add the ref
   mirror. It's repetitive but the alternative (reading
   state from a closure) is a guaranteed bug.

4. **The actual root-cause bug (broadcast race) is still
   there.** v3.10.117 papers over it with a user escape
   hatch. The proper fix is server-side: have the desktop
   re-broadcast on a missed-ack signal, or have the
   mobile mark broadcasts as "expected but not received"
   and request them proactively. Out of scope for this
   fix; tracked as a future improvement.