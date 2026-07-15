# v3.10.27 — fix Settings screen crash on open (named import for ClassifierTestPanel)

**Symptom:** v3.10.26 crash on opening Settings → 🔗 Connection section (actually
crashes during initial render — the first Section that contains an instance of the
failing component):

```
Error in CyberClawMobile
com.facebook.react.common.JavascriptException: Error: Element type is invalid:
expected a string (for built-in components) or a class/function (for composite
components) but got: undefined.
This error is located at:
  at RCTView (<anonymous>)
  at View_withRef (...)
  at Section (...)
  ...
  at SettingsScreen (...)
```

The `at Section (...)` in the stack told me which named component was the parent —
the failing element is a child of a Section inside SettingsScreen.

**Cause:** the new `ClassifierTestPanel` was imported as DEFAULT in both SettingsScreen
and CompanionSettingsScreen:

```ts
import ClassifierTestPanel from '../components/ClassifierTest';
```

But the component is defined as a NAMED export in `src/components/ClassifierTest.tsx`:

```ts
export function ClassifierTestPanel({ kind, labelOverride, hintOverride }) { ... }
```

There is NO `export default` in that file. So `ClassifierTestPanel` resolves to
`undefined` at the import site. When JSX tries to render `<ClassifierTestPanel ... />`,
React says "element type is invalid: expected a class/function but got: undefined".

Same pattern would have applied to `useClassifierTest` if I'd imported it as default
(it was correctly imported as named — saved by the destructuring syntax `{ useClassifierTest }`).

**Why tsc didn't catch this:** TypeScript's `noImplicitAny` doesn't catch "default
import resolves to undefined because there's no default export" — `tsc --noEmit`
ran clean. The bug only surfaces at runtime when JSX renders the imported value.

Metro would have caught this at bundle time if the export was missing entirely (the
import statement itself fails). But Metro IS happy here — `import X from 'mod'` is
valid syntax even if the module has no default export. The runtime `undefined` only
appears when React tries to USE the value.

**Fix:** switch to named imports in both screens:

```ts
// before
import ClassifierTestPanel from '../components/ClassifierTest';
import ClassifierTestPanel, { useClassifierTest } from '../components/ClassifierTest';

// after
import { ClassifierTestPanel } from '../components/ClassifierTest';
import { ClassifierTestPanel, useClassifierTest } from '../components/ClassifierTest';
```

One-word diff per file. The component file itself is unchanged.

**CompanionSettingsScreen would have crashed too** if Tobe had reached the Wake sub-page
in v3.10.26 — same bad import. (Tobe reported the Settings crash first because that's
where SettingsScreen renders both new components — `VoiceEnrollmentBar` was default-imported
correctly and `ClassifierTestPanel` was broken. The Voice mode section in SettingsScreen
is the first place ClassifierTestPanel renders because it's lower on the page than the
Wake sub-page in CompanionSettingsScreen.)

**Build artifacts:**
- `package.json`: 3.10.27
- `android/app/build.gradle`: versionCode 254, versionName 3.10.27
- Modified: `src/screens/SettingsScreen.tsx` (import line only)
- Modified: `src/screens/CompanionSettingsScreen.tsx` (import line only)

## Lesson (codified — repeat of the v3.10.22 lesson)

For components with multiple exports (`useClassifierTest` + `ClassifierTestPanel`),
ALWAYS use named imports — `import { X, Y } from './mod'`. Default-importing a
named-export-only file silently resolves to `undefined`, which doesn't fail at
type-check or bundle time — only at runtime, only on the screen that renders the
component, and only as the cryptic "Element type is invalid: ... got: undefined"
error.

The reason this shipped through `tsc`: the import statement is valid TypeScript
(regardless of whether the module has a default export). The runtime `undefined`
isn't caught by type analysis.

The reason this shipped through Metro: the import statement is valid ES syntax —
Metro just transpiles it; it doesn't check what's actually exported.

The reason this shipped through manual review: I added the import and the JSX in
the same commit without separately verifying each — `grep -n 'ClassifierTest' SettingsScreen.tsx`
showed the imports and uses, but didn't show the export kind.

**New review rule (codified):** for every `import X from './foo'` line, verify
that `./foo` actually has `export default X` (or close enough — `export default
function X`). `grep -n '^export' ./foo.tsx` is the one-line check. If `X` is a
NAMED export, the import MUST be `{ X }`. If neither, the import resolves to
undefined and the JSX crashes on render.

This is the THIRD instance of this bug class:
1. v3.10.21 → v3.10.22 — `addLogEntry` ReferenceError in CompanionSettingsScreen
   (imported as default from a module that didn't have a default export)
2. (earlier session in MEMORY.md) — `getPermissions` typo'd references in SettingsScreen
3. v3.10.26 → v3.10.27 — `ClassifierTestPanel` undefined in SettingsScreen

The pattern: when extracting a hook + component into a shared file, default
exports feel natural ("one main thing per file") but only work if you REMEMBER
to actually write `export default`. With multiple exports (hook + component +
types), the named-import path is safer — there's no default-export ambiguity to
fall into.

**Audit recommendation:** every `import X from './path'` should pass:
- `grep -n 'export default' ./path.tsx` returns at least one match,
  OR
- `grep -n "^export.*function X\|^export.*const X" ./path.tsx` returns a match
  (and the import uses `{ X }` syntax).

Apply this audit to all 4 consumers of `../components/ClassifierTest` and
`../components/VoiceEnrollmentBar`:
- SettingsScreen.tsx (both components imported)
- CompanionSettingsScreen.tsx (ClassifierTest)
- WakeModeScreen.tsx (VoiceEnrollmentBar — already verified correct)
- App.tsx (none of these)

Verified all are correct as of v3.10.27.

## What's NOT in v3.10.27

- **Wake-did-poorly diagnostic** — Tobe mentioned "it did poorly" in
  v3.10.26 feedback; that landed before the crash blocked further testing.
  Once Tobe can actually open Settings in v3.10.27, the test panel will
  reveal the peak score. v3.10.28 will add the speaker-match diagnostic to
  the wake test result if Tobe's report suggests the gate is suppressing.
- **Exit + send speaker-gating** — still v3.10.28.
- **EMA drift** — still v3.10.28.