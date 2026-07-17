# v3.10.44 — Fix arena IIFE parse error from v3.10.43

v3.10.43 failed to build. The release workflow (`Build Android APK`
run #599, commit `c0979d1`) failed at the
`:app:createBundleReleaseJsAndAssets` task with:

```
FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:createBundleReleaseJsAndAssets'.
> Process 'command 'node'' finished with non-zero exit value 1
```

The error trail pointed at `@babel/parser/lib/index.js` but the
real cause was upstream: an unbalanced JSX structure in
`src/screens/HomeScreen.tsx`.

## Root cause

v3.10.43's arena change wrapped the existing
`{!keyboardVisible && (<View>...</View>)}` block in an IIFE
(`{!keyboardVisible && (() => { ... return (...); })()}`) so the
`sleepOverlay` flag could be derived inline. The IIFE itself is
syntactically valid JS, but the conversion only added the new
closing `)}` (line 2974) without supplying the missing structural
closings:

- `</View>` to close the outer arena `<View>` (opened at line 2902)
- The matching `)` for the inner `return (`

As a result the subsequent `{fullscreen && (...)}` voice-status
and voice-log blocks (lines 2977–2998) ended up as siblings of
the IIFE rather than children of the outer `<View>`. The Babel
parser threw `Unexpected token, expected ","` and the bundler
exited with code 1.

Note: the previous version (v3.10.42) had no `</View>` either,
but its top-level JSX shape (`{!keyboardVisible && (<View>...
<WebView /> ... )}`) was balanced because the `{fullscreen && ...}`
sibling blocks were correctly inside the View via JSX's
implicit-close behaviour in that shape. Wrapping the expression
in an arrow function changed the parse context enough to break
the balance.

## Fix

Reverted the arena block to the flat conditional shape from
v3.10.42 and moved the `sleepOverlay` derivation to the top of
the component (right after the agents-cache persistence
`useEffect`), so it's still a derived value derived from
`agents` + `activeChatAgentId` but doesn't require wrapping the
JSX in an IIFE.

```ts
// New (top of component, ~line 603)
const sleepOverlay = (() => {
  const active = agents.find(a => a.id === activeChatAgentId);
  return active?.sleepState === 'sleeping';
})();
```

```jsx
// Reverted arena block — same shape as v3.10.42
{!keyboardVisible && (
  <View style={...}>
    <WebView
      ...
      style={
        sleepOverlay
          ? { flex: 1, backgroundColor: '#0a0a2e', opacity: 0.65, transform: [{ scale: 1 }] }
          : { flex: 1, backgroundColor: '#0a0a2e' }
      }
      ...
    />
    {sleepOverlay && (
      <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 12, ... }}>
        <Text style={{ color: '#a78bfa', fontSize: 14, fontWeight: '700' }}>💤 sleeping</Text>
      </View>
    )}
    {/* voice-status + voice-log blocks (unchanged from v3.10.42) */}
  </View>
)}
```

Verified locally with `@babel/parser` 7.x — the file parses
cleanly. The runtime semantics of the sleep overlay are
unchanged (same `agents.find(...)?.sleepState === 'sleeping'`
check), so the visible behaviour should be identical to the
intended v3.10.43.

## What's preserved from v3.10.43

- `agents` state type extended with `sleepState?: 'awake' | 'sleeping'`
- `SyncClient.sendWakeAgent(agentId)` method
- `HomeScreen.sendMessage()` fires `sendWakeAgent` at the top
- `HomeScreen.enterVoiceMode()` fires `sendWakeAgent` at the top
- WebView `style={...}` uses the `sleepOverlay` ternary
- `💤 sleeping` pill overlay (pointerEvents="none", absolute,
  upper-right)

The auto-wake flow (mobile → desktop sync → state flip → broadcast
back) is intact. The only change vs v3.10.43 is *where*
`sleepOverlay` is computed — top of component instead of inline
in an IIFE.

## Files

- `src/screens/HomeScreen.tsx` — moved `sleepOverlay`
  derivation to top of component, reverted arena block to flat
  conditional
- `package.json` — 3.10.43 → 3.10.44
- `android/app/build.gradle` — versionName 3.10.43 → 3.10.44,
  versionCode 270 → 271

## General lesson (refined)

When wrapping an existing JSX expression in an arrow function
expression (e.g. `{cond && (jsx)}` → `{cond && (() => { ... return (jsx); })()}`),
the **JSX child balance changes** in a way that isn't visible
from the arrow-function syntax alone. The inner JSX must be
fully self-contained — every `<View>` opened before the `return (`
must be closed before the `)` that ends the return expression.

Specifically, if the original `<View>...</View>` had children
that came *after* a closing comment like `{/* Close button
removed */}` and additional conditional siblings, those siblings
now need to be **moved inside** the IIFE's `return ( ... )` —
otherwise they're siblings of the IIFE rather than children of
the View, and the parser's JSX-balance check will fail.

Rule of thumb: **before wrapping an existing JSX expression in
an arrow function, count the open/close tags from the wrapper
opening to the wrapper closing**. If you can't mentally match
them up without scrolling, don't do the wrap. Compute the
derived value at the top of the component instead and use it
directly in JSX — same logic, no balance risk.