# v3.2.5 — wake trainer: ship audio bytes, not file paths

## Bug

After v3.2.4 fixed the "stop failed" recording crash, the trainer
made it all the way through 6 samples, but tapping **Train**
produced:

```
Error
sample not found: /data/user/0/com.cyberclawmobile/cache/wake_sample_1782646891464.m4a
```

## Root cause

The wire format was `{type: 'request_wake_training', samplePaths}`
— a list of absolute paths on the phone's filesystem. The desktop
then did `fs.existsSync(p)` and (correctly) reported the path as
not found, because those paths only exist on the Android device
running the trainer. The mobile and desktop don't share a
filesystem.

The training script (`scripts/train_wake_phrase.py`) was happy to
read either `.wav` or `.m4a` (`samples_dir.glob("*.m4a")` on line
392), so we just need to actually deliver the audio bytes.

## Fix

Wire format is now:

```ts
{type: 'request_wake_training', samples: [{name, data}]}
```

where `data` is the base64-encoded `.m4a` audio. The mobile reads
each cache file with `RNFS.readFile(path, 'base64')` before
sending. The desktop decodes each one and writes it into the
training dir under the existing `sample_NNN.<ext>` naming.

## Files

- `src/components/OpenWakeWordTrainer.tsx` — base64-encode each
  sample before sending; track upload progress
- `src/services/SyncClient.ts` — `requestWakeTraining` signature
  changed from `(agentId, phrase, samplePaths: string[])` to
  `(agentId, phrase, samples: {name, data}[])`
- `package.json` — 3.2.4 → 3.2.5
- `android/app/build.gradle` — versionCode 150 → 151,
  versionName 3.2.5
- `.github/workflows/{build,android-build}.yml` — artifact names
  to 3.2.5

## Desktop counterpart

Released in tandem as CyberClaw desktop v3.1.39 — updates
`src/main.js` (both IPC handler and sync-server listener) and
`src/sync-server.js` to expect `samples` instead of `samplePaths`.

## Lesson

Cross-process wire formats over IPC/WebSocket need to ship the
*data*, not references to wherever the producer happens to keep
it. Even if the consumer can technically read those paths in
some configurations, they almost certainly won't be reachable
from a sandboxed renderer, a separate desktop process, or
another device entirely. The default for any
"send a file to another process" flow should be: read the bytes,
base64 them if the transport is text, decode and write on the
other side.