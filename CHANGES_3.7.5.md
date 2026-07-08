# v3.7.5 — Arena Quests button + send-word description rewrite

Two small fixes from user feedback. No new wire protocol, no DB changes,
no quest CRUD on mobile. Same v3.7.4 quest list mirror, with two UI tweaks.

---

## 1. Quests button in the arena (top-left)

**Symptom:** Tobe: *"the button is missing in the arena. it should be located
at the top left in the arena, like voice mode but opposite."*

**What changed:**

- `android/app/src/main/assets/arena.html`: new `#ctrlLeft` container at
  `top:6px; left:6px` (mirrors `#ctrlRight` at `top:6px; right:6px`). Contains
  a `📜 Quests` button that posts `{type:'quests'}` to React Native via
  `ReactNativeWebView.postMessage`. Reuses the existing `.ctrlBtn` style.
  Hidden in wake mode via the existing `body.wake-mode #ctrlRight` pattern
  extended to `#ctrlLeft`.
- `src/screens/HomeScreen.tsx`: WebView message dispatcher now handles
  `msg.type === 'quests'`. Routes to the active chat companion
  (`activeChatAgentId`), falling back to the first available agent on cold
  start. Calls `onOpenCompanion(id, 'quests')`.
- `App.tsx`: new `companionScreenInitialPhase` state. `onOpenCompanion` prop
  plumbed through to `HomeScreen`. The `onBack` handler in
  CompanionSettingsScreen clears the phase so a subsequent "tap card" flow
  starts fresh on the overview.
- `src/screens/CompanionSettingsScreen.tsx`: accepts optional `initialPhase`
  prop (`'wake' | 'exit' | 'voice' | 'quests' | null`). Consumed by the
  `useState` initializer so the arena button deep-links straight into the
  Quests page instead of the cards. Rendered-pure-function pattern preserved
  (hooks still at screen level per the v3.7.1 lesson).

**Flow:**

1. User on home screen taps the 📜 Quests button (top-left of arena)
2. `arena.html` → `postMessage({type:'quests'})`
3. `HomeScreen` receives, looks up `activeChatAgentId` (falls back to first agent)
4. `HomeScreen.onOpenCompanion(id, 'quests')` → `App.tsx`
5. `App.tsx` sets `companionScreenId = id`, `companionScreenInitialPhase = 'quests'`,
   `setScreen('companion')`
6. `CompanionSettingsScreen` mounts with `initialPhase='quests'` → `companionViewPhase`
   starts at `'quests'` → renders `renderCompanionQuestsPage` directly
7. User taps back → `companionViewPhase = null`, `companionScreenId = null`,
   `setScreen('settings')`

**Why not put it on the Settings screen as a card (option b) or as a tab
(option c)?** Tobe said "in the arena, top left, opposite voice mode" — that
specific placement, not a layout question. The Quests page is one tap from
the companion's settings card anyway, so the arena button is a true shortcut
for users who already know which companion they're talking to (the most
common case — they're looking at the arena sprite for that companion).

---

## 2. Send-word description rewrite

**Symptom:** Tobe: *"the description for send in settings should be a backup in
case other systems like silence or gibberish detection don't kick in during
voice mode."*

**What changed:** `src/screens/SettingsScreen.tsx`, the Hint under
"✉️ Manual send voice message" (around line 1130).

**Before:**
> "The word you say during a voice-mode turn to commit the turn to the LLM
> (e.g. 'send', 'go'). Independent of the exit phrase — send keeps the
> conversation going, exit closes voice mode. Shared across all companions."

**After:**
> "Backup commit word for voice-mode turns. The primary trigger is
> silence-detection (the VAD's silence countdown) or gibberish-detection
> (VAD noise floor). When those miss — e.g. the silence threshold doesn't trip
> because the audio cuts off mid-word, or the VAD reads low noise as speech —
> saying this word commits the turn to the LLM by hand. Independent of the
> exit phrase — send keeps the conversation going, exit closes voice mode.
> Shared across all companions."

**Why:** the old wording framed the send word as the primary commit mechanism.
The reality is that the VAD handles ~95% of commits. The send word is the
escape hatch. The new wording says so explicitly so users (and future-Tobe)
understand that if the send word is firing often, the VAD needs tuning.

---

## Version

- `package.json`: 3.7.4 → 3.7.5
- `android/app/build.gradle`: versionCode 208 → 209

## Files touched

- `android/app/src/main/assets/arena.html` (CSS + body div)
- `src/screens/HomeScreen.tsx` (prop type + dispatcher handler)
- `src/screens/CompanionSettingsScreen.tsx` (prop + useState init)
- `App.tsx` (state + plumbing)
- `src/screens/SettingsScreen.tsx` (Hint text only)

## Not touched

- `src/services/SyncClient.ts` — no new wire protocol, the Quests handler
  from v3.7.4 is the same
- The render-functions in `CompanionSettingsScreen.tsx` — pure render pattern
  preserved, no new hooks added inside helpers