# v3.10.138 — companion attribution for arena treats + persistent "jump to bottom" button

## Two changes in one release (per Tobe's 2026-08-06 batch)

### 1. Track which companion eats the food (Tobe: "make it comment it such that the comment ends up in the chat log and thereby it can know")

Before: when Tobe dropped a snack on the mobile arena,
the `treat_placed` / `treat_eaten` notifyRN events only
carried `{ type, treat }`. The desktop's
`promptCompanionReaction` then defaulted to
`activeChatAgentId` (the chat-tab companion) as the
speaker. So dropping a hamburger near lamasuu while
clawsuu's chat tab was open would result in **clawsuu
saying** "thanks for the hamburger" — even though
lamasuu was the one within eating range.

After: the arena events now carry a `companionId` field:

- **`treat_placed`**: pick the nearest sprite (L∞
  distance ≤ 300px from the treat center). Falls back
  to no companionId if no sprite is in range.
- **`treat_eaten`**: the eater's id (the `c.id` inside
  the seek-and-eat loop, which is the companion that
  actually consumed the treat).

These flow through:
```
arena.html notifyRN → HomeScreen.tsx msg handler
  → syncClient.send({type, treat, companionId})
  → sync-server.js _handleMessage (forwards in meta)
  → main.js onArenaTreatPlaced/Eaten
  → webContents.send('mobile-arena-treat-placed', {treat, meta})
  → renderer ipcRenderer.on('mobile-arena-treat-placed')
  → promptCompanionReaction(prompt, meta.companionId)
  → routes to that companion's chat
```

`promptCompanionReaction(promptText, targetAgentId)`
gained an optional second argument. When passed and
valid, it routes the reaction to that specific
companion; otherwise falls back to the
`activeChatAgentId` behavior.

The deterministic memory append in the renderer's
IPC handler is also routed to the same companion
(previously it used `activeChatAgentId`), so the
memory entry matches the speaker.

### 2. Persistent "jump to bottom" button (Tobe: "add a go to bottom button in the lower right side of the chat")

Distinct from the existing centered
"↓ N new messages" badge (which only shows when
`chatUnreadCount > 0`):

- New small circular 40×40 button in the
  **lower-right** of the chat list
- Always visible whenever the user is scrolled
  away from the bottom (`!chatAtBottom`)
- Hidden when the user IS at the bottom (nothing to
  scroll to)
- Tap → `chatRef.scrollToEnd({ animated: true })` +
  clear unread count
- 20px ⬇ glyph on a `rgba(0,0,0,0.55)` circular
  background with a subtle shadow
- `zIndex: 11` (one above the unread badge's `zIndex: 10`)
- `accessibilityLabel="Jump to latest message"`,
  `accessibilityRole="button"`

## Why both changes in one release

Tobe's two requests came in adjacent Discord messages
within 10 minutes of each other and are both tiny +
isolated. Shipping them as one mobile version saves
an extra APK build + install cycle.

## Files

- `src/screens/HomeScreen.tsx`:
  - forward `companionId` in the
    `treat_placed` / `treat_eaten` handlers (lines
    ~1378-1420)
  - new `chatJumpToBottomBtn` / `chatJumpToBottomText`
    styles (in the StyleSheet block at the bottom)
  - new floating button rendered inside the chat
    list (just below the existing unread badge)
- `android/app/src/main/assets/arena.html`:
  - `treat_eaten` notifyRN now includes
    `companionId: c.id`
  - `treat_placed` notifyRN now finds the nearest
    companion (L∞ ≤ 300px) and includes
    `companionId: nearestC.id`
- `package.json`: bump `3.10.137` → `3.10.138`
- `android/app/build.gradle`: bump versionCode 361 → 362,
  versionName "3.10.137" → "3.10.138"

## Mobile ↔ desktop pairing

This mobile release pairs with **desktop v3.2.79**,
which has the matching changes:
- `sync-server.js`: forwards `companionId` from the
  WS message into the meta payload
- `src/js/app.js`: `promptCompanionReaction(promptText, targetAgentId)`
  gained the optional second arg, and the
  `mobile-arena-treat-placed` / `mobile-arena-treat-eaten`
  IPC handlers pass `meta.companionId` through

Both versions can ship independently — the older
version just won't have attribution (mobile sends
companionId, desktop ignores it; or vice versa).

## Verification (for Tobe)

1. Install the v3.10.138 APK.
2. Drop a treat on the mobile arena.
3. Expected: clawsuu/lamasuu (whichever sprite is
   closest / ate it) responds, regardless of which
   chat tab is open.
4. Expected: log shows `[mobile-treat] placed: <treat>
   (near <companionId>)` (or `(by <companionId>)` for
   the eaten event).
5. Open the chat tab, scroll up → expect the small
   circular ⬇ button appears in the lower right.
6. Scroll to bottom → button disappears.
7. Restart desktop for v3.2.79 to take effect.