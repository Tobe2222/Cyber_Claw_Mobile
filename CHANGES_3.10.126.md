# v3.10.126 — persist chat scroll position per agent

## 1. Chat restores its scroll position when Home re-opens

**Tobe's report (2026-08-02 17:28):**
> "each time home screen comes the chat Auto scrolls to the
> bottom, but why does it even start at the top. Cant it just
> stay where it got left?"

**Root cause:** The FlatList re-mounts every time the user
navigates away from Home and back. The first-layout
`scrollToEnd` ran unconditionally (gated only by
`chatLayoutSeenRef` so it didn't re-fire on re-layouts within
the same mount). The user's last scroll position was lost.

**Fix:** Persist the FlatList's `contentOffset.y` to AsyncStorage
keyed by `agentId`. Restore on first layout via
`scrollToOffset` instead of `scrollToEnd`.

- New state `chatScrollOffsetByAgent: Record<string, number>`.
- Mirror in `chatScrollOffsetRef` so the scroll handler can
  read it without re-renders.
- `onScroll` writes the current `contentOffset.y` to the ref on
  every scroll event (cheap), and schedules a debounced
  AsyncStorage write (250ms) so a fast swipe gesture coalesces
  into a single write.
- Mount-time hydrate effect reads the persisted map, mirrors
  into the ref, and captures the saved offset for the agent
  that was active at mount into `chatRestoreOffsetRef`.
- First-layout handler:
  - If `chatRestoreOffsetRef` is a positive number, restore
    via `scrollToOffset` (two attempts at +50ms and +300ms so
    the second one lands after the FlatList measures its
    content — same v3.8.6 pattern).
  - Otherwise (first-ever open, or no saved offset), use the
    v3.8.6 / v3.10.111 `scrollToEnd` behavior unchanged.
- Per-agent keying means Clawsuu's chat remembers its
  position independent of Lamasuu's.

**Caveat:** If the user was at the bottom when they left,
restoring the exact offset puts them slightly above the new
content's bottom (new messages may have arrived). The
onScroll handler will flip `chatAtBottom` to true once the
user scrolls within 50dp of the new bottom — no special
"is-the-saved-offset-still-the-bottom" detection needed.
The first content size change after the restore also fires
the auto-scroll if chatAtBottom is true.

## Files changed

- `src/screens/HomeScreen.tsx`:
  - New state `chatScrollOffsetByAgent` and refs
    `chatScrollOffsetRef`, `chatRestoreAgentRef`,
    `chatRestoreOffsetRef`, `chatScrollSaveTimerRef`.
  - New mount-time hydrate effect that reads the persisted
    map and captures the active agent's offset.
  - `onScroll` extended with the debounced AsyncStorage write.
  - `onLayout` updated: if there's a saved offset for the
    active agent, restore it via `scrollToOffset` instead of
    `scrollToEnd`. Falls back to scroll-to-end for first
    opens.
- `package.json` — version 3.10.125 → 3.10.126
- `android/app/build.gradle` — versionCode 349 → 350

**v3.10.126 (versionCode 350).**
