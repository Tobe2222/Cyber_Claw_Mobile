# v3.11.29 — "No active quest" → "Casual chat" label rename

**Tobe 2026-10-04 10:46 (Discord #cyber-dev):**

> "Lets rename no quest chat to casual. It even jumped
> to casual when i gave food since the companions react
> to that, which is very good."

Cosmetic label rename on the mobile side. Companion-reaction
routing (v3.11.28 + desktop v3.3.31 `forceNoQuest: true`
flag) is unchanged — toy/snack bubbles still go to the
no-quest bucket; only the visible label changes.

## Labels renamed

1. **QuestsScreen "no active quest" card** (was `●  No active quest`
   in src/screens/QuestsScreen.tsx) → `●  Casual chat`. Same
   one-tap "I'm taking a break" toggle behavior — tapping the
   card still deactivates the current quest. The card sits
   right below the active quest per the v3.10.172 layout.

2. **Chat-message quest-change separator** (was `'No active quest'`
   in src/screens/HomeScreen.tsx line 6188) → `— Casual chat`.
   This separator renders above a bubble whose `activeQuestId`
   transitioned to/from null (entering / leaving the no-quest
   bucket). It's the per-bubble pill analog of the QuestsScreen
   card — both are now "Casual chat" so the user sees the
   same label everywhere.

The bubble-level "No quest" pill (`item.activeQuestId === null`
case in renderMessage) was already removed in v3.11.18 — no
label is rendered for null-stamped bubbles (avoids visual
noise). Nothing to do for that path.

## Why rename

Two reasons:

- "Casual" reads as an explicit chat name, not as a
  "missing" condition. The no-quest bucket is where
  companion-reaction bubbles (toy dropped, snack eaten,
  ball fetched) and pre-quest-setup casual conversation
  land. Calling it "casual" matches the user's mental
  model.
- The desktop counterpart already shipped in desktop
  v3.3.33 (`— Casual` per-bubble pill). Mobile-side
  rename keeps the labels in sync.

## Files changed

- `src/screens/HomeScreen.tsx` — quest-change separator
  label `'No active quest'` → `'— Casual chat'`.
- `src/screens/QuestsScreen.tsx` — no-active-quest card
  label `●  No active quest` → `●  Casual chat`.
- `package.json` — version bump to `3.11.29`.
- `android/app/build.gradle` — versionCode `423`,
  versionName `"3.11.29"`.

## Deploy

Companion mobile change. New APK required — both labels
are inside React components rendered on each render, so
the new strings ship in the JS bundle; no native changes.

## Verification plan

For Tobe to verify:

1. Open the Quests panel on the mobile, deactivate the
   current quest (tap the ⚡ ACTIVE badge to clear the
   pin). The card title should change from `●  No active
   quest` to `●  Casual chat`. Tap it again — same toggle
   behavior, just with the new label.
2. Open chat with a companion, type a message while no
   quest is active. The first bubble should NOT show a
   quest-change separator (nothing transitioned into). Then
   activate a quest, type a second message — the second
   bubble should show a separator above it that reads
   `🎯 <quest-name>`. Then deactivate the quest and type
   a third message — the third bubble should show
   `— Casual chat` as the separator.

## Cross-cutting note (2026-10-04)

The desktop `— Casual` pill (v3.3.33) and the mobile
`— Casual chat` separator / `●  Casual chat` card
(v3.11.29) need to ship in the same window. The
desktop label is just "Casual" (single chat name) and
the mobile labels are "Casual chat" (chat-context label)
— slightly different wordings because the contexts are
different (per-bubble pill vs per-quest chat-context).
The core concept is the same: the no-quest bucket is the
"casual chat".