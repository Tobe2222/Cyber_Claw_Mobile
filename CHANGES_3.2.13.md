# v3.2.13 — Wake trainer: fix the missing `useEffect` wrapper that left SettingsScreen rendering blank

v3.2.12 broke the SettingsScreen — the screen rendered
completely black except for the "Connected to Desktop"
toast at the bottom. Cause: I added a wake-listener
stop/start in SettingsScreen but forgot to wrap them in
a `useEffect()` call. The `stopOwwListening()` call ran
on every render, and the `return () => { ... }` returned
from the entire component function — so the component
returned `undefined` and React rendered nothing.

This release wraps the wake-listener stop/start in an
empty-deps `useEffect`, matching the structure used in
the trainer.

**Lesson (the OBVIOUS one):** when copy-pasting a
`useEffect` block from one file to another, verify
the wrapper is actually there. The earlier useEffect
block on lines 179-187 was already there for the
back-handler, so the next useEffect block I added
should have followed the same `useEffect(() => {...},
[deps])` shape. Instead I wrote:

```ts
WakeWordModule?.stopOwwListening?.().catch(() => {});
return () => {
  WakeWordModule?.startOwwListening?.().catch(() => {});
};
```

as top-level code (between two existing useEffects).
The `return` returned from the component function.

**Lesson (a bigger one):** I had JUST fixed a 5-line
React lifecycle bug (v3.2.12's listener management) and
the very next change introduced a different React
lifecycle bug. The lesson: when working in a file
you're not familiar with, read the whole function
you're editing before adding new code. The "back
handler useEffect" pattern was right next to where
I added the wake-listener code — I should have just
added my code inside an existing useEffect or used
the same shape. The shape mismatch was a smell I
missed.

**Files:**

- `src/screens/SettingsScreen.tsx` — wrap the
  `stopOwwListening()` and `startOwwListening()` calls
  in `useEffect(() => {...}, [])`.
- `package.json` — 3.2.12 → 3.2.13
- `android/app/build.gradle` — versionCode 158 → 159
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.13