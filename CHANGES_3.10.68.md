# v3.10.68 — Chat dedupe: keep the `[From: ...]` bubble, drop the plain one

Tobe reported:

> "i noticed the chat still gives double texts. We can
> keep the one which states where it comes from"

Screenshot showed two adjacent user bubbles for the
same typed message:

1. **"Hey my bro!"** — plain text, no prefix
2. **"[From: Android Phone] Hey my bro!"** — prefixed

He wants to keep only the prefixed version.

## Root cause: local add and desktop echo are not deduping

The mobile appends the local typed message with plain
text (no prefix). The desktop echoes it back with a
`[From: Android Phone]` prefix added by
`src/sync-server.js:320`:

```js
const deviceTag = client.name && client.name !== 'Desktop'
  ? `[From: ${client.name}] ` : '';
this.onChatMessage(deviceTag + msg.text, msg.agentId, ...);
```

The dedupe check in `HomeScreen.appendAgentMessage`
normalizes both sides and compares. The v3.10.42
normalize only strips *leading non-word chars* (emojis,
whitespace) — `[` was in the keep list, so the entire
`[From: Android Phone] ` prefix survived on the echo
side. Plain vs prefixed text never matched → both
landed in the chat.

Tobe's earlier v3.10.42 fix had solved a similar bug
for the `🎤 ` emoji prefix on voice transcripts. The
`[From: ...]` prefix is structurally different (it's a
bracketed phrase, not a single leading symbol), so the
emoji-strip regex didn't catch it.

## Fix: prefix the local add too, then strip the prefix in normalize

Two complementary changes:

1. **Add the prefix locally when appending a user
   message.** The mobile now knows its paired device
   name (`SyncClient._deviceName`, cached from
   `auth_result.name`, defaults to `'Android Phone'`).
   Both the typed-message path and the voice-transcript
   path prepend `[From: ${deviceName}] ` before calling
   `appendAgentMessage`. The user sees the prefixed
   bubble instantly on tap-send. The desktop echo is
   text-identical → dedupe matches → echo is dropped.

2. **Strip `[From: ...]` in normalize as a defensive
   fallback.** For chat history persisted before
   v3.10.68 (where the local add had no prefix), the
   desktop's echoed `[From: Android Phone] ...` text
   now matches the plain local text after normalize
   strips the leading `[From: <name>]` regex. No more
   re-imported duplicates from old sessions.

```ts
// v3.10.68: also strip a leading `[From: ...]` prefix.
const normalize = (s: string) =>
  (s || '')
    .replace(/^\[From:\s*[^\]]*\]\s*/, '')
    .replace(/^[^\w[\(]+/, '')
    .trim();
```

## Files changed

- `src/services/SyncClient.ts` — new `_deviceName` field
  + `getDeviceName()` getter, populated from
  `auth_result.name`
- `src/screens/HomeScreen.tsx`:
  - typed-message local append now prefixes
    `[From: <deviceName>] `
  - voice-transcript local append now prefixes
    `[From: <deviceName>] `
  - `normalize()` strips leading `[From: ...]` block
    before the existing emoji/whitespace strip
- `android/app/build.gradle` — versionCode 293→294,
  versionName 3.10.67→3.10.68
- `package.json` — version 3.10.67→3.10.68

## Lessons

**The emoji-strip regex was a coincidence fix, not a
general prefix-strip.** The v3.10.42 lesson was
"normalize strips emoji prefixes so the mobile-local
vs desktop-echo pair dedupes correctly." That worked
for `🎤` because `🎤` is a non-word char caught by the
existing regex. The `[From: ...]` prefix is a *bracketed
phrase* — multiple chars, starts with `[` which was in
the keep list. The v3.10.42 fix didn't generalize.

**Rule for prefix-stripping:** when you see a normalized
prefix you didn't expect to keep, ask "is this a known
server-side format marker?" If yes, write a dedicated
regex for it, don't rely on a general "strip leading
non-word chars" rule. The dedicated regex is also
self-documenting (a future reader sees `^\[From:` and
knows exactly what's being stripped and why).

**Wire-format prefixes belong on the producer side.** The
desktop adds the `[From: ...]` prefix because that's its
canonical view of the message (it knows the source). The
mobile should mirror that same view locally so the two
sides agree. Both sides using the same prefix means
dedupe works without any special normalize gymnastics —
the regex above is just belt-and-suspenders for old
data.

**Why not strip `[From: ...]` on the server side too?**
Then the desktop wouldn't echo the prefix back to the
mobile's view at all, and the user wouldn't see "where
it comes from" on their own messages. Tobe explicitly
asked for the prefixed version to be the one shown.
The `On: Android` style tag is a feature, not noise.