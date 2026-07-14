# v3.10.14 — Listen for desktop voice_pipeline_stalled hint

Tobe tested v3.10.13 and reported:

> "Okey we need to figure out why it did not respond
> then"

## Root cause (desktop investigation)

Walked through the desktop log to trace what happens
to a voice message:

1. ✅ Mobile sends audio via WS
2. ✅ Desktop receives, acks (`voice_received`)
3. ✅ Whisper transcribes (~2-3s)
4. ✅ Desktop sends transcript back to mobile
5. ✅ Desktop calls `webContents.send('mobile-voice',
   transcript)` to route to renderer
6. ❌ **Renderer never logged `[mobile-voice]
   received`** (zero hits in the log)
7. ❌ No `isUser: false` chat ever came back, no TTS
   fired

The renderer is hung or unresponsive. Electron itself
is still alive, but the renderer's JS chat pipeline
stopped processing voice IPCs. Likely cause: a
hung LLM call (`openclaw agent -m ... --json`) blocks
the renderer's `chatBusy=true` flag, which queues
subsequent voice messages via `while (chatBusy)
await` indefinitely.

## Fix (two-part)

### Desktop v3.2.3 (cyberclaw repo)

**1. Renderer-ack IPC.** When the renderer's chat
pipeline receives a `mobile-voice` IPC, it sends back
`mobile-voice-ack`. The main process logs an anomaly
warning if ack latency exceeds 5s.

**2. Ack-watcher deadline.** After sending
`mobile-voice`, main process starts an 8s timer. If
no ack has been observed by then, it logs a "renderer
hang suspected" message to the discord log channel
AND sends a `voice_pipeline_stalled` event to the
mobile.

### Mobile v3.10.14 (this change)

WakeModeScreen now listens for `voice_pipeline_stalled`
and surfaces a hint in the voice log:

```
⚠️ Desktop renderer hung — waiting for retry...
```

The hint is purely informational — the desktop may
still recover and send the response any moment.
The transcribing timeout (30s) remains the actual
failure boundary; if the desktop doesn't respond by
then, the existing retry path (v3.10.7 + v3.10.13
cue-on-retry) fires.

## Why this doesn't auto-recover

A truly hung renderer needs an `app.relaunch()` or
a `webContents.reload()` to recover, which:
- Risks data loss (any pending state in the renderer)
- Is heavy-handed (full page reload can take 5-10s)
- Has UX implications (the desktop user sees a flash)

For now: surface the hang to the user, log to the
desktop operator, and rely on the 30s transcribing
timeout to transition to the retry path. If the hang
recurs, we add a renderer-restart button on the
desktop (manual recovery) or a watchdog that auto-
reloads after 30s of unresponsiveness.

## Files

**Desktop (cyberclaw repo):**
- `src/main.js`:
  - New `mobile-voice-ack` IPC handler that logs
    anomaly warnings for slow acks
  - Ack-watcher in `onAudioInput` that emits
    `voice_pipeline_stalled` after 8s of no ack
- `src/js/app.js`:
  - Renderer's `mobile-voice` handler sends
    `mobile-voice-ack` immediately on receipt
- `package.json` — 3.2.2 → 3.2.3

**Mobile (this repo):**
- `src/screens/WakeModeScreen.tsx`:
  - New `voice_pipeline_stalled` listener that logs
    a hint to the voice log
  - Cleanup in the effect's return
- `package.json` — 3.10.13 → 3.10.14
- `android/app/build.gradle` — versionName 3.10.13 →
  3.10.14, versionCode 240 → 241

## Lesson

**When one process can't see another process's
health, add a heartbeat.** The renderer's JS context
can hang without the main process knowing — Electron
keeps the IPC channel open but the IPC handler
never executes. Without an explicit ack, main.js
sees the IPC as "delivered" and the renderer as
"unresponsive" but indistinguishable from
"processing".

A 1-line ack IPC turns "may or may not be hung" into
"definitely hung if 8s passed without ack." That's
the difference between "user has to wait 30s to know"
and "user knows within 8s." For voice UX where the
user is waiting for a response, 8s vs 30s is
significant.

**Lesson: silent failures in pipelines need explicit
success signals at every step.** The chain
voice_received → transcribed → renderer-acked →
audio_response has four natural checkpoints. We had
visibility at step 1 (desktop log) and step 4
(audio_response event), but not at steps 2 and 3.
v3.2.3 adds visibility at step 3. Step 2 (after
transcription) is implicit in the transcript echo
back to mobile, which is enough.

Going forward: when adding new pipeline steps, add
an ack at each step. The cost is one IPC per step;
the benefit is a diagnosable pipeline.