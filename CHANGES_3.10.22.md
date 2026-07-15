# v3.10.22 — Companion settings crash on open (addLogEntry undefined)

**Symptom:** v3.10.21 crash on opening a companion's settings:
`Error in CyberClawMobile → ReferenceError: Property 'addLogEntry' doesn't exist → at CompanionSettingsScreen`

**Cause:** v3.10.21 added passive speaker-enrollment (`enrollSpeaker` + the auto-learning progress bar) and called `addLogEntry(...)` from CompanionSettingsScreen for status output. But `addLogEntry` is defined in `HomeScreen.tsx` (line 295, exported), and CompanionSettingsScreen has its own non-HomeScreen route in App.tsx — so it never had the symbol in scope. The error fires the moment the user taps a companion row → CompanionSettingsScreen mounts → either (a) the screen's enroll effect runs and calls `addLogEntry` immediately, or (b) the user taps "Learn my voice" / "Clear voice" → callback runs.

TypeScript and Metro don't catch this kind of bug: the function references resolve at *call time*, not parse time, so a static `tsc --noEmit` passes. Only a runtime smoke-test (open every screen, tap every button) would have caught it.

**Fix:** one-line import in CompanionSettingsScreen.tsx:

```ts
import { addLogEntry } from './HomeScreen';
```

Comment block explains the long-term direction: lift `addLogEntry` / `syncLog` / `logListeners` / `onLogEntry` / `offLogEntry` into a shared `src/services/LogStore.ts` (same shape as `SyncClient.ts`) so screens don't cross-import each other for log calls. Did NOT do that refactor here — minimum-viable fix for the crash, archival note in the comment.

**Lesson (codified):** whenever a feature added to a screen references a global symbol (log, analytics, toast, etc.), audit that the symbol is imported at the top. The project's only automated check is `tsc --noEmit`, which doesn't fire on undefined-global-at-call-site — that's a runtime ReferenceError. The pre-commit `tsc` step will pass; only the actual app launch will crash. **For future screen extractions: include the imports being used in the same PR as the feature, not as an afterthought.**

---

## v3.10.21 — passive speaker enrollment over time

See git log / prior CHANGES files for full v3.10.19 / v3.10.21 notes. The crash landed in this release; v3.10.22 is the immediate fix.
