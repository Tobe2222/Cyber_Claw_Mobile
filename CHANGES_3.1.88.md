# v3.1.88

## Hotfix: speak() was never being called

Tobe (after v3.1.87 screenshot): "Still no sound appears"

Voice log overlay showed only:
```
🔊 Greeting...      (status)
Matching: clawsuu   (init)
Matching: hey-clawsuu (init)
🎧 Listening for wake word...
```

The 🔊 Speaking / done / webview fallback lines that v3.1.85 / 86 / 87
added were **missing entirely** — because **speak() was never called**.

### Root cause

In v3.1.80 (two-phase wake), the greeting flow was:

```js
let greetingMs = 1500;  // default
let greetingText = 'Ready to chat';
// ... if stored, override greetingText (and greetingMs=0 for empty)
if (greetingMs > 0 && greetingText) {
  speak(greetingText);
}
setTimeout(() => { /* start listener */ }, greetingMs);
```

`greetingMs` did double duty:
1. Drove a fixed-delay setTimeout
2. Gated the speak() call (`if (greetingMs > 0 && ...)`)

In v3.1.85 (wait for greeting to finish), I removed the setTimeout
and replaced it with `await speak()`. I also changed
`let greetingMs = 1500` to `let greetingMs = 0` with a comment
"no longer drives a setTimeout" — but **I forgot to update the
`if (greetingMs > 0 && greetingText)` gate**. The new default was
0, so the gate was always false, so speak() was never called.

This bug shipped in v3.1.85, v3.1.86, and v3.1.87. The pre-warm
fix in v3.1.87 worked correctly, but it didn't matter because
speak() was never called to begin with.

The v3.1.84 screenshot (Tobe's earlier report) DID show
`🔊 Speaking: "Greetings master Toby"` because v3.1.84 still had
`greetingMs = 1500`. That's why the bug appeared to be a v3.1.85
regression when in fact v3.1.85 was when I introduced it.

### The fix

Remove `greetingMs` entirely. The check is now simply
`if (greetingText)` — which is only false when the user
explicitly set `cyberclaw-ready-phrase` to an empty string
(user explicitly disabled the greeting). For everyone else,
speak() is called.

The speak() Promise (v3.1.85) still gates the listener start
via `await speak()`, so the listener won't start until TTS
finishes (or the safety timeout fires). The pre-warm (v3.1.87)
still gives native TTS a head start. Both fixes are still
correct; the missing piece was just that speak() wasn't being
called at all.

### Files

- `src/screens/WakeModeScreen.tsx` — remove `greetingMs`, change
  gate to `if (greetingText)`
- `package.json` — 3.1.87 → 3.1.88
- `android/app/build.gradle` — versionCode 137 → 138
- `.github/workflows/{build,android-build}.yml` — artifact names
- `CHANGES_3.1.88.md` (new)

### Lessons

**"I changed this variable's meaning, so this other reference to
it is now wrong."** When refactoring a variable's role (here:
`greetingMs` going from "setTimeout duration" to "dead code"),
trace every reference to the variable. In this case, the gate
`if (greetingMs > 0 && greetingText)` was a separate concern
from the setTimeout but happened to use the same variable, so
the refactor silently broke it. The check should have been
updated to use a different signal (or the variable should have
been kept meaningful — e.g. always set to 1500 by default,
just no longer passed to setTimeout).

**Three releases shipped with a single-line bug, and the
voice log overlay was the only thing that made it visible.**
The voice log entries for `🔊 Speaking: "..."` and `🔊 done (...)`
simply didn't appear, which is the immediate tell that speak()
wasn't being called. Without the overlay, this bug would have
been a "no audio, why?" rabbit hole for much longer. The
overlay continues to pay for itself.

**Look at git blame when something that worked stops working.**
v3.1.84 worked (had `greetingMs = 1500`). v3.1.85 didn't. The
diff between them would have surfaced the change immediately.
When a "regression" appears, `git log -p` on the affected
file is a fast way to find the exact commit that introduced
the bug — much faster than reasoning about it from first
principles.