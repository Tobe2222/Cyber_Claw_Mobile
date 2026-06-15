# v3.1.16 — Chat order fix (take two)

## What didn't work in v3.1.15

v3.1.15 tried to fix the chat order by storing the data in reversed
order (newest→oldest at indices 0, 1, 2, ...) and keeping
`inverted={true}` on the FlatList. The combination should have
worked, but the user reported "no difference" after installing
v3.1.15. The chat still rendered with the newest message at the top
and the oldest at the bottom — i.e. `inverted` was being applied to
non-reversed data, or the build didn't pick up the change.

## v3.1.16 — drop `inverted`, use `scrollToEnd`

React Native's `inverted` prop on `FlatList` has a long history of
subtle bugs and inconsistent behavior across iOS / Android / RN
versions. The clean, boring, works-everywhere chat pattern is:

- Data in chronological order (oldest → newest). Just append on
  new messages.
- `FlatList` with `inverted={false}` (the default).
- `scrollToEnd({ animated: false })` to jump to the bottom on
  load and on new incoming messages.

The events tab and log tab already use this pattern and have always
worked. The chat was the odd one out.

Touched:
- `HomeScreen.tsx`:
  - All 6 `setMessages(prev => [msg, ...prev])` →
    `setMessages(prev => [...prev, msg])` (chronological append).
  - `onChatHistory`: no more `.reverse()` — data is stored as the
    desktop sends it.
  - Chat `FlatList`: `inverted={false}`; auto-scroll uses
    `scrollToEnd({ animated: false })`.
  - `onScroll` "at the bottom" detection: uses
    `contentSize.height - (contentOffset.y + layoutMeasurement.height) < 32`
    (i.e. distance from the end of the content). This is the
    standard pattern for non-inverted lists.
  - Date separator: back to the original `messages[index - 1]`
    comparison (works because the array is chronological again).
  - `onLayout` first-render scroll: `scrollToEnd`.
  - Unread badge click: `scrollToEnd({ animated: true })`.
- `HomeScreen.tsx` chat-history load: added a fallback that detects
  v3.1.15-style reversed data and unflips it, so users upgrading
  from v3.1.15 (or v3.1.14) don't see their old chat in the wrong
  order. The fallback is conservative (only flips if the first item
  is clearly newer than the last), so it's safe even with
  single-message or empty data.

## What is still pending (from v3.1.15)

- Wake mode always-on: the v3.1.15 fix (route
  `enterVoiceMode('wakeword')` to `onOpenWakeMode()`) is still in
  place. If it still didn't work in v3.1.15 testing, the likely
  cause is a stale APK build. The v3.1.16 release is built fresh
  from the v3.1.16 tag via the GitHub Actions release workflow.
- Multi-companion arena: the v3.1.15 sync plumbing
  (`agents_list` event, `agentName` on chat messages) is still in
  place. The actual multi-sprite rendering in `arena.html` is a
  follow-up.

## Files

- mobile: `src/screens/HomeScreen.tsx`
