# 3.1.68 — Companion picker is a proper modal, with sprite icons

## What it adds
Tobe: "When clicking wake word training i get this Prompt now. It really should be a meny after clicking wake training with the companions in a list and a related icon. This companion icon we could perhaps set as a property of each sprite we use for the companions. We can use that icon in the text channel also, with the icon beside the companion name for the text channels. A related emoji icon for each sprite which are applied to the companion."

The mobile wake-trainer companion picker was using the native Android `Alert.alert` — functional but ugly. Tobe wants a proper picker with companions in a list, each with a related icon. The icon should be a property of the sprite itself, so adding a new sprite gives it a consistent icon across the wake trainer, chat tabs, and chat message labels. The desktop catalog now carries an `icon` per sprite (desktop v3.1.21); the mobile reads that field from the `agents_list` WebSocket payload.

## Change 1: Sprite icons flow from the desktop catalog
The desktop now sends an `icon` field per agent in the `agents_list` broadcast. Resolution order on the desktop: per-agent `emoji` (user override in the agent editor) → sprite `icon` (catalog default) → `null`. The mobile accepts the field, stores it in the cached agents list, and falls back to 🐾 in the picker if neither is set.

Catalog icons (desktop v3.1.21):
- fox 🦊
- boar 🐗
- deer 🦌
- hare 🐇
- black_grouse 🦚

## Change 2: Wake-trainer companion picker is a proper modal
The native `Alert.alert('Train wake word for which companion?', ...)` is replaced with a custom modal sheet. The sheet:
- Rises from the bottom of the screen with a dimmed backdrop
- Shows each companion in a row: [icon] [name] [train →]
- Has a Cancel button that closes the sheet
- Tapping the backdrop also closes it
- Tapping a row sets the training companion and opens the trainer

The single-companion case (length === 1) still skips the picker and goes straight to the trainer — same as before.

## Change 3: Chat tabs and chat messages use the sprite icon
The HomeScreen companion tab bar already used `a.emoji` (v3.1.48). Now it also falls back to `a.icon` (the new sprite-icon field) when the agent has no custom emoji. Same fallback in the chat message labels and the "Say hi to X" hint.

For users who already had a custom emoji set on their agent, nothing changes. For users who didn't, the sprite's catalog icon now shows up automatically next to the name.

## Files changed
- `android/app/src/main/assets/companions/catalog.json` — mirror of desktop v3.1.21
- `App.tsx` — `agents` state type now includes `icon?`
- `src/screens/SettingsScreen.tsx` — new `Modal` import, `showCompanionPicker` state, extended `availableCompanions` type, custom modal UI, modal styles
- `src/screens/HomeScreen.tsx` — `icon?` field in agents types, fallback in chat tab emoji + chat message label + "Say hi" hint
- `package.json` — 3.1.67 → 3.1.68
- `android/app/build.gradle` — versionCode 117 → 118, versionName "3.1.68"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.68
- `CHANGES_3.1.68.md` (new)

## Lesson: native system UI is the wrong default
A native `Alert.alert` is a fast way to ship a picker, but on Android it looks like 2010-era system UI and doesn't match the rest of the app. Tobe's feedback was clear: the picker should look like part of the app, not a system prompt. The cost of building a custom modal is small (Modal + Pressable + styles), and the win is that the picker now fits visually with the rest of the settings screen — and the same component can be reused for other multi-option pickers later (e.g. picking a sprite for a new companion, picking a custom wake phrase from a preset list).

## Lesson: sprite-level config vs agent-level config
The icon belongs to the sprite, not the agent. Putting it in the sprite catalog means adding a new sprite automatically gives it a consistent icon across the mobile, the wake trainer, the chat tabs, and any future feature that shows companion icons. Per-agent `emoji` is still supported (for custom agent personalities), but the catalog is the source of truth for the default. This is the same pattern as the sprite's name and folder — they're sprite-level data, not agent-level data.

## Known issue: the picker uses 🐾 when the agent has no emoji AND no icon
For agents that have a custom sprite not in the catalog (e.g. user-added dragon sprite from a future catalog update), the picker will show 🐾. The fix is to add the sprite to the catalog with an `icon` field. Existing catalog sprites all have icons set.
