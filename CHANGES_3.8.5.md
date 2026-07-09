# v3.8.5 — Wake word trainer: empty near-miss TextInputs now accept typed input

Tobe: "It trained send word now. Moved on to wake and
tried that. It did not allow me to input near misses.
The user should be able to input the text but i could
not."

The send-word trainer now works end-to-end (v3.8.3 +
desktop v3.1.55). Tobe moved on to retrain the wake
word and hit a different bug: the empty near-miss
TextInputs (slots 1 and 2 in the screenshot) let the
cursor in but typing did nothing.

Root cause: in the v3.8.2 near-miss UI, the
TextInput's `onChangeText` only updated state when
the slot was already filled:

```js
onChangeText={(text) => {
  if (existing) {
    setNearMissSamples((prev) => prev.map(...
  } else {
    // Pre-fill as a placeholder; the actual slot
    // is created on record. For simplicity we just
    // track via index.
  }
}}
```

The `else` branch was empty. So for slots 1 and 2
(no recorded entry yet), typing went into the void
— no state captured, the value prop snapped back
to the empty/placeholder string, nothing visible.
The mic button also fell back to `suggestions[0]`
instead of what the user typed, so even after
"recording" you'd be training on the suggestion
phrase, not the user's phrase.

## What changed

### 1. New `nearMissDrafts` state

```js
const [nearMissDrafts, setNearMissDrafts] =
  useState<string[]>(['', '', '']);
```

A per-slot string buffer. Empty slots capture typed
text here; once a slot gets a recorded entry, the
draft is superseded by `existing.phrase`. Drafts
also get cleared when a recording completes (so if
the user later deletes the entry the slot doesn't
ghost-render a stale draft).

### 2. TextInput value/onChangeText wired

```js
const slotValue = existing?.phrase
  ?? (nearMissDrafts[i] !== undefined
        ? nearMissDrafts[i]
        : (i === 0 && nearMissSamples.length === 0
            ? (suggestions[0] ?? '')
            : ''));
```

Precedence:

1. `existing.phrase` if the slot has a recording
2. The user's typed draft for this slot
3. The auto-suggestion for slot 0 (only on the very
   first render, so it doesn't overwrite what the
   user typed on every subsequent render)
4. Empty string — placeholder takes over

The `onChangeText` now writes to `nearMissDrafts[i]`
for empty slots and to `setNearMissSamples(...)` for
filled slots. Typing is no longer a no-op.

### 3. Mic button uses the user's draft

```js
const typed = nearMissDrafts[i];
const phrase = (typed && typed.trim())
  || existing?.phrase
  || suggestions[0]
  || '';
```

If the user typed anything in the slot, that's
what gets recorded. Falls back to the recorded
phrase (n/a for empty slots), then the suggestion
for slot 0, then empty (the recorder will alert
"Pick a phrase" if it's empty).

### 4. Drafts cleared on record

When `recordOne()` returns a path and we append to
`nearMissSamples`, we also clear
`nearMissDrafts[nearMissSamples.length]` so the
slot starts fresh next time the user edits it
(after deleting the entry).

## Files touched

- `src/components/OpenWakeWordTrainer.tsx`
  (`nearMissDrafts` state; updated slot value
  precedence + onChangeText + mic-button phrase
  resolution; cleared drafts on successful record)
- `package.json` (3.8.4 → 3.8.5)
- `android/app/build.gradle` (versionCode 219 → 220,
  versionName 3.8.4 → 3.8.5)

## Not touched

- Desktop — no changes needed.
- Send-word trainer — has no near-miss UI, not
  affected.
- Other wake / exit screens.
- The `suggestNearMisses()` heuristic — still
  works the same way; only how the suggestion
  interacts with user input changed.