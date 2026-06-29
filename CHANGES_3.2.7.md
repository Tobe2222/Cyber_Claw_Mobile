# v3.2.7 — Wake trainer: invert the noResult guard, add a stuck-progress watchdog

After v3.2.6 added the "re-poll the desktop for the cached result on
reconnect" feature, Tobe re-trained and got the EXACT same symptom:
progress bar frozen at 30% "Sending samples to desktop...", no error
message, no recovery.

**Two distinct bugs, both real.**

## Bug 1 (the one the user actually hit): inverted `noResult` guard

In `OpenWakeWordTrainer.tsx::_onResult`, the v3.2.6 mount-time recovery
was gated on:

```ts
if (!msg?.noResult) {
  // v3.2.6: the desktop has no cached result for this agent.
  return;
}
```

The comment is right but the condition is backwards. The desktop sets
`noResult: true` only when it has nothing cached. `!msg?.noResult` is
therefore `true` when the desktop DOES have a cached result, so the
handler dropped every real result on the floor — including the
`wake_training_result: ok: false, error: 'training process exited 1'`
that the desktop had cached. The phone polled, the desktop answered,
the phone silently ignored the answer, and the user stared at the
same frozen 30% bar.

Fixed to:

```ts
if (msg?.noResult) {
  // v3.2.6: the desktop has no cached result for this agent.
  return;
}
```

One character flipped. The whole v3.2.6 recovery was non-functional
because of it.

## Bug 2 (the cause of the cached error): synthetic clips at 22050 Hz

The error the desktop was caching was real, not a WebSocket artefact:

```
[wake-train:clawsuu] [train-OWW] ValueError: Error! Clip does not have the correct sample rate!
[wake-train:clawsuu] [train] Augmentation failed: openwakeword.train exited with code 1
```

openwakeword's `augment_clips` requires every clip to load at 16 kHz
via `torchaudio.load`. 2,520 of the 24,001 synthetic Piper-TTS clips
in the cached `positive_train` / `positive_test` / `negative_train` /
`negative_test` directories were at 22050 Hz. openwakeword blew up
the moment it hit one. The Python script had short-circuited
generation with "WARNING:root:Skipping generation of positive clips
for training, as ~10000 already exist" — so the bad clips from a
previous run sat there waiting.

Fixed two ways, both on the desktop side:

- **`scripts/train_wake_phrase.py::_normalize_clip_sample_rates`**
  resamples any non-16kHz clip in the four openwakeword clip dirs to
  16000 Hz before `--augment_clips` runs. Idempotent — no-op if
  everything's already correct. Logged as `[train] Resampled 2520
  clip(s) to 16000 Hz` or `[train] All clips already at 16000 Hz`.
- The on-disk state was already fixed by a one-shot pass before the
  release was tagged, so Tobe (and everyone else) doesn't have to
  wait 2-10 minutes for training to re-run before getting unstuck.

## Bug 3 (resilience): stuck-progress watchdog

The v3.2.6 recovery was mount-time only — the phone had to navigate
into the trainer screen to ask the desktop for the cached result.
If the user just sat on the frozen bar, nothing happened.

v3.2.7 adds two fallbacks:

1. **20-second watchdog poll** while the trainer is in any
   non-terminal stage (`uploading`, `generating_synthetic`,
   `augmenting`, `training`, `converting`). Cheap (one short message
   every 20s), and stops as soon as the stage becomes `idle`,
   `complete`, `error`, or `recording`.
2. **Re-poll on every re-authentication.** SyncClient emits
   `authenticated` on every (re)connect, and the watchdog now
   listens for it and re-polls the desktop immediately — so a
   WebSocket that comes back to life in the middle of a stuck
   trainer is the first thing the recovery code reacts to, not the
   20s tick.
3. **10s early poll right after `startTraining` fires the request.**
   If the WebSocket dies during the readFile loop or the first
   second of training, the user doesn't sit the full 20s — they
   get a recovery check at +10s.

## Lesson

Two separate things bit us here, and the visible symptom was
identical to the v3.2.6 bug Tobe had reported the day before:

1. The **inverted guard** meant the v3.2.6 fix was a no-op in
   practice. The desktop was answering, the phone was ignoring the
   answer. Always sanity-check a feature with a debug print or a
   test case that proves the response is reaching the consumer.
2. The **synthetic-clip sample-rate mismatch** was a latent bug
   from a previous (untracked) run. The piper_sample_generator
   package changed its output sample rate at some point, and the
   cached clips from before the change poisoned subsequent runs.
   --overwrite doesn't help because the generation step skips on
   "already exist" rather than regenerating.

Long-running jobs on a request/response socket need three layers of
recovery, not two: fire-and-forget, mount-time poll, AND a watchdog
that runs while the UI is still mounted. The first two had been
done; the third is what closes the gap.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — `noResult` guard
  inverted, 20s watchdog added, re-auth re-poll added, 10s early
  poll added.
- `package.json` — 3.2.6 → 3.2.7
- `android/app/build.gradle` — versionCode 152 → 153
- `.github/workflows/{android-build,build}.yml` — artifact names
  to 3.2.7

## Desktop-side changes (in the cyberclaw repo, not this one)

- `scripts/train_wake_phrase.py` — new
  `_normalize_clip_sample_rates()` helper, called before
  `--augment_clips`.
- `src/main.js` — `lastWakeResult.delete(agentId)` at the start of
  every new training run, so a stale cached error from a previous
  run can't leak through the new run's polls.
