# v3.11.34 — Chat input draft persists per (agent, quest)

## Summary

Each chat conversation now remembers its own in-progress text
independently. Switching between companion tabs OR between quests
swaps the visible input to that conversation's draft — Discord-style.

## Behavior change

Before:
- One global input draft (module-scope `chatDraft: string`).
- Survived Settings nav (the v3.10.120 feature).
- Did NOT survive conversation switches: typing "foo" in Quest A
 then switching to Quest B clobbered "foo" with whatever B had
 (usually empty).

After:
- Per-(agent, quest) draft map (module-scope
 `chatDraftByKey: Record<string, string>` keyed by
 `${aid}::${qid}`).
- Survives Settings nav AND survives conversation switches.
- Each conversation has its own draft that persists until sent
 or until the user clears it.
- When a quest resolves (activeChatQuestId → null), the draft for
 the no-quest bucket takes over. The now-ended quest's draft
 becomes unreachable (intentional — that chat is gone).

## Implementation

- Module-scope `chatDraft` (single string) →
 `chatDraftByKey` (Record) + `chatDraftKey(aid, qid)` helper.
- `getChatDraft()` (no-arg) → `getChatDraft(aid, qid)`.
- `setChatDraft(s)` (one-arg) → `setChatDraft(aid, qid, text)`.
 Empty text deletes the key (keeps the map sparse).
- New refs `draftAidRef`, `draftQidRef` mirror the active
 conversation. The `setInputText` wrapper reads from these
 refs (not from state) so it always writes to the right slot
 even when called from event listeners that may have stale
 closures.
- New effect `chatDraftSyncEffect` watches
 `(activeChatAgentId, activeChatQuestId)` and:
  a) Mirrors them into `draftAidRef` / `draftQidRef`.
  b) If the conversation ACTUALLY changed (compared via
     `lastDraftKeyRef`), re-syncs `inputText` state from the
     new conversation's draft. No-op re-renders (e.g.,
     messages-state changes) don't clobber what the user is
     typing.

## Files touched

- `package.json` — version bump 3.11.33 → 3.11.34
- `android/app/build.gradle` — versionCode 427 → 428, versionName
 3.11.33 → 3.11.34
- `src/screens/HomeScreen.tsx` — module-scope chatDraft change
 + new refs + new effect + setInputText wrapper update.

## Manual QA
- [ ] Type "hello" in Quest A's chat. Switch to Quest B. The
 input should be empty (B has no draft yet).
- [ ] Type "world" in Quest B's chat. Switch to a different
 companion tab. The input should be empty for that companion.
- [ ] Switch back to Quest A. Input should show "hello".
- [ ] Switch to Quest B. Input should show "world".
- [ ] Send a message in Quest A. Input clears for A. Switch to
 B: input still says "world".
- [ ] Settings nav: type "draft" → go to Settings → back to chat.
 Input still says "draft" (v3.10.120 behaviour preserved).
- [ ] End a quest (activeChatQuestId → null). Draft for the
 no-quest bucket is shown; the just-ended quest's draft is
 gone (intentional).

## Risk

Low. The change is a strict superset of v3.10.120 (per-chat
drafts preserve all existing single-draft-per-key behaviour).
The most common offender (Settings nav wipe) was fixed long
ago and remains fixed.

## Rollback

`git revert v3.11.34` restores the single global draft. The
chatDraftByKey map is module-scope, so reverting loses any
drafts the user typed between installing v3.11.34 and
reverting — but no other state is affected.