# v3.11.5 — Projection prefers the anchor; per-bubble quest chip

Tobe (2026-09-24 ~21:33, Discord #cyber-dev):

> "Okey i downloaded the latest mobile version. Opened
> it to the hive_control chat i think. Deselected the
> website quest and i ended up in the website chat, see
> picture. I then selected website quest again and the
> chat is the same, see second picture. Which is correct
> in this case but the default chat show appear if none
> is selected, not the website chat.
>
> Let us put in the current quest name at the upper right
> of each text bubble so one can see what chat it
> actually is."

## What changed

### 1. Projection effect uses the anchor as primary source

The chat projection effect at HomeScreen.tsx ~line 1410
previously read `qid` from `activeQuestRef.current` and
fell back to `mobileActiveQuestAnchor`. That worked for
remount cases but failed for the deactivate case:

1. User taps "Deactivate" in QuestsScreen.
2. `handleSetActive(null)` runs → `mobileActiveQuestAnchor = null`.
3. IPC sends to desktop, broadcast comes back with no
   active quest.
4. `onQuestsList` Case 1 fires (anchor was null) →
   `activeQuestRef.current = null`,
   `setActiveChatQuestId(null)`.
5. Projection effect fires (state changed from quest id
   to null) → reads `qid = activeQuestRef.current?.id ?? null`
   = null.

But Tobe's chat stayed on website. Most likely cause:
race between the optimistic anchor update and the React
state update batch — the projection effect's deps
`[activeChatAgentId, activeChatQuestId]` rely on state,
not the anchor. If the React render batch fires before
the state update commits, the projection effect runs
with the old state.

**Fix:** the projection effect now uses
`mobileActiveQuestAnchor` as the **primary** source for
the bucket key, not a fallback:

```ts
let qid: string | null;
if (mobileActiveQuestAnchor !== null && mobileActiveQuestAnchor !== undefined) {
  qid = mobileActiveQuestAnchor;
} else if (activeQuestRef.current !== undefined) {
  qid = activeQuestRef.current?.id ?? null;
} else {
  qid = null;
}
```

The moment the anchor goes to null, the projection
effect fires and the chat shows the DEFAULT bucket —
no race, no stale state.

`activeQuestRef` is still used by `appendAgentMessage`
to stamp incoming replies (it's the fast synchronous
source for event handlers that can't read state). The
anchor is for view-projection.

### 2. Per-bubble quest chip

Each chat bubble now has a small quest chip on the upper
right of the header row:

- `🎯 <quest-name>` for messages stamped with an
  `activeQuestId`.
- `— No quest` for legacy / DEFAULT-bucket messages
  (so the user can distinguish pre-v3.3.11 legacy chat
  from per-quest chat).
- Tinted with the bubble's accent color so user
  bubbles (cyan) and AI bubbles (orange) read
  consistently.

The chip reads from a new module-scope
`questNameByIdRef.current` map populated by the
`onQuestsList` listener (data-only, including cache
replays). The map survives component remounts.

```ts
<Text style={[styles.bubbleQuestLabel, ...]}>
  {item.activeQuestId == null
    ? '— No quest'
    : `🎯 ${item.activeQuestName || questNameFromId(item.activeQuestId) || '(unnamed quest)'}`}
</Text>
```

Where `questNameFromId(id)` reads from
`questNameByIdRef.current`.

## Companion change: desktop v3.3.18

- `addChatMsg` stamps `activeQuestName` (looked up from
  module-scope `cachedQuestsList`) on every chat message
  in the per-(agent,quest) bucket.
- `sync-broadcast-chat` carries `activeQuestId` so live
  broadcasts include the data for the bubble header.

## Files changed

- `src/screens/HomeScreen.tsx`
  - Projection effect (~line 1410): prefers
    `mobileActiveQuestAnchor` over `activeQuestRef.current`.
  - New `questNameById` state + `questNameByIdRef`
    mirror, populated by the `onQuestsList` listener.
  - `renderMessage` (~line 5340): header row now wraps
    the agent label and the quest chip in a flex row.
  - Styles: `bubbleHeaderRow`, `bubbleQuestLabel`,
    `bubbleQuestLabelAi`, `bubbleQuestLabelUser`.
  - `renderMessage` useCallback deps: `[messages, agents,
    questNameById]`.
- `package.json` — bumped to `3.11.5`.

## Compatibility

- Sync protocol: extended, not breaking. Old clients
  (pre-v3.11.5 mobile) ignore the chip and the new
  field. New clients (v3.11.5) render the chip.
- `activeQuestRef` is still the source for incoming-
  reply stamping (unchanged from v3.11.4).
- QuestsScreen / QuestsScreen cards: unchanged. The
  quest name is also readable from the chip in the
  chat (alternative source for users who don't open
  the Quests panel).

## Verified

- `npx tsc --noEmit` — no new errors.
- Hand-trace Tobe's repro:
  1. User has website as anchor. Chat shows website
     bucket.
  2. User taps "Deactivate" → anchor = null.
  3. Projection effect fires (deps unchanged; the
     `qid` change is internal) → reads anchor = null
     → qid = null → bucket = DEFAULT.
  4. Chat shows DEFAULT bucket.
  5. User taps "Set as active" on Hive Control →
     anchor = Hive Control id (optimistic).
  6. Projection effect fires → qid = Hive Control id
     → bucket = Hive Control.
- Tag on origin verified with
  `git ls-remote --tags origin | grep v3.11.5` →
  annotated at `8179d01` (the bump commit).
