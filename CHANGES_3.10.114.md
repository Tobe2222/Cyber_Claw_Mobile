# v3.10.114 — Full HomeScreen inner-style migration: forest + sky

## The request

Tobe (Discord #cyber-dev 2026-07-30 19:16 GMT+2):

> "just ship the full thing, dont complicate it. And I want green
> and blue, especially heavy around the arena and below the chat.
> The chat can be more of the White. Green for forest, blue for sky."

Tobe's view of the v3.10.113 home screen: the chrome was
forest-themed, but the chat bubbles were still dark navy with
orange text, and the companion tab bar was still dark. The
chat looked like a dark "patch" floating in a light-mode page.

His direction:
- Full inner-style migration (not a "settings-only" cut)
- Heavy forest green AROUND the arena (border)
- Heavy forest green BELOW the chat (companion tab bar)
- Sky blue in the chat (event log, companion name labels,
  user bubble accent)
- Chat itself = more white (white bubbles, soft cream bg)

## What ships

### HomeScreen — full inner-style migration

Theme tokens applied to every visible style in the chat, the
events tab, the log tab, the message input, and the arena frame.
The arena (WebView) and its dark `#0a0a2e` background remain
deliberately dark — they're media content, not chrome.

#### Arena frame (heavy forest)
- New `arenaFrame` style: 3px forest green border, 6px border
  radius around the WebView. The arena's parent View previously
  had a 2px orange bottom border; now it has a 3px forest
  green border on all 4 sides.
- The orange border is gone. Tobe asked for green, so the
  arena reads as "framed by forest" — matches the "heavy
  around the arena" instruction.

#### Companion tab bar (heavy forest)
- Background changed from `#0a0a14` (very dark navy) to
  `t.brand.accentDim` (forest green darker than the primary).
  Border-bottom: forest mid.
- Companion tab placeholder text: muted forest.

#### Chat list (soft cream + white bubbles)
- `chatList` background: `t.bg.primary` (soft sage/cream).
- `messageBubble` base: white (`t.bg.secondary`) with subtle
  border. Both user + AI bubbles are white.
- `userBubble`: white bg, sky-blue 1.5px border (top right
  corner is straight for the "from you" anchor).
- `aiBubble`: white bg, forest-green 1.5px border (top left
  corner is straight for the "from companion" anchor).
- `agentLabel` (small label above each bubble): muted text
  in the bubble's accent color (sky for user, forest for AI).
- `userText` / `aiText`: high-contrast text in the accent
  color (sky-blue dim, forest green dim). Bumped font size
  from 12 → 13 and line-height from 16 → 18 for better
  readability on white bg.
- `timestamp`: muted gray.

#### Tab bar, header, input (already themed in v3.10.113)
- No changes — those were already correct.

#### Events tab (sky blue)
- `eventLine`: sky blue (`t.brand.cyan`) — was bright blue
  `#3b82f6`, now matches the rest of the sky palette.

#### Log tab (sky blue, themed)
- `logList` background: soft cream (matches chat list).
- `logLine`: muted text.
- `logSent`: sky blue (was `#4a9eff`, now `t.brand.cyan`).
- `logReceived`: success green (was `#4ade80`, now
  `t.brand.success`).
- `logError`: danger red (was `#ff0000`, now `t.brand.danger`).
- `wakeDebugBar` background: themed (`t.bg.tertiary`), was
  semi-transparent black.
- `wakeDebugText`: success green.

#### Send + mic buttons (forest green in light mode)
- `sendButton`: forest accent (`t.brand.accent`) with inverse
  text. Was neon orange `#f7931a`.
- `sendButtonDisabled`: muted border.
- `micButton`: forest accent glow with forest border. Was
  `rgba(247,147,26,0.12)` orange.

## Files

- `src/screens/HomeScreen.tsx` — all chat, arena-frame, tab,
  events, log, mic, send styles migrated. 12 style blocks
  updated, 2 new (`arenaFrame`, `arenaFrameFullscreen`).

## Verification

- `npx react-native bundle --platform android --dev false`
  → bundle writes successfully.
- `npx tsc --noEmit` → no new errors.
- Manual bundle inspection: no module-scope `StyleSheet.create`
  calls reference `t.bg.*` or `t.brand.*` (the bug class from
  v3.10.113 fix #2). All theme references are inside
  function bodies.
- `grep` for `var [a-z]=.*StyleSheet.create` in the bundle:
  18 module-scope calls, all using literal hex values, no
  free theme references.

## Lessons

- **Full inner-style migration per screen is a lot of
  changes per file but each individual change is small.**
  HomeScreen has ~12 style blocks. The 3.10.113 root-tint
  approach (theme the root, leave inner styles alone) doesn't
  work because the chat bubbles sit AT the inner style
  layer. The full migration is the right call.
- **The arena frame was 1 inline style; converting it to a
  named style was easy once the inner-style migration was
  decided.** The inline `borderBottomColor: '#f7931a'` was
  hidden in the parent View of the WebView; promoting it
  to a `arenaFrame` style with all 4 borders is the
  natural way to give the arena a "frame" feel.
- **White bubbles with colored borders read better than
  colored bubbles.** Tobe's spec ("the chat can be more of
  the White") → user bubble white with sky blue border,
  AI bubble white with forest green border. Easier to scan
  (no color contrast issues reading the text), still
  distinguishable (border color tells you who said what).
- **Pre-push bundle check: grep the bundle for
  module-scope StyleSheet.create calls referencing theme
  tokens.** A 5-line node script that does this catches
  the v3.10.113 fix #2 bug class. Add to pre-push workflow.

## What's still dark

- Trainer sub-screens (OpenWakeWordTrainer, etc.) — full-screen
  modal flows, dark by design. Out of scope.
- CompanionEditScreen, QuestsScreen, WakeModeScreen — root
  container is dark. Full migration in v3.11.0.
- The arena WebView itself (its `arena.html` CSS) — that's a
  separate codebase (the desktop's arena). The arena is dark
  by design; the forest frame around it is the new look.

versionCode: 338
