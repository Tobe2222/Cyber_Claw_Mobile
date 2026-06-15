# v3.1.15 — Chat order, wake mode always-on, multi-companion sync

Three bugs from real-device testing:

## 1. Chat opened with oldest messages at the bottom

After the v3.1.14 inverted-FlatList change, the chat opened at the
bottom of the screen (good) but the OLDEST messages were rendered at
the bottom of the list — the opposite of what the user expects.

### Cause

`FlatList` with `inverted={true}` lays out the first item in `data`
at the bottom of the screen. v3.1.14 stored the data in chronological
order (`[oldest, ..., newest]`) and used `scrollToOffset({ offset: 0 })`
to "scroll to the newest". With `inverted=true`, `offset 0` is the
top of the scroll viewport, which is the bottom of the screen, which
is `data[0]` = OLDEST. So scrolling to the newest was actually
scrolling to the oldest.

### Fix

Store the data in reverse order: `data[0]` = newest, `data[length-1]`
= oldest. With `inverted={true}` and `scrollToOffset({ offset: 0 })`,
the newest message now correctly appears at the bottom of the screen.

Touched:
- `HomeScreen.tsx`: all 6 `setMessages(prev => [...prev, msg])` →
  `setMessages(prev => [msg, ...prev])`.
- `HomeScreen.tsx` `onChatHistory` handler: desktop sends oldest→newest,
  so the loaded array is `.reverse()`d before storing.
- `HomeScreen.tsx` auto-scroll useEffect: uses `messages[0]` (newest)
  instead of `messages[messages.length - 1]`.
- `HomeScreen.tsx` `renderMessage` date separator: with reversed data,
  the next-older message is at `index + 1`; show a separator when it
  crosses into a new day bucket (this puts the "Yesterday" / "Today"
  label at the start of each new day group in visual order).
- `ChatMessage.agentName` field added (optional). When the desktop
  includes `agentName` in the chat broadcast, the chat label shows
  `🐾 <name>` instead of the hardcoded `🐾 Clawsuu`. This is a
  no-op for single-companion setups and ready for multi-companion
  use.

## 2. Wake word did not always open Wake Mode

When testing wake mode from inside the app (in-app sample match),
`enterVoiceMode('wakeword')` set the in-home fullscreen overlay
rather than switching to the dedicated `WakeModeScreen`. The result:
if the user was on a different tab (chat, settings) when the wake
word fired, the app stayed on that tab and the in-home fullscreen
tried to render the Wake Mode UI on top of the wrong screen.

The user expectation: wake word → ALWAYS the dedicated `WakeModeScreen`,
regardless of which tab was active.

### Fix

`enterVoiceMode('wakeword')` now hands off to the dedicated
`WakeModeScreen` via `onOpenWakeMode()` and clears all in-home
fullscreen state. `WakeModeScreen` already has its own sample-match
listener and recording flow, so no behavior is lost.

The native wake-receiver path (wake word from the background
service) was already correct and unchanged: `wakeWordDetected` →
`App.tsx` listener → `setScreen('wake-mode')`.

## 3. Mobile arena shows only the active companion

The mobile `arena.html` was a single-companion renderer. The desktop
shows all configured companions in its `pixelArena`. The mobile
should mirror the desktop — if the user adds Lamasuu, the mobile
should show both Clawsuu and Lamasuu.

### What landed in v3.1.15

- New sync event: `agents_list`. The desktop broadcasts the full
  list of visible agents whenever the arena is initialized. Each
  entry: `{ id, name, sprite, scale }`.
- The mobile `SyncClient` emits `agents_list`; `HomeScreen` stores
  it in `agents` state and pushes it into the `WebView` (both on
  load and whenever the list updates).
- Chat messages now include `agentName` (the display name from the
  desktop) so the chat label can show the correct companion name.

### What did NOT land (out of scope)

The full multi-sprite rendering loop in `arena.html` — that's a
~200-line refactor of the rendering, animation, and click-to-talk
paths. For v3.1.15 the mobile WebView receives the agent list and
is ready to render it; the next release can extend `arena.html` to
display all companions in the arena (e.g. active one walks /
responds, others idle in a row).

The user will see no visual change in the arena for v3.1.15; the
multi-companion rendering is a follow-up.

## Files

- mobile: `src/screens/HomeScreen.tsx`, `src/services/SyncClient.ts`
- desktop: `src/sync-server.js`, `src/main.js`, `src/js/app.js`
