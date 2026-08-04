# v3.10.133 — Thinking indicator persists during long waits + brighter companion text in dark mode

## Thinking indicator: keep showing until reply (or error) lands

**Tobe 2026-08-04 10:25 (Discord):**
> "there is a small delay or issue on mobile with the clawsuu is
> thinking still. It says that he is thinking for about 5-10 seconds,
> then it takes some time before the reply comes, perhaps a minute or
> two. From a user perspective it could seem that something has gone
> wrong, it should say he hes thinking until a reply comes, and if
> something actually goes wrong it should say that Instead."

**The bug:** the mobile's chat-bubble disappearance timing depends
on the desktop's `typing: false` broadcast. Sometimes the desktop
fires `typing: false` before the agent reply round-trips through
`sync-broadcast-chat`, so the bubble vanishes mid-flight and the
user sees a 1-2 minute quiet gap before the reply lands. Looks like
the agent died.

**The fix:** `typing: false` is now a no-op on its own. The bubble
clears ONLY when a real terminal event lands:

- An agent message arrives (`onChat` with `isUser: false`)
- The user sends a new message (which fires its own `typing: true` shortly)
- An `onSendError` fires (e.g. `audio_input` error)

The bubble persists for the entire wait, regardless of when the
desktop decides to clear typing.

**Long-wait escalation (mobile-side):** the desktop already
escalates its own bubble text at 8s/20s/45s/90s, but the mobile only
received the original "is thinking..." string. Three new mobile-side
escalations step the text to "is still working..." at 30s,
"is taking longer than usual..." at 90s, and
"is taking very long (model may retry in the background)..." at 4
minutes. Each timer is cancelled when a real terminal event lands, so
there's no stale "is taking very long..." after the bubble has
already cleared. The escalation chain reschedules cleanly on a
foreground transition (re-renders the right tier based on elapsed
time), so backgrounding the app for a minute doesn't lose the
progress context.

**Implementation details:**

- `thinkingStartedAtRef` (`useRef<number | null>`) — timestamp the
  bubble went up; used by the foreground-restore logic to pick
  the right escalation tier to render.
- `thinkingEscalateTimerRef` (`useRef<setTimeout | null>`) —
  currently-armed escalation timer, cancelled on agent-message
  arrival or a fresh `typing: true`.
- The timer is cancelled on HomeScreen unmount so a mid-wait
  navigation away doesn't leave a dangling setTimeout that tries
  to `setState` on an unmounted component.

**Error path:** the desktop already broadcasts error messages
(`addChatMsg('error', ...)` → `sync-broadcast-chat`) since v3.2.46.
On the mobile, errors arrive as `chat_message` with `isUser: false`
and the cleared bubble mechanism treats them identically to agent
replies — the user sees "Error: ..." in the chat immediately. No
special handling needed; the bubble clears the same way it would
for a successful reply. Tobe's "if something actually goes wrong it
should say that" is satisfied: any IPC timeout, transport failure,
or context-assembly error from the desktop lands as a chat bubble
on the mobile too.

## Companion text brighter in dark mode

**Tobe 2026-08-04 10:25 (Discord):**
> "we need to brighten the companion text, its hard to see in dark
> mode, the Orange is too dark, make it lighter."

**The fix:** `brand.accentDim` in all three themes was bumped to
a brighter, more legible orange for chat text:

- **dark theme:** `#cc5528` → `#ffaa3f` (matches the existing
  `accentBright`; readable on the deep-space `#050510` background).
- **light theme:** `#cc5528` → `#d97e0e` (still a deep-but-warm
  orange that reads clearly on white).
- **forest theme:** `#cc5528` → `#d97e0e` (matches light theme;
  same rationale).

`accentDim` is only used in `HomeScreen.tsx`'s `aiText` style
(companion message text). The change affects every companion
message in dark/light/forest mode without touching other
orange-using UI (border accents, arena elements, nav buttons all
use `accent` directly, which is unchanged).

## Files

- `src/screens/HomeScreen.tsx`:
  - Added `thinkingStartedAtRef` + `thinkingEscalateTimerRef`
  - `onTyping` now schedules 30s/90s/4min mobile-side escalations
    and treats `active: false` as informational-only (no bubble
    clearing on its own).
  - `onChat` cancels the escalation timer + clears the started-at
    ref on agent-message arrival.
  - AppState-foreground handler picks the right escalation tier
    when re-applying the bubble.
  - Cleanup effect cancels pending escalation timers on unmount.
- `src/theme/tokens.ts`:
  - `darkTheme.brand.accentDim`: `#cc5528` → `#ffaa3f`
  - `lightTheme.brand.accentDim`: `#cc5528` → `#d97e0e`
  - `forestTheme.brand.accentDim`: `#cc5528` → `#d97e0e`
  - Updated `accentBright` for dark theme to `#ffc66d` (one tier
    above the new `accentDim`) for any future use.
- `package.json` + `android/app/build.gradle`:
  - `3.10.132` → `3.10.133`
  - `versionCode 356` → `357`
