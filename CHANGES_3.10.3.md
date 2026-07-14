# v3.10.3 — Fix crash on companion click + remove green active indicator

Tobe tested v3.10.2 and reported:

1. **App crashes when tapping a companion in Settings**.
   `Error in CyberClawMobile — Rendered more hooks than
   during the previous render.` Stack trace points at
   `CompanionSettingsScreen`. Tobe couldn't open the
   per-companion page at all.

2. **Clawsuu row is green in Settings, like it's
   active. No need for that.** Tobe wants the list to
   look uniform across companions.

## Root causes

### #1 — Hook order crash on first render

In v3.10.2 I lifted `trainedExitPhrases` state to the
screen level so the Wake / Exit status lines on the
per-companion overview card could read it. But I put
it in the WRONG spot: AFTER the `if (!companion) return
<placeholder />` early return.

What happens:

- **Render 1**: cache hasn't hydrated yet →
  `availableCompanions` is `[]` → `companion` is
  undefined → early return fires. **My new hooks are
  never reached.**
- **Render 2**: cache hydrates → `availableCompanions`
  is populated → `companion` resolves → early return
  skipped → **my new hooks ARE reached**.

Different hook counts between renders → React's
`updateWorkInProgressHook` aborts with the
"Rendered more hooks than during the previous render"
error. The v3.7.1 same-hook-order bug class bit me
exactly the way I was trying to avoid.

The fix: move the hook declaration to BEFORE the early
return, alongside the other top-level state. The
`wakeStatusLine` / `exitStatusLine` derivations stay
after the early return (they depend on `companion.id`)
but they're plain const expressions, not hooks.

This is the same trap I documented in the v3.7.1
entry: hooks must run in the same order on EVERY
render. Conditional logic (early returns, dispatch
returns) can make hook counts diverge if you put a
hook inside or after the conditional.

### #2 — Active-wake green styling

The Settings companion row was using
`isActive = activeWakeCompanionId === c.id` to drive
three things: a green border, a green name color, and
a `◉` dot on the right. The styling was useful when
the row also showed wake status text (you could see at
a glance which companion was bound to the active wake).
After v3.10.2 moved the wake status into the per-
companion page, the green indicator is the only
remaining visual signal — and Tobe says it makes the
list feel uneven.

The fix: strip the active styling from the row. All
companions now look the same in the list. The active
binding is still tracked internally (state hydration,
OWW hot-swap, BG service sync) — it's just not
visualized in the list. To see which companion is
active, drill into the companion's Wake Settings;
the active wake is the one whose train button shows
✓ Active in the manager, and the phrase is highlighted
in the picker.

## Files

- `src/screens/CompanionSettingsScreen.tsx` — moved
  `trainedExitPhrases` useState + useEffect ABOVE the
  `if (!companion)` early return. `wakeStatusLine` /
  `exitStatusLine` derivations stay below the early
  return (they need `companion.id`).
- `src/screens/SettingsScreen.tsx` — removed the green
  active styling (border, name tint, ◉ dot) from the
  companion row. All companions now look uniform.
- `package.json` — 3.10.2 → 3.10.3
- `android/app/build.gradle` — versionName 3.10.2 →
  3.10.3, versionCode 229 → 230

## Lesson (sharpened from v3.7.1)

**Hooks must be declared BEFORE any conditional return
in a component.** Not just before dispatch returns
(`if (phase === 'a') return renderA(); if (phase === 'b')
return renderB();`), but also before early returns
(`if (!data) return <Placeholder />;`). The "lift state
to screen level" pattern is necessary, but it's only
correct if the lifted state is declared EARLY ENOUGH —
specifically, before every early return in the
component.

Rule of thumb: in a component with N hooks + M early
returns, the hooks must all live in the top N lines
of the component body, before any return. Hook
declarations after an early return break the rule on
the first render when the early return fires.

Forgotten check: when you "lift a hook" to fix a
crash, audit ALL the early returns in the component
to make sure the new hook is BEFORE all of them.
