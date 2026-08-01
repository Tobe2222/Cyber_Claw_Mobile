# v3.10.120 — Bigger arena (no sky strip on dark), chat-draft persistence, suppress replay notifications

Three small fixes for issues Tobe flagged in the
2026-08-01 dark-mode screenshot:

1. "weird gray line and what seems like a slider in
   the top near settings there. Remove that and make
   the arena a bit taller so it replaces it."
2. "when i type, then go check settings, my text
   disappears, it should be remembered."
3. "for some reason i get notification from earlier
   messages." (matched by a desktop v3.2.40 fix that
   tags replayed messages with `replay: true` — this
   mobile version reads that flag.)

## Fix 1: bigger arena, no sky-strip on dark mode

**The bug.** On dark (Moon) theme, the home screen
had a 14dp pale-blue sky strip with a 28x7 white
cloud pill positioned `top: 4, right: 32` of the
strip. On dark mode:
- The pill looks like a slider/toggle control
- The strip's `borderBottomColor` (`bg.skyDeep =
  #050a18` deep navy) reads as a thin gray line
  below the header
- The strip itself just looks like wasted
  vertical space

**The fix.** Two changes:

- **Hide the sky strip on dark mode entirely**
  (`HomeScreen.tsx` ~line 3480): only render
  `<View style={styles.skyStrip} />` when
  `t.name !== 'dark'`. Light (Sun) and Forest
  themes keep it — the pale-blue / pale-green
  band reads as intentional design there.
- **Remove the `skyStripCloud` decorative pill**
  from the render (was in the same conditional).
  The pill was meant to be a subtle cloud
  silhouette but on dark mode it's the wrong
  visual.
- **Bump `ARENA_HEIGHT`** from
  `Math.min(SCREEN_WIDTH * 0.52, 230)` to
  `Math.min(SCREEN_WIDTH * 0.62, 280)` (~30-50dp
  taller). The freed vertical space goes back to
  the arena. Cap at 280dp so it doesn't shrink
  the chat list on small phones (iPhone SE etc.).

