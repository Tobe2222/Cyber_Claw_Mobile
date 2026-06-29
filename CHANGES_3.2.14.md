# v3.2.14 — Wake trainer: re-init the OWW listener with the right wake phrase on cleanup

v3.2.13's wake-listener stop/start works for the
notification-firing bug. But there's a follow-on: after
the trainer closes, the listener starts but it was
init'd with `'hey_jarvis'` from HomeScreen. Even if
the trainer's `setWakeModelFromBase64` hot-swapped in
the new `.tflite`, calling `startOwwListening()` on
the existing detector doesn't re-init — the listener
keeps listening for the original wake word. Tobe
reported exactly this: training worked, voice mode
listened for the OLD wake word.

**Root cause:** `initOww(wakeword, threshold)` builds a
NEW detector instance. After init, calls to
`startOwwListening` / `stopOwwListening` reuse the
existing detector — they don't re-init. The trainer's
cleanup useEffect calls `startOwwListening` without
re-init, so the detector still has the bundled
`'hey_jarvis'` wake word even after `setWakeModelFromBase64`
hot-swapped the model in.

**Fix:** in the trainer's cleanup useEffect, call
`initOww(phrase, 0.5)` BEFORE `startOwwListening`. The
phrase to use:
- `currentTrainedPhrase` if a fresh training just
  completed (this is updated by the post-complete
  useEffect when the trainer's _onModel fires).
- `currentTrainedPhraseOnMount` (snapshot taken when
  the trainer mounted) if no fresh training — this
  accounts for any custom model already saved for this
  companion from a previous training session.
- Fall back to `'hey_jarvis'` if no model exists for
  this companion, so Voice Mode at least listens for
  SOMETHING.

`currentTrainedPhraseOnMount` is a snapshot taken
once when the trainer mounts. Later training
completions update `currentTrainedPhrase` but NOT this
snapshot. The `setState((prev) => prev === null ? entry.phrase : prev)`
pattern ensures the snapshot is set only on the
first mount resolution.

**Lesson:** `startOwwListening` is misleading — it
doesn't actually start anything new, it just resumes
the existing detector. If the wake word has changed,
you need to re-init. The hot-swap path
(`setWakeModelFromBase64`) is a separate code path
that the start/stop cycle doesn't know about. A wake
listener's "phrase" is set at init time and doesn't
update on hot-swap. The cleanup useEffect needs to
explicitly re-init.

ALSO: when you split an operation into "init" and
"start", the cleanup should match the inverse:
"stop" then "re-init" — not just "stop" then "start",
which leaves the original init state intact.

**Files:**

- `src/components/OpenWakeWordTrainer.tsx` — new
  `currentTrainedPhraseOnMount` state, snapshot
  taken on mount when getSavedWakeModels resolves;
  cleanup useEffect calls
  `initOww(phrase, 0.5).then(startOwwListening)` instead
  of just `startOwwListening()`.
- `package.json` — 3.2.13 → 3.2.14
- `android/app/build.gradle` — versionCode 159 → 160
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.14

The trainer's v3.2.11 wake-listener stop/start and
v3.2.12 listener-management fix are still in this
build — all three fixes ship together in v3.2.14.