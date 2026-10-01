# v3.11.26 — chat_history anchor fallback (kill "timeout error doesn't reach mobile")

Tobe 2026-10-01 07:18:

> "he had not answered but an timeout error appeared i see
> on the desktop end. Again, its not showing up on the
> mobile."

Still happening on v3.11.24, despite the realtime-broadcast
fallback in that release. The bug is in a different code
path: `onChatHistory`, not `onChat`.

## Symptom

The desktop fires `addChatMsg('error', ...)` after the
chat-pipeline times out. The error is broadcast over WS
**and** added to the desktop's flat `chatHistory` mirror
with `activeQuestId` stamped from the desktop's
module-scope `activeQuestId` at that moment.

If the mobile was disconnected (Android doze, background,
etc.) when the broadcast fired, the realtime frame was
lost. On reconnect, the mobile sends `request_chat_history`
and the desktop replays the full history — INCLUDING the
error message, which now carries `activeQuestId: null`
(the desktop's module-scope was null when addChatMsg
fired).

`onChatHistory` was routing messages with
`activeQuestId: null` straight to the DEFAULT bucket.
The user's projection effect was showing the anchor's
bucket (HIVE_CONTROL). DEFAULT is invisible. Error
appears on desktop but not on mobile — exactly the
symptom Tobe reports.

## Root cause

The v3.11.24 fix only patched the realtime broadcast
path (`onChat` handler):

```ts
// v3.11.24: realtime broadcast
const questForRoute = questFromBroadcast
  || (mobileActiveQuestAnchor ? { id: mobileActiveQuestAnchor } : aq);
```

The `onChatHistory` path (which handles the desktop's
chat_history replay on reconnect) was left unchanged.
It routed every message with `activeQuestId: null` to
the DEFAULT bucket, ignoring the mobile anchor entirely.

## Fix

Apply the same anchor fallback in `onChatHistory`. When
the desktop's stamp is null/missing AND the mobile anchor
has a non-null value, route the message to the anchor's
bucket (and re-stamp `activeQuestId` / `activeQuestName`
so the per-bubble pill shows the anchor's name, matching
the realtime broadcast path).

Cross-bucket dedupe: when the same message ID exists in
any OTHER bucket for this agent (e.g. DEFAULT from a
prior chat_history response before this fix landed), skip
the duplicate. This prevents the error from appearing
twice (once in DEFAULT from the pre-fix replay, once in
HIVE_CONTROL from the post-fix replay) on the first
reconnect after the upgrade.

The fallback only applies when:
- the desktop's stamp is null/missing (a wrong non-null
  stamp is preserved as the desktop is source of truth
  for non-null values), AND
- the mobile anchor has a non-null value (don't fall
  back if the user explicitly deactivated on the mobile
  side — that case correctly routes to DEFAULT).

The legacy path (old desktops that don't stamp
`activeQuestId` at all) is left unchanged — those
desktops really did mean "no active quest" and the
DEFAULT bucket is the correct destination.

## Files changed

- `src/screens/HomeScreen.tsx` — `onChatHistory`
  per-quest routing: anchor fallback + cross-bucket dedupe.
- `package.json` — version bump to `3.11.26`.
- `android/app/build.gradle` — versionCode `420`,
  versionName `"3.11.26"`.

## Companion desktop change (v3.3.30)

The desktop's per-bubble quest header was also redesigned
in v3.3.30: from a full-width uppercase mono line above
each bubble (eating vertical space) to a small absolute-
positioned pill at the bottom-right corner. Tobe 2026-10-01
08:06: "the quest text in the bubble takes up too much
space. Perhaps put it in the bottom right so it does not
create its own full line. Or something. Make it pretty."