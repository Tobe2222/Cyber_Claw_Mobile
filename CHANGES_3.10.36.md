# v3.10.36 — Cross-agent chat banner, working-speech autosave, pinned settings back button

Tobe (post v3.10.35):

> "I noticed when receiving a new message that it did not appear in
> the chat but clawsuu had a red sign meaning he has sent a new
> message. Clicked that red and it appeared in the chat. This should
> just appear in the chat automatically, and it should appear an
> update button in the chat at the bottom if we must, rather than
> clicking on clawsuu tab.
> And, there is no way to save the new working text.
> And the back button on pages should always follow along in the top
> when the user scrolls."

Three fixes in this version.

## 1. Cross-agent chat banner (HomeScreen)

The chat tab shows messages from the active companion. When a
*different* companion sends a message, the per-agent tab badge
increments but the chat list itself doesn't update (it's still
showing the active agent's history). The user has to look at the
companion tab bar to notice the badge, then tap to switch.

Tobe's UX ask: "this should just appear in the chat
automatically, and it should appear an update button in the chat
at the bottom if we must".

**Fix:** An inline banner above the chat input row when at least
one *other* agent has unread messages. One banner per unread
agent (stacked when multiple). Each shows:
- The agent's emoji + name
- "N new messages" count
- A preview of their last message (truncated to 48 chars)
- A "View →" action button

Tapping the banner (or the action button) jumps to that agent's
tab via the new `switchToAgent(aid)` callback. This is the same
behavior as tapping the companion tab itself:
- `setActiveChatAgentId(aid)` — active companion swap
- `setMessages(messagesByAgent[aid] || [])` — load that
  companion's cached messages into the visible chat list
- `setChatUnreadByAgent(prev => ({ ...prev, [aid]: 0 }))` —
  clear the unread badge
- `syncClient.requestAgentHistory(aid)` — fetch fresh history
  from the desktop (in case anything changed since cache load)
- Inject `Arena.setActive(aid)` into the WebView to swap the
  arena sprite in place (no full WebView reload — that caused
  a reload ping-pong in v3.1.26)
- Persist the new active companion to AsyncStorage so the next
  app launch remembers

The existing companion tab onPress is refactored to call
`switchToAgent(a.id)` so behavior is shared between the two entry
points (tab tap + banner tap) — no drift between paths.

Style: warm amber tint (`rgba(247,147,26,0.12)` background) so
the banner reads as "important, but not an error". Same `#f7931a`
brand orange used throughout the app for consistency.

## 2. Working speech text input autosave + saved indicator

The new "🧠 Working / thinking status" section added in v3.10.34
included a TextInput for the working speech phrase. The save
handler only fired on `onBlur`:

```js
<TextInput
  value={voiceWorkingSpeech}
  onChangeText={setVoiceWorkingSpeech}
  onBlur={saveVoiceWorkingSpeech}
  ...
/>
```

Tobe: "there is no way to save the new working text". The save
fires only when the TextInput loses focus. On a phone, this can
fail to happen (Back navigation may not trigger TextInput blur
consistently, depending on the keyboard state). Without an
explicit Save action and no visible "Saved" feedback, the user
sees their edits but doesn't know if they persisted.

**Fix:**
- Debounced 600ms auto-save on every keystroke, mirroring the
  `persistReadyPhrase` pattern already used by the wake-greeting
  TextInput (same file, same handler shape — if both work, they
  work the same way).
- A `✅ Saved at HH:MM:SS` confirm line below the input once the
  save completes (resets when typing starts again, or after a
  successful save). Mirrors the existing `audioSettingsSavedAt`
  + `saveAudioSettings` UX in the audio settings section.
- The original `onBlur={saveVoiceWorkingSpeech}` is kept as a
  fallback — if blur fires before the debounce commits, the blur
  path does the synchronous save.

## 3. Pinned settings back button

The Settings screen had its "← Back" + "Settings" title as the
first child of the ScrollView. Long pages (the Wake listening +
voice mode sections run together) meant the user scrolled the
back button off-screen within a few swipes, leaving them in the
middle of the page with no anchored home button.

Tobe: "the back button on pages should always follow along in the
top when the user scrolls".

**Fix:**
- Pulled the `<View style={header}>` out of the ScrollView and
  into a sibling `<View style={fixedTopHeader}>` above the
  ScrollView. The fragment at the top of the render now contains
  exactly two children: the fixed header, and the ScrollView
  below it.
- The fixed header keeps `flexDirection: 'row'` + `paddingTop` of
  `34` on Android (status-bar inset) but drops the
  `marginBottom: 20` (the ScrollView's paddingTop takes that gap
  responsibility now). The ScrollView's own `paddingTop` dropped
  from `50` to `12` because the header isn't using that space
  anymore.
- A subtle `borderBottomColor: '#1f1f1f'` gives the header its
  own visual region so it doesn't blur with the scrolling
  content below it.
- ScrollView's `flex: 1` (from `styles.container`) makes it fill
  the remaining space below the header.

Same fix applies elsewhere if Tobe reports similar — e.g.
`WakeSetManagerScreen.tsx` and `OpenWakeWordTrainer.tsx` use the
same "header inside ScrollView" pattern. Both are deferred to
Tobe's explicit feedback unless they become a complaint.

## Files

- `src/screens/HomeScreen.tsx` — new `switchToAgent` callback,
  refactored companion tab onPress to use it; new
  cross-agent banner JSX block above `inputContainer`; new
  `crossAgentBanner*` StyleSheet entries.
- `src/screens/SettingsScreen.tsx` — new `persistWorkingSpeech`
  debounced saver + `workingSpeechSavedAt` state; TextInput
  wired to autosave on change + "✅ Saved at..." confirm line;
  "🔒" header pulled out of ScrollView into a new
  `fixedTopHeader` sibling; new `hintSmall` style for the
  saved-confirm Text; `content.paddingTop` reduced from 50 to
  12.
- `package.json` 3.10.35 → 3.10.36
- `android/app/build.gradle` versionCode 262 → 263, versionName
  3.10.36

## Migration / behavior

- **Cross-agent banner** activates immediately for any agent
  with `chatUnreadByAgent[agentId] > 0 && agentId !==
  activeChatAgentId`. New chat events for other agents
  increment the counter (existing behavior, v3.1.17) and now
  also trigger the banner to appear.
- **Working speech autosave** is independent of any settings
  value — purely UX. The save key (AsyncStorage) is unchanged.
- **Pinned back button** is layout-only. No state or behavior
  changes.