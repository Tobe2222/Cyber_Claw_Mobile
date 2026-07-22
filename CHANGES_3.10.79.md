# v3.10.79 — Chat auto-sync + inline quest steps on cards

Two bugs from Tobe on 2026-07-22:

1. **Chat bug:** "the companion tab says new message but
   it does not appear in the chat before i Click the
   red notification in the companion tab. It should
   just appear in the chat."

2. **Quest page bug:** "i noticed the steps dont appear
   in the quest page. Those should be listed there."

Both fixed in v3.10.79.

## Fix 1: Chat auto-sync on activeChatAgentId change

**Root cause:** `setMessages` was only called in two
places: (1) `appendAgentMessage` when a message arrived
for the currently-active agent, and (2) `switchToAgent`
when the user tapped a tab. Several code paths set
`activeChatAgentId` directly (most notably the
agents-list boot update at line 2361) WITHOUT going
through `switchToAgent`. After those paths ran, the
visible `messages` view was left pointing at the WRONG
agent's chat — Tobe's UI highlighted Clawsuu but
`messages` still held Lamasuu's chat (or was empty).
When a new Clawsuu reply arrived, the badge incremented
(looked like "new message") but the chat didn't show it
because `messages` wasn't synced.

**Fix:** add a `useEffect` that syncs `messages` to
`messagesByAgent[activeChatAgentId]` whenever
`activeChatAgentId` changes:

```js
useEffect(() => {
  if (activeChatAgentId == null) return;
  const bucket = messagesByAgentRef.current[activeChatAgentId] || [];
  setMessages(bucket);
}, [activeChatAgentId]);
```

We depend on `activeChatAgentId` only (not
`messagesByAgent`) to avoid the loop where adding a
message causes `messagesByAgent` to change, which
re-runs this effect, which calls `setMessages` again
with the same content. We use the ref to read the
latest bucket without subscribing.

## Fix 2: Inline step list on quest cards

**Root cause:** the quest card only showed the progress
text ("1/2") and a progress bar. The actual list of
steps lived in the detail modal (tap-to-open). Tobe had
to tap each card to remember what was left.

**Fix:** render the first 3 goal steps inline on the
card, with the checkbox + text inline. Completed
steps get a strikethrough; pending steps are normal.
If there are more than 3 steps, show "+N more (tap card
for full list)" hint:

```jsx
{goals.length > 0 && (
  <View style={styles.questSteps}>
    {goals.slice(0, 3).map((g, i) => (
      <Text style={[styles.questStepText, g.completed && styles.questStepCompleted]}
        numberOfLines={1}>
        {g.completed ? '☑' : '☐'}  {g.text}
      </Text>
    ))}
    {goals.length > 3 && (
      <Text style={styles.questStepMore}>
        +{goals.length - 3} more (tap card for full list)
      </Text>
    )}
  </View>
)}
```

Added `questSteps`, `questStepText`,
`questStepCompleted`, `questStepMore` styles.

## Files changed

- `src/screens/HomeScreen.tsx` — new useEffect that
  syncs `messages` to `messagesByAgent[activeChatAgentId]`
  on agent change
- `src/screens/QuestsScreen.tsx` — inline steps list
  + matching styles
- `android/app/build.gradle` — versionCode 302→303,
  versionName 3.10.77→3.10.79
- `package.json` — version 3.10.77→3.10.79

## Lessons

**When `useState` and `useRef` represent the same
data, they can drift.** The component has both
`activeChatAgentId` (state, drives UI) and
`activeChatAgentIdRef.current` (ref, drives event
handlers). If either can change without the other,
the system has two sources of truth. The
"messages" state was a SECOND derivative that
wasn't auto-synced to activeChatAgentId — so when
the active agent changed in some paths, messages
didn't follow. Adding a useEffect to sync them
eliminates the drift.

**SyncEvent handlers and render state are different
lifecycle.** The ref pattern works well for event
handlers (read latest value at handler time), but it
doesn't help render state. The lesson: when render
state needs to depend on changing inputs, use useEffect
to keep it synced. Don't rely on the "synchronous
recompute" that the developer thought would happen
when the input changed.

**Inline > detail-modal when the data is small.** For
3 steps, a tap-to-detail modal is overhead. Inline
display is faster, more glanceable, and avoids modal
amnesia (forgetting what's in there). Reserve detail
modals for content that's actually too big to fit
inline.