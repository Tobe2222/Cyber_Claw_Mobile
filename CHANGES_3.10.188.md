# v3.10.188 — Slider: honor live `disabled` prop changes

Tobe (2026-09-04 19:27, Discord #cyber-dev): "@Clawsuu i cant
change scale for some reason in the companion editor"

## Repro

1. Open CyberClaw Mobile.
2. Settings → pick companion → 🎨 Looks → Edit ›
3. Try to drag the Size slider.
4. Nothing happens. The thumb doesn't move. The preview
   above doesn't change.

## Root cause

The mobile `Slider` component (src/components/Slider.tsx) builds
its PanResponder inside a `useRef(PanResponder.create({...}))`
call. The `useRef(...)` initializer runs exactly ONCE per mount —
the closures inside `PanResponder.create` capture the value of
`disabled` at that initial moment.

CompanionEditScreen mounts the Scale slider with
`disabled={!hydrated}` and `hydrated` starts at `false`. So at
mount time `disabled = true`. The PanResponder is created with
closures that return `!true === false` from
`onStartShouldSetPanResponder` and `onMoveShouldSetPanResponder`.

Then the hydrate useEffect runs, `setHydrated(true)` fires,
`disabled` becomes `false`, the slider re-renders with a
transparent thumb (no `disabledStyle` opacity anymore). But the
PanResponder was created on the FIRST render and is now stale —
its `onStartShouldSetPanResponder` closure still returns
`false`. Touches pass through to the parent ScrollView.

This bug was latent since v3.10.93 when the Slider was added.
The chattiness slider in the Behaviour editor has the same
issue. Tobe didn't notice until v3.10.187 put the live preview
above the scale slider — making the lack of feedback obvious.

## Fix

Add a `disabledRef` that mirrors the `disabled` prop on every
render (same pattern as the existing `valueRef`). Read from
the ref inside the PanResponder closures:

```js
const disabledRef = useRef<boolean | undefined>(disabled);
// ... on every render:
disabledRef.current = disabled;

const panResponder = useRef(
  PanResponder.create({
    onStartShouldSetPanResponder: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onPanResponderGrant: (e) => {
      if (disabledRef.current) return;
      onChange(valueFromX(e.nativeEvent.locationX));
    },
    onPanResponderMove: (e) => {
      if (disabledRef.current) return;
      onChange(valueFromX(e.nativeEvent.locationX));
    },
  }),
).current;
```

The ref is stable across renders, but `disabledRef.current` is
mutated on every render so the closure always reads the latest
value when invoked.

Same pattern was already used for `valueRef.current` (the
slider needs the latest value when computing the snap position
on every drag tick).

## Files changed

- `src/components/Slider.tsx` — added `disabledRef`, updated
  PanResponder closures to read `disabledRef.current` instead
  of the captured `disabled` prop.
- `package.json` (3.10.187 → 3.10.188), `android/app/build.gradle`
  `versionName` and `versionCode` (394 → 395).

## Verification

- TypeScript: `tsc --noEmit` produces no new errors in
  Slider.tsx.
- Mental test:
  1. Component mounts with `disabled={true}` → `disabledRef.current = true`
  2. PanResponder created, closures read `disabledRef.current`
  3. Hydrate completes → re-render → `disabledRef.current = false`
  4. User drags → `onStartShouldSetPanResponder` returns
     `!false === true` → PanResponder claims touch
  5. `onPanResponderGrant` checks `disabledRef.current` →
     `false` → calls `onChange(valueFromX(...))`
  6. Parent setState updates scale → preview re-renders
- This also fixes the chattiness slider which had the same
  latent bug (Tobe may not have noticed because he hadn't
  tried to change chattiness since the Looks editor split
  moved that control into its own screen in v3.10.186).

## General lesson

**Stale closure of props in event handlers attached via
`useRef(useEffect(() => ...), [])` or `useRef(createX({...}))`
is the canonical "this works once then breaks forever" bug in
React Native.** The thumb renders correctly, the prop updates
correctly, the disabled style correctly drops the opacity —
but the responder is stale. Two fixes are common:

1. **Mirror the prop into a ref** (this fix). Stable ref
   container; the closure reads the latest value when invoked.
   Best for props that change infrequently and the responder
   handlers don't need to be re-attached.

2. **Re-create the responder when the prop changes** via
   `useMemo([prop])` or by putting it in state. Best when the
   responder setup itself depends on the prop (e.g. different
   gesture thresholds for different modes).

The ref-mirror pattern is what the slider already uses for
`valueRef`, so adding `disabledRef` is consistent with the
existing style.

A useful diagnostic test for this bug class: mount a control
with `disabled=true`, then flip to `disabled=false` after a
delay, then try to interact. If the control is dead, it's
stale-closure of `disabled`. Add a ref, fix it.
