# v3.11.33 — Chat scroll behavior: no auto-scroll + always-start-at-bottom on present

## Summary

Replaces 12 layers of accumulated band-aids around the question "should the
chat auto-scroll on new content?" with a simple, Discord-equivalent rule set.
The chat now only moves when the user moves it (or taps ↓). On opening a new
chat (mount, agent change, quest change), it always starts at the bottom.

## What changed

### 1. Auto-scroll on new messages: REMOVED

The previous `onContentSizeChange` handler accumulated 12 version-tagged
layers of band-aids since v3.1.14 trying to answer a single question:
"should we scroll to the new message?" Every attempt broke a different
edge case (keyboard layout reflows, lazy measurement passes, multi-fire
contentSize, animated scroll jitter, etc.).

The new behavior:
- **No auto-scroll.** New bubbles appear at the bottom of the chat. If
  the user is scrolled up reading history, they stay there. The "↓ N
  new messages" badge becomes the user's signal that new content
  exists below the fold (badge was already wired in v3.10.90).
- **↓ jump-to-bottom button stays.** Already rendered when
  `!chatAtBottom`. Tap → scrollToEnd + clear unread count.

### 2. Always-start-at-bottom on chat present

A new useEffect fires on `(activeChatAgentId, activeChatQuestId,
anchorHydrateTick)` and:
- On the next frame (`requestAnimationFrame`) calls `scrollToEnd` with
  `animated: true` — gives a smooth "settle to the bottom" motion
  matching Discord's cold-channel-open feel.
- Schedules a second pass 250ms later to catch the
  AsyncStorage-hydrate-then-chat-history-replay path where messages
  arrive AFTER the FlatList's first paint.
- Marks `chatAtBottom = true` so the ↓ button doesn't briefly flash.
- Clears the unread count (opening the chat = "caught up").

### 3. Scroll-restore: REMOVED

The previous code persisted per-(agent, quest) scroll offsets to
AsyncStorage and restored them on remount. Tobe's request: always
start at the bottom, regardless of where the user was before.

Deleted:
- `cyberclaw-chat-scroll-byagent` and `cyberclaw-chat-scroll-byagent-byquest`
 AsyncStorage keys (no longer written; old data is left in place for
 backwards-compat and will be naturally overwritten or ignored).
- Per-(agent, quest) offset map (`chatScrollOffsetByAgent` state +
 `chatScrollOffsetRef` mirror).
- Per-(agent, quest) key helper (`chatScrollKey` function).
- Restore-capture refs (`chatRestoreAgentRef`, `chatRestoreQuestIdRef`,
 `chatRestoreOffsetRef`).
- Initial-decision latch (`chatInitialDecisionRef`).
- Once-per-mount layout latch (`chatLayoutSeenRef`).
- AsyncStorage hydrate-of-offset effect (the entire useEffect that
 read the offset keys and migrated v3.10.x → v3.11.x).
- Restore-capture useEffect (reactive capture on agent/quest change).
- tryRestore useEffect (the polling-backoff decision-maker).
- Debounced scroll-save timer (`chatScrollSaveTimerRef`).
- Hydrate-done latch (`chatHydrateDoneRef`).
- Distance-from-end ref (`lastDistanceFromEndRef`).
- Previous-messages-length ref (`prevMessagesLengthRef`).
- Previous-content-height ref (`prevContentHeightRef`).
- Scroll-settle debounce timer (`scrollSettleTimerRef`).
- The `lastProjectedKeyRef`-based bucket-switch hack on the
 projection effect (now redundant since the new useEffect handles
 bucket switches).
- The onScroll write to AsyncStorage.
- The unmount-cleanup path that flushed the debounced scroll-save.
- The onLayout scroll-restore handler.
- All 12 layers of comment-block history describing each band-aid.

### 4. onScroll: SIMPLIFIED

The previous onScroll did two things:
- Wrote the offset to AsyncStorage (debounced) for restore.
- Updated `chatAtBottom` for the ↓ button.

Now it only does the second. ~120 lines of code removed.

### 5. onContentSizeChange + onLayout: NO-OP

Both are now empty arrow functions. The FlatList fires them on every
layout pass — we just don't react.

## Files touched

- `package.json` — version bump 3.11.32 → 3.11.33
- `android/app/build.gradle` — versionCode 426 → 427, versionName
 3.11.32 → 3.11.33
- `src/screens/HomeScreen.tsx` — HomeScreen went from 9282 lines to
 8467 lines (815 lines of scroll-band-aids deleted). Net change:
 simpler, easier to reason about, matches Discord.

## Manual QA
- [ ] Open app: chat starts at the bottom.
- [ ] Switch quests: chat starts at the bottom for the new quest.
- [ ] Switch companion tabs: chat starts at the bottom for the new
 companion.
- [ ] Send a message while scrolled up: chat does NOT auto-scroll;
 ↓ badge appears with count.
- [ ] Tap ↓ badge: chat scrolls to bottom, badge clears.
- [ ] Scroll up: ↓ button (lower-right circular arrow) appears.
- [ ] Tap ↓ button: chat scrolls to bottom.
- [ ] Background app + reopen: chat starts at the bottom (not at
 the previous scroll position).

## Risk

Low. The new behavior is strictly simpler than what it replaces.
The ↓ button + unread badge together preserve all the user's
affordances that the old auto-scroll provided.

The only new behavior (start-at-bottom on quest switch) might feel
disorienting for users who relied on the old restore-on-revisit.
If that turns out to be a problem, the restore logic is easy to
re-add behind a feature flag — but for now we ship the simple
version and listen.

## Rollback

`git revert v3.11.33` restores the previous scroll behavior
exactly. No data migration needed (the deleted keys are
write-only; existing data is harmless if left in place).