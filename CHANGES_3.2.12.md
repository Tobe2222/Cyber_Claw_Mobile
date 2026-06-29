# v3.2.12 — Wake trainer: stop detaching the wake-training event listener on every stage change

After 6 server-side fixes (v3.1.41 through v3.1.46) and 5
mobile-side fixes (v3.2.6 through v3.2.11), the user was
still seeing "Last event: 33s ago" with a 30% bar. The
desktop log showed broadcasts going to 1/1 open (the
phone). So events were reaching the phone, but the
trainer's `_onProgress` handler was never firing.

**The bug was on the mobile side the whole time.**

The trainer attached the `_onProgress` listener in
`startTraining()` via
`sync.on('wake_training_progress', _onProgress)`. The
mount-time useEffect with deps `[companionId, stage]` had
a cleanup that did
`s?.off('wake_training_progress', _onProgress)`. When
stage changed from 'idle' to 'uploading' (which
startTraining triggers via setStage), the cleanup ran
and REMOVED the listener that startTraining had just
attached. The trainer was then listening to nothing.

The listener was attached for ~10ms, then removed. Every
wake_training_progress broadcast by the desktop went
to a removed listener. `_onProgress` never fired. The
bar stayed at 30%. `lastEventAt` was never updated. The
"Last event: Ns ago" counter just counted up forever.

**The fix:** attach the listeners in a separate
useEffect with EMPTY deps, and never remove them. The
trainer component is single-mount within SettingsScreen
so the listener is fine to stay attached for the
component's entire lifetime. If a stale result arrives
from a previous run, the stage guard inside `_onResult`
handles it (returns early when stage is already
'complete').

The mount-time [companionId, stage] useEffect still
exists for its other duties (poll for cached result on
mount, stop the wake listener, restart on unmount) but
no longer touches the wake-training event listeners.

**Lesson:** when a useEffect has cleanup that
removes event listeners AND another path (e.g. a
button handler in startTraining) attaches those same
listeners, you've created a race. The cleanup will
remove the listeners you just attached the moment
ANY dep changes. Either:
1. Put listener management in a useEffect with empty
   deps that runs once on mount, never cleans up.
2. Put listener management in the mount-time useEffect
   itself (not in startTraining).
3. Don't have stage as a dep of the cleanup useEffect.

Option 1 is what I went with. Listeners are a
"lifetime of component" concern, not a "this stage"
concern.

ALSO: the v3.2.10 console.log additions were the right
move. If I'd done those on iteration 1, the user
could've seen "watchdog poll" firing but no
"_onProgress" — and we would've found this bug in
5 minutes. The lesson: when adding logging to a
failing flow, log at the EVENT level, not just the
"something arrived" level. The v3.2.10 logs should
have included a "listener attached" / "listener
removed" log so we'd see the race in the trace.

ALSO: when you can't reproduce a bug locally, the
most valuable thing to do is build observability that
shows the actual control flow. The console.logs
helped confirm "events arrive but handler doesn't
fire", which immediately pointed at a listener
management issue.

**Files:**

- `src/components/OpenWakeWordTrainer.tsx` — new
  useEffect with `[]` deps that attaches the three
  wake-training event listeners (wake_training_progress,
  wake_training_result, wake_model_data) on mount and
  never removes them. The [companionId, stage]
  useEffect still handles cached-result polling and
  wake-listener stop/restart, but no longer touches
  the wake-training listeners.
- `package.json` — 3.2.11 → 3.2.12
- `android/app/build.gradle` — versionCode 157 → 158
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.12

v3.2.11's wake-listener fix (stop wake listener during
training) is ALSO in this build — it was already
tagged but the v3.2.11 APK was never installed. Both
fixes ship together in v3.2.12.