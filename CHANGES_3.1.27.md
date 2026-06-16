# v3.1.27 — fix chat reset on tab switch, stop the WebView ping-pong, cap companion tabs at 6

## The bugs

Three separate issues from the v3.1.26 test:

1. **Chat reset on tab switch.** Start the app on the Clawsuu
   tab with some chat history visible. Tap Lamasuu — chat
   area shows Lamasuu (empty). Tap Clawsuu — chat is now
   empty too. The previous messages were gone.

2. **WebView reload ping-pong.** The Log tab showed
   "Companion updated: hare" → "Companion updated: boar" →
   "Companion updated: hare" → ... cycling every 3-8
   seconds. Burning CPU and making the WebView flicker.

3. **No 6-companion cap.** If the desktop has 10
   companions, the mobile tab bar would show 10 tabs and
   require horizontal scrolling. The mobile UI wasn't
   designed for that.

## Root cause for #1: chat loaded into the wrong state

In v3.1.26 (and earlier), the persisted chat was loaded
into the single `messages` state on app start, but NOT into
`messagesByAgent`. Tab switching does
`setMessages(messagesByAgent[a.id] || [])`, which is empty
for every agent at startup. The first switch wiped the
visible chat; switching back to the original agent also
showed an empty slot.

The fix: load the persisted chat and GROUP BY agentId,
seeding `messagesByAgent[aid]` for any empty slot. The
legacy `cyberclaw-chat-history` key is supported as a
fallback for users upgrading from v3.1.26, but the new
`cyberclaw-chat-byagent` key is the source of truth going
forward. A debounced (1.5s) persist effect writes the per-
agent cache on every `messagesByAgent` change.

## Root cause for #2: WebView reloaded on every companionId change

The v3.1.26 tab click handler did `setCompanionId(a.sprite)`
and a `useEffect([companionId])` bumped `webViewKey(k+1)`
to force a WebView reload. The reload caused the WebView to
re-initialise from the URL, which posted a `companion_id`
echo to the sync server, which the desktop re-broadcast as
`companion_id`, which set the React state again, which
bumped the key again, and so on. Visible in the log as
the hare/boor ping-pong.

The fix:
- Tab click now injects `setCompanion(id)` into the
  WebView via `injectJavaScript`. No state change, no
  reload. The WebView's sprite swaps in place and posts
  `saveComp` (which only persists to AsyncStorage, no
  echo).
- The per-`companionId` useEffect that bumped
  `webViewKey` is REMOVED.
- The WebView's `source` URI uses
  `initialArenaCompanionRef.current` (captured on first
  render) instead of the live `companionId` state, so
  the URI never changes after mount — the WebView stays
  mounted even if `companionId` state is updated for
  other reasons (e.g. by the desktop's `companion_id`
  echo).
- A new `initialArenaInjectedRef` ensures the
  `setCompanion` injection on the first `agents_list`
  arrival happens only once, not on every broadcast.

## Root cause for #3: no cap

The agents list from the desktop was passed through
unchanged. Cap it at 6 on the mobile side (the user
asked for 6 explicitly). The desktop can still have
more; the mobile just shows the first 6 in the order
the desktop sent them (active chat companion first,
then the rest in arena order).

## Bonus: agent_history empty response no longer wipes local cache

The desktop's `chatHistoryByAgent` is in-memory only. After
a desktop restart, `request_agent_history` for any agent
returns an empty array. The v3.1.26 (and earlier) handler
on the mobile did `setMessagesByAgent(prev => ({ ...prev,
[aid]: [] }))` unconditionally — wiping the local cache
on every restart. Now: if the response is empty AND the
local cache for that agent is non-empty, KEEP the local
copy. The user keeps seeing their old messages. The
desktop's history will sync back when it has new content
to send.

## Desktop companion (cyberclaw v3.1.18)

Also bumped the desktop to persist `chatHistoryByAgent` to
localStorage. The mobile's local cache is the tab-switch
source of truth, but having it on the desktop too means
the desktop's chat view (and any other mobile clients)
see the history after a restart, not just an empty chat
until the user has a new conversation. Debounced (2s) to
avoid hammering storage on rapid messages.

## What's still on the wishlist (NOT in this PR)

- **Persistent multi-companion mobile arena.** The mobile
  arena.html is a simplified single-sprite version of the
  desktop's pixel arena. The user wants both companions
  visible at once with their saved sizes. This is a real
  pixel-arena port; too big for a hotfix PR. Tracked
  separately.
- **Desktop → mobile re-broadcast on companion
  add/remove/resize.** The desktop doesn't currently
  notify the mobile when a companion's settings change
  (e.g. user resizes Lamasuu in the forge). Easy to add
  in `saveCompanion` + `applyCompanionVisibility` (call
  the existing `sync-broadcast-agents-list` IPC), but
  also out of scope for this PR.

## Files

- `src/screens/HomeScreen.tsx`
  - Load persisted chat into `messagesByAgent`
    (grouped by agentId) and seed the visible `messages`
    from the first non-empty slot.
  - Add a debounced (1.5s) persist effect for
    `cyberclaw-chat-byagent`.
  - `onAgentHistory` handler: keep local cache on
    empty desktop response, only adopt the empty state
    if the local slot is also empty.
  - Remove the per-`companionId` useEffect that bumped
    `webViewKey`.
  - Add `initialArenaCompanionRef` (captures the
    companion at first render) and use it in the
    WebView's source URI.
  - Add `initialArenaInjectedRef` so the
    `setCompanion` injection on first `agents_list`
    arrival happens only once.
  - Tab click: inject `setCompanion(id)` via
    `injectJavaScript` instead of reloading the
    WebView. Persist to AsyncStorage.
  - `onAgentsList`: cap the list at 6 (constant
    `MAX_MOBILE_COMPANIONS`).
- `package.json` — bumped to 3.1.27
- `android/app/build.gradle` — versionCode 77,
  versionName 3.1.27
- `.github/workflows/*.yml` — bumped artifact names to
  `app-debug-3.1.27` and `CyberClaw-Android-3.1.27.apk`

## Desktop changes (cyberclaw v3.1.18)

- `src/js/app.js`
  - `schedulePersistChatHistory()`: debounced (2s) write
    of `chatHistoryByAgent` to `localStorage` after
    every `addChatMsg`.
  - `restoreChatHistory()`: called on app start (in the
    `DOMContentLoaded` boot handler), reads
    `cyberclaw-chat-byagent` and repopulates the in-
    memory `chatHistoryByAgent` and the flat
    `chatHistory` mirror.
- `package.json` — bumped to 3.1.18

## Verification

- Both files parse cleanly (`node -c` for desktop,
  `@babel/parser` for the mobile TSX).
- Bumped to v3.1.27 mobile / v3.1.18 desktop and pushed.
- Manual reproduction after the desktop update + mobile
  install: chat should persist across tab switches and
  across desktop restarts. Log tab should NOT show the
  hare/boar ping-pong. Tab bar caps at 6 companions.