Result on dark mode (Tobe's screenshot):
- Header bar (CyberClaw + Connected + gear)
- Arena (orange-bordered, taller)
- Companion tab bar (Clawsuu / Lamasuu)
- Chat list
- Input field

No more slider-looking pill, no more gray line,
arena fills the freed space.

## Fix 2: chat-draft persists across Settings navigation

**The bug.** When the user types a message and
taps the Settings gear (which navigates from
`screen='home'` to `screen='settings'` in App.tsx),
`HomeScreen` unmounts. Its local `inputText`
React state is destroyed. When the user comes
back from Settings, `HomeScreen` remounts and
`inputText` is back to `''` — the user's typed
text is gone.

**The fix.** Module-scoped `chatDraft` variable
in `HomeScreen.tsx` (~line 340):

```ts
let chatDraft = '';
export function getChatDraft() { return chatDraft; }
export function setChatDraft(s: string) { chatDraft = s; }
```

`inputText` state initializes from `getChatDraft()`
on mount, and a wrapped `setInputText` setter
keeps the module-scope copy in sync:

```ts
const [inputText, setInputTextLocal] = useState(() => getChatDraft());
const setInputText = (s: string) => {
  setChatDraft(s);
  setInputTextLocal(s);
};
```

Module-scope (not App-level state or Context)
because:
- Only HomeScreen uses it; no other screen
  needs to read or write the draft.
- A module-level variable survives unmount/remount
  of the component that uses it, without needing
  context wiring through App.tsx.
- Cleared on send (the existing `setInputText('')`
  call already flows through the wrapper).

If the user later wants drafts per-companion or
drafts per-channel, lifting to App.tsx or
AsyncStorage is the next step. v3.10.120 keeps
it scoped to the chat input itself.

## Fix 3: suppress notifications for replayed AI messages

**The bug.** The sync-server's `_sendFullState`
sends the rolling buffer of recent AI messages
on every reconnect (max 50 entries, capped).
On the mobile, each of those hits `onChat`,
which fires a system notification for every
`isOwnReply` that isn't chat-focused. If 5
agent replies landed while the user was
disconnected, on reconnect they get 5
notifications stacked in the tray.

**The fix.** The sync-server (v3.2.40) tags
replayed payloads with `replay: true`. The
mobile reads the flag and suppresses the
notification while still appending to chat
history (correct: the user DOES want to see
what was said; only the system notification
is suppressed — replays are silent).

```ts
// v3.10.120 in onChat (HomeScreen.tsx ~line 2090):
const isOwnReply = !msg.isUser;
if (isOwnReply && !msg.replay) {
  // ... fire notification ...
}
```

The desktop (v3.2.40) ships the same fix on its
side. Both versions must be in sync — the
mobile's `!msg.replay` check is a no-op if the
desktop isn't tagging. Bump both together.

## Files

- `src/screens/HomeScreen.tsx`:
  - `ARENA_HEIGHT` 230 → 280 (~line 263)
  - Hide skyStrip on dark mode (~line 3480)
  - `chatDraft` module-scope + getter/setter
    (~line 340)
  - `inputText` initializes from `chatDraft` +
    `setInputText` wrapper (~line 543)
  - `onChat` checks `msg.replay` before
    notification (~line 2090)
- `package.json`: 3.10.119 → 3.10.120
- `android/app/build.gradle`: versionCode
  343 → 344

## Cross-repo dependency

This release is part of a paired release with
the desktop `v3.2.40`. The desktop-side
changes are:
- Tag replayed messages with `replay: true`
  (`sync-server.js` `_sendFullState`)
- Strip `[From: <deviceName>]` prefix from
  LLM-facing text in the `mobile-chat` +
  `mobile-voice` IPC handlers (`src/js/app.js`)

If you bump mobile to v3.10.120 without bumping
desktop to v3.2.40, you'll still get the visual
+ draft-persistence fixes but the
notification-on-replay bug will return (the
mobile reads `msg.replay` which the older
desktop doesn't set). Both must deploy.

## Lessons

1. **Decorations that work in light mode can look
   broken in dark mode.** The skyStrip + cloud
   pill was a v3.10.115 design choice that read
   beautifully on the Forest theme (pale blue +
   white cloud) and on the Sun theme (pale blue
   + cloud). On the Moon theme (deep navy bg),
   the same elements read as "a thin gray line
   and a weird slider." Theme-specific render
   decisions aren't always correct — sometimes
   a decoration should be hidden on a theme
   where its design language doesn't translate.
   Rule of thumb: if a decorative element uses
   its own colors (not theme tokens), check each
   theme before shipping.

2. **Module-scope state for tiny persistence
   needs.** For "draft survives one unmount,"
   don't reach for AsyncStorage / Context /
   Redux. A module-scope `let foo = ''` with a
   getter/setter is the minimal fix, and it's
   appropriate when the lifecycle is exactly
   "one component, one unmount/remount cycle."
   When the lifecycle gets more complex
   (per-agent drafts, multi-screen, multi-mount),
   lift to Context or storage.

3. **Tag replayed messages with a flag.** Any
   system that catches up a client via a "send
   recent history" replay should mark the
   replayed entries with a flag (`replay: true`,
   `fromCache: true`, etc.) so the client can
   distinguish "this just happened" from "this
   happened while you were gone." Notifications,
   badges, analytics, "new!" highlights — all
   should suppress on replays. The fix is
   one-line on the server side, one check on
   the client side; the UX improvement is
   massive.

## Pre-push checks (all green)

- `npx react-native bundle --platform android
  --dev false` → bundle written, no parse errors
- `npx tsc --noEmit` → 79 pre-existing errors
  (baseline 79 from v3.10.119, unchanged) +
  0 new errors
- Module-scope `chatDraft` reference grep → 1
  declaration + 3 usages (getChatDraft / setChatDraft
  + the local wrapper), no spurious references

## What I didn't do

### Sky-strip removal on Sun/Forest themes

The pale-blue sky strip stays on Sun (light) and
Forest themes — the design works there (pale
blue + white cloud silhouette reads as
"looking up at the sky"). The gray-line + slider
issue is specifically a Moon-theme problem. If
Tobe later wants the sky strip gone on all
themes, the conditional can be flipped to
`t.name !== 'dark'` → `false` and the strip
will disappear everywhere. Out of scope for
this release.

### Persistent input draft per companion

`chatDraft` is a single string, not per-companion.
If the user types "what's the weather" on Clawsuu
tab, switches to Lamasuu tab, the draft is still
"what's the weather" (a one-string store). For
v3.10.120 this is fine — the mobile's chat UI
switches the input context implicitly (the
`Message <name>...` placeholder updates per tab,
the draft persists across the Settings round-trip).
A per-companion `chatDraftByAgent` Record would
be a follow-up if Tobe reports the current
behavior as confusing.