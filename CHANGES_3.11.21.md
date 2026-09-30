# v3.11.21 — Stable history message IDs (kills reconnect-scroll-spam)

**Tobe 2026-09-30 10:38 (Discord #cyber-dev):**

> "now the mobile end chat is spamming up and down.
> It seems to be triggered each 10 seconds or
> something where i get a notification of a new
> message even tho there are none but the chat seems
> to refresh and think there are and then starts spam
> scrolling fast up and down to the same positions."

## Root cause

Pre-v3.11.21 the onAgentHistory / onChatHistory /
seedFromLegacy paths generated message IDs as:

```js
id: `hist-${m.ts}-${Math.random()}`,
```

The `Math.random()` suffix changed on **every
re-hydrate**. Re-hydrates happen on:

- WS reconnect (mobile doze / network blip / desktop
  restart)
- agent-tab switch
- foreground after background
- `request_state` from the sync-server's reconnect
  replay

Each re-hydrate pushed the SAME messages back into the
bucket map with NEW random IDs. The auto-scroll-to-new-
message effect (line ~5659) compares
`last.id === lastMessageIdRef.current`. With random IDs,
the comparison never matches, so the effect fires
`scrollToEnd` on every re-hydrate.

Reconnect storms (we saw 18 reconnects in the recent
desktop log) → 18 scrollToEnd calls in quick succession.
The chat appears to "spam scroll fast up and down to the
same positions" because each scrollToEnd lands at the
interim contentSize (the FlatList hasn't settled yet),
then the FlatList settles, then the next scrollToEnd
yanks it again. The user perceives jitter.

The "notification of a new message even though there are
none" symptom is the companion side: each reconnect
also replays the cached `_recentAiMessages` buffer
(server-side, sync-server.js:2244) with `replay: true`
flag. The mobile suppresses notifications for `replay:
true` (HomeScreen.tsx:3907) — BUT only if the message
matches dedupe. If the dedupe catches it, no
notification. If it doesn't (e.g., the message ID
matches an older message but not the same slot), a
spurious notification fires.

## Fix

New helper `stableHistoryMessageId(ts, text)` derives
deterministic IDs from `ts` + text hash:

```js
function stableHistoryMessageId(ts, text) {
  const t = (typeof ts === 'number' && isFinite(ts)) ? ts : 0;
  const textPart = (text || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `hist-${t}-${textPart}-${hash}`;
}
```

Applied at all 7 history paths:

1. **Line 2828** — `seedFromLegacy` (pre-v3.11.0 legacy
   AsyncStorage cache hydration)
2. **Line 2968** — `seedFromPerAgent` (per-agent
   AsyncStorage cache migration)
3. **Line 3056** — `seedFromLegacy` migration target
   (DEFAULT-bucket consolidation)
4. **Line 4293** — `onChatHistory` per-quest routing
5. **Line 4335** — `onChatHistory` legacy flat-mirror
   fallback
6. **Line 4793** — `onAgentHistory` per-bucket
   routing
7. **Line 4835** — `onAgentHistory` legacy
   flat-mirror fallback

**NOT changed** (real-time paths that genuinely need
uniqueness):

- Line 3720 — `onChat` (real-time chat_message event,
  needs unique IDs)
- Line 4701 — local user-message send (`user-local-*`)
- Line 5197 — error bubbles (`err-*`)

## Files

- `src/screens/HomeScreen.tsx` — added
  `stableHistoryMessageId()` near `DEFAULT_QUEST_KEY`;
  replaced 7 `hist-${m.ts}-${Math.random()}` call sites
- `package.json` — 3.11.20 → 3.11.21
- `android/app/build.gradle` — versionCode 414 → 415,
  versionName "3.11.18" → "3.11.21"

## Out of scope (separate bug noted)

The `[chat:send/http] fetch failed` is still happening.
That's why clawsuu isn't responding to Tobe's mobile
chat — the HTTP path to the gateway is throwing a
generic Node fetch error (no AbortController signal,
not an HTTP non-2xx, just "fetch failed"). Diagnostic
needed: capture the actual `e.message` instead of
swallowing it. Pre-v3.3.25 the log only shows
`fetch failed (fetch failed): fetch failed` — both
inner and outer messages are "fetch failed" which
suggests `e.cause?.message` is also "fetch failed"
without a deeper cause. Probably a Node 22 fetch quirk
with persistent connections or a server-side socket
close. Filed for the next debug session.

## Lesson (added to MEMORY.md)

**Random IDs in deduplicated lists break scroll and
notification gating.** Whenever a list is rebuilt from
a source-of-truth (network response, persisted cache,
server-side replay), every entry needs a **stable ID
that's invariant under re-hydration**. Otherwise:

1. The auto-scroll-on-new-message effect sees a "new"
   last entry on every re-hydrate and scrolls.
2. The dedupe-via-ID keys don't match between re-runs.
3. The notification gating (which often checks for "is
   this a new message since last seen") gives false
   positives on every re-hydrate.

Three rules:

- **Real-time events**: random IDs are fine (uniqueness
  is the only requirement).
- **History/persistence/replay**: deterministic IDs
  from stable fields (ts + text hash, or server-
  provided ID).
- **Mixed sources**: don't. Either everything goes
  through the same path with the same ID scheme, or
  maintain explicit ID-mapping logic between paths.

The pattern generalizes beyond chat: any time a client
listens for "something new" via a last-id comparison
and re-fetches the same source-of-truth, the IDs MUST
be stable. Random suffixes are a silent footgun.

## Deploy

Mobile build needed (APK / Play Store). Code is
in-repo on the active branch; tag `v3.11.21` after
build passes local smoke test (open mobile, scroll
chat, kill desktop WS, restart desktop, confirm chat
doesn't scroll-spam on reconnect).
