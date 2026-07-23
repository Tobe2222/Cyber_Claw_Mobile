# v3.10.84 — Android back button / gesture-nav exits the app from QuestsScreen

Tobe reported on v3.10.83 (2026-07-23, ~12:40):

> "@Clawsuu when inside the quest menu the phone
> back swipe exits the program. It should just go
> back to the home screen"

## Root cause

QuestsScreen was rendered as a state-driven screen
(`App.tsx:567`: `{screen === 'quests' && <QuestsScreen
onBack={...} />}`). There's no native stack
navigation; the screen lives on top of the activity.
On Android, when there's no `BackHandler` intercepting
the hardware back press / gesture-nav back swipe,
the OS bubbles it up to the activity, which then
exits the app.

Compare to the rest of the app:
- `SettingsScreen.tsx:474` — has `BackHandler` with
  nested-modal priority (close trainers first, then
  onBack)
- `CompanionSettingsScreen.tsx:765` — same pattern
- `WakeModeScreen.tsx:2342` — same pattern

QuestsScreen was the only modal screen without a
BackHandler. Easy to miss in code review because
the visual back button (the chevron in the header)
already calls `onBack`, so the missing system-back
handling wasn't surfaced during normal interaction.

## Fix

Added a `BackHandler` to QuestsScreen that pops the
innermost modal first, then the screen itself:

```tsx
useEffect(() => {
  const sub = BackHandler.addEventListener(
    'hardwareBackPress',
    () => {
      if (confirm)      { setConfirm(null);    return true; }
      if (editorOpen)   { setEditorOpen(null); return true; }
      if (detail)       { setDetail(null);     return true; }
      onBack();
      return true;
    }
  );
  return () => sub.remove();
}, [onBack, confirm, editorOpen, detail]);
```

Each branch returns `true` to tell the OS "I handled
this" — preventing the event from bubbling up to
the activity and exiting the app.

## Priority order

The order matters because the user can be in one of
four states when pressing back:

1. **Delete-confirm dialog open** (`confirm` set) —
   close the dialog. The user was trying to cancel
   the delete, not navigate.
2. **Editor modal open** (`editorOpen` set) — close
   the editor. User was editing and wants to discard.
3. **Detail modal open** (`detail` set) — close the
   detail. User was viewing and wants to return to
   the list.
4. **At the list** — call `onBack()` to return to
   home screen.

Why this order: confirm is opened ON TOP of the
list (not from inside editor or detail), so it's
the innermost layer when present. Editor is opened
either from the list (✏️) or from the detail
(✏️  Edit button); when opened from detail, the
detail is closed first (existing flow), so editor
is the innermost when present. Detail is opened
from the list, so detail is innermost when present.

## Files changed

- `src/screens/QuestsScreen.tsx`:
  - Added `BackHandler` to the react-native imports
  - New `useEffect` that registers the back handler
    with nested-modal priority (close → editor →
    detail → onBack)
- `android/app/build.gradle` — versionCode 307→308,
  versionName 3.10.83→3.10.84
- `package.json` — version 3.10.83→3.10.84

## Lessons

**Every screen that lives on top of the activity
needs a `BackHandler`.** State-driven screens (like
QuestsScreen, set via `setScreen('quests')`) are
easy to forget because they look like normal React
navigation but don't get the React Navigation
back-stack for free. Whenever a new screen is added,
add a BackHandler in the same commit. Better: add a
checklist item to "modal screen added → verify
BackHandler is in place" so it doesn't get missed.

**Visual back buttons are not enough.** The chevron
in QuestsScreen's header already calls `onBack`, so
anyone tapping it gets the right behavior. But
Android users have muscle memory for the system
back — they don't look at the screen, they just
swipe. When the visual button works but the system
gesture doesn't, the user assumes the app is broken
("I press back and the app just closes"). Fix both
paths in the same change.

**The "easy to forget" code path is the one that
bites you.** BackHandler is a small line of code
that does nothing visible in the UI — there's no
rendering, no state, no animation. Reviewers can't
"see" it missing from a screenshot. The check for
its presence has to be deliberate (grep for
`BackHandler` across `src/screens/`) rather than
visual. Good candidates for a lint rule or a
"modal screen requires BackHandler" convention in
the project README.

**The "innermost modal first" pattern is reusable.**
SettingsScreen and CompanionSettingsScreen use the
same shape. Worth extracting to a shared
`useModalBackHandler(modals, onBack)` hook so
adding a new modal screen takes one line instead
of a five-line effect. Skipped for now to keep
the diff small, but worth doing in a future
refactor.