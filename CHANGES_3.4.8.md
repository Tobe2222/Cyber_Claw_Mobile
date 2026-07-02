# v3.4.8 — Chat "↓ new messages" badge positioned above the input row

## What changed

Tobe reported: the "↓ N new messages" floating badge (which appears
when the user scrolls up to read history and incoming messages
arrive) was overlapping the chat input field.

Root cause: the badge was rendered as a sibling of the FlatList,
inside the chat tab `<>`. With `position: absolute, bottom: 8`,
it positioned itself relative to the nearest positioned ancestor
(the `KeyboardAvoidingView tabContent`). That meant 8px from the
bottom of the ENTIRE chat tab — which placed it inside the input
row area (~64px tall), not above it.

## Architecture

- Wrapped the FlatList in a `<View style={chatScrollContainer}>`:
  - `flex: 1` so it takes all available space above the input row.
  - `position: relative` so the absolutely-positioned badge
    positions itself relative to THIS container, not the whole tab.
- Moved the badge inside the wrapper. Now `bottom: 8` puts the
  badge 8px above the bottom of the chat scroll area, which is
  directly above the chatStatusBar (when active) and the
  inputContainer.
- New style: `chatScrollContainer: { flex: 1, position: 'relative' }`.

## Files

- Edited: `src/screens/HomeScreen.tsx`
  - Wrapped FlatList in chatScrollContainer View
  - Added chatScrollContainer style
  - Updated comments on chatScrollToBottomBtn
- Edited: `package.json` (3.4.7 → 3.4.8)
- Edited: `android/app/build.gradle` (versionCode 185 → 186, versionName 3.4.7 → 3.4.8)