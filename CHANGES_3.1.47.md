# 3.1.47 — Restore Chat/Events/Log tab emojis, drop robot only

## What it fixes
In v3.1.46 I over-corrected: removed ALL emojis from the tab labels. Tobe only wanted the **robot emoji** gone (the fallback used when `a.emoji` is missing on a companion tab). The chat bubble (💬), scroll (📜), and clipboard (📋) on the Chat/Events/Log tabs were fine and should stay.

## The fix

### Tab labels restored
`HomeScreen.tsx:2447`:
- `Chat` → `💬 Chat`
- `Events` → `📜 Events`
- `Log` → `📋 Log`

### Robot emoji removed from companion tab fallback
`HomeScreen.tsx:2532` — changed from:
```jsx
<Text style={styles.companionTabEmoji}>{a.emoji || '🤖'}</Text>
```
to:
```jsx
{a.emoji ? (
  <Text style={styles.companionTabEmoji}>{a.emoji}</Text>
) : null}
```

So if the desktop sends `a.emoji`, we show it. If not, we show nothing — just the companion name. No more robot.

## Files changed
- `src/screens/HomeScreen.tsx` — restored Chat/Events/Log emojis, removed robot fallback on companion tab
- `package.json` — 3.1.46 → 3.1.47
- `android/app/build.gradle` — versionCode 96 → 97, versionName "3.1.47"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.47
- `CHANGES_3.1.47.md` (new)

## What I deliberately did NOT change
- The tab padding (`paddingVertical: 4`) from v3.1.46 — Tobe was happy with the more compact bar.
- Anything else from v3.1.46 (shadows off, voice/wake buttons, scale handling, state machine).

## Lesson
Read the user's feedback literally. "Remove the robot emoji" means ONLY the robot emoji, not all emojis. I extrapolated too aggressively.