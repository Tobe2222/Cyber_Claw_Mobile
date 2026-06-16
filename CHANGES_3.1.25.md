# v3.1.25 — companion tab bar: stop faking Clawsuu, use real names everywhere

## The problem

When the mobile app couldn't get the agents list from the
desktop (e.g. because of a desktop-side cache TTL bug, slow
first connect, or a race with the initial broadcast), the
companion tab bar at the top of the chat fell back to a
single fake **Clawsuu** tab:

```js
const list = agents.length > 0 ? agents : [{ id: 'clawsuu', name: 'Clawsuu', emoji: '🐾' }];
```

That fallback had three problems:

1. **It looked like a real companion tab.** Tapping it set
   `activeChatAgentId = 'clawsuu'` and requested chat history
   for `'clawsuu'`, which mostly worked if the real Clawsuu's
   id matched — but the user had no way to tell from the UI
   that this was a placeholder.
2. **It masked missing companions.** Lamasuu was missing from
   the tab bar even when the user had a real Lamasuu
   companion on the desktop, because the fallback was always
   exactly one tab and the user assumed that's all there
   was.
3. **It produced empty chat for any companion whose agents
   list never arrived.** The history request fired for the
   fallback id, got back zero messages, and the chat area
   showed an empty state hard-coded to "Say hi to Clawsuu!"

Tobe described it as: "There is no default chat really,
there is supposed to be the chats for each companion only +
the system chats."

## v3.1.25 — three coordinated fixes

### 1. Tab bar uses an inline placeholder, not a fake tab

When `agents.length === 0`, render a small "Loading
companions…" label inside the tab bar's bounding box, not a
fake tab:

```jsx
if (agents.length === 0) {
  return (
    <View style={styles.companionTabBar}>
      <View style={styles.companionTabBarContent}>
        <Text style={styles.companionTabPlaceholder}>
          {isConnected ? 'Loading companions…' : 'Connect to desktop to see companions'}
        </Text>
      </View>
    </View>
  );
}
```

This keeps the bar's height stable (so the chat area below
doesn't jump when the real tabs arrive) but it's clearly
not a companion. The two states ("connected, waiting for
list" vs "not connected at all") are explicit so the user
can tell whether the issue is on the mobile's side or
the desktop's.

### 2. Chat placeholder is context-aware

The empty-chat list used to show a hard-coded
`"Say hi to Clawsuu! 🐾🐾"` regardless of which tab was
active. Now it adapts to the actual state:

- Not connected → `"Connect to desktop CyberClaw to chat"`
- Connected but no tab selected →
  `"Pick a companion tab to start chatting"`
- Connected and a tab is selected → `"Say hi to <Name>! <emoji>"`

The TextInput placeholder (`"Message Clawsuu..."`) was
updated the same way so it always matches the active
companion.

### 3. "X is thinking…" and message labels use the agents list

Two places hard-coded `'Clawsuu is thinking...'` in the
typing indicator. The desktop sends `agentName` in the
typing payload, but as a backstop (in case the mobile is
chatting with a companion whose typing event arrives before
the agents list, or whose name doesn't match) we look up
the active companion in the cached `agents` list and use
its real name and emoji.

The message bubble's agent label (the small name tag
above each assistant message) also falls back through the
cached `agents` list. So even older messages that didn't
carry `agentName` in their payload will display as e.g.
"🦙 Lamasuu" instead of the generic "🐾 clawsuu".

To avoid stale-closure bugs in the sync-event handlers
(which all live inside the main `useEffect`), a new
`agentsRef` mirrors the latest `agents` state. Same pattern
as the existing `activeChatAgentIdRef` and
`messagesByAgentRef`.

## Bonus: dedicated `request_agents_list` message

The mobile's `SyncClient.requestAgentsList()` used to send
`{ type: 'request_state' }` and rely on the desktop's
`_sendFullState` to include the agents list. That works, but
couples two unrelated things. Now it sends a dedicated
`{ type: 'request_agents_list' }` message, which the desktop
handles in its own case. Same reply path, but the contract
is explicit: "give me the current agents list."

The matching desktop-side fix ships in `cyberclaw` v3.1.17
(removed the 10-minute cache TTL, added the dedicated
`request_agents_list` handler, added the renderer refresh
path for the edge case where the mobile connected before
the renderer's first arena-init broadcast).

## Files

- `src/screens/HomeScreen.tsx` — removed fake Clawsuu
  fallback, added inline placeholder, made chat placeholder
  and "thinking" status context-aware via the agents list,
  added `agentsRef` for stable-closure reads, used the new
  `request_agents_list` message indirectly
- `src/services/SyncClient.ts` — `requestAgentsList()` now
  sends a dedicated `request_agents_list` message
- `package.json` / `android/app/build.gradle` —
  bumped to v3.1.25 (versionCode 75)
- `.github/workflows/android-build.yml` /
  `.github/workflows/build.yml` — bumped artifact
  filenames to `app-debug-3.1.25` and
  `CyberClaw-Android-3.1.25.apk`

## Verification

- `node --check` passes on the changed JS files (the
  pre-existing TypeScript error in HomeScreen.tsx around
  line 1953 is unchanged; it predates these edits and the
  Metro bundler tolerates it at runtime).
- 11 unit tests still pass (`npm test`).
- Manual reproduction: with the desktop cache-stale bug
  fixed in `cyberclaw` v3.1.17, opening the mobile app
  shows both Clawsuu and Lamasuu tabs. Tapping each loads
  that companion's history. The chat placeholder and the
  "thinking" status correctly show the companion's name
  and emoji.
