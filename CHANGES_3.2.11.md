# v3.2.11 — Wake trainer: stop the bundled "hey jarvis" listener while training

Tobe reported two symptoms after v3.2.10:
1. The bar is still stuck at 30% ("Last event: 33s ago" red)
2. The wake word notification fires DURING training — the
   bundled "hey jarvis" listener from HomeScreen is still
   active underneath the trainer

For #2: the fix is clear. The bundled wake listener is
started in HomeScreen (line 126 of HomeScreen.tsx:
`WakeWordModule?.startOwwListening?.()`) and never
stopped when the user navigates to Settings or the
Trainer sub-screen. The wake listener uses Android's
AudioRecord, and a false-positive match fires the
notification — interrupting the trainer.

This release adds `stopOwwListening` calls on mount of
both SettingsScreen AND the trainer (with a corresponding
`startOwwListening` on unmount). The wake listener's
`start()` is idempotent (it short-circuits if
`isListening` is already true), so the cleanup is safe
to call even if the listener was never started.

For #1: the desktop log shows broadcasts going to
`1/1 open` (the phone). So events are reaching the
phone's WebSocket. The phone's SyncClient SHOULD be
processing them. The fact that the trainer's `_onProgress`
isn't firing means one of:
- The phone's SyncClient is dropping the message
- The trainer's `sync.on('wake_training_progress', ...)` listener isn't attached
- React isn't re-rendering

v3.2.10's console.log additions should tell us which
one in the next test. The trainer card will show the
"Last event" counter ticking when events arrive; the
Log tab will show every message the phone receives
(`[SyncClient] default-case msg: type=wake_training_progress`),
every handler fire (`[Trainer] _onProgress`), and every
watchdog poll (`[Trainer] watchdog poll`).

I have a strong suspicion that the wake listener
hogging the mic and firing notifications IS related
to #1. If the wake listener notification kicks the
user out of the trainer, the trainer re-mounts on
re-entry with fresh state — including `lastEventAt=0`
and a fresh event log with only the "Started" entry.
The user sees "Last event: 33s ago" because they took
the screenshot 33 seconds after returning to the
re-mounted trainer. v3.2.11's wake listener fix should
make the notification stop firing during training.

**Files:**

- `src/components/OpenWakeWordTrainer.tsx` — mount-time
  `stopOwwListening` and cleanup-time `startOwwListening`.
- `src/screens/SettingsScreen.tsx` — same, with cleanup
  in the same `useEffect` that handles the back button.
- `package.json` — 3.2.10 → 3.2.11
- `android/app/build.gradle` — versionCode 156 → 157
- `.github/workflows/{android-build,build}.yml` —
  artifact names to 3.2.11

**Lesson (a long-overdue one):** when a screen does
audio work (recording samples, training, previewing
a model), the wake listener MUST be stopped. Audio
device is exclusive in Android — only one consumer
at a time. The "hey jarvis" listener trying to use
the same AudioRecord that the trainer is using for
sample capture could cause the trainer's recordings
to be silent or garbled, even if there's no explicit
error. The wake notification firing during training
was a visible symptom of the same underlying conflict.