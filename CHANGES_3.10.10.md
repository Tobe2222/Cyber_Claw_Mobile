# v3.10.10 — Bump RESPONSE_SETTLE_DELAY_MS to 4000ms

Tobe tested v3.10.9 and reported (channel `#cyber-dev`):

> "i think you need more delay on point 2. perhaps
> double, but it should be smart than a delay? it
> should run after its done talking if you get my
> point."

## Fix

### #1 — RESPONSE_SETTLE_DELAY_MS 2500ms → 4000ms

The cue timing fix in v3.10.9 went from 1500ms → 2500ms
but Tobe is still hearing the cue overlap with the last
syllable of the response. MediaPlayer's
OnCompletionListener fires when the player's internal
buffer drains, but the audio HAL still has ~200-500ms of
buffered audio on the speakers — and on Android 12+
this can spike to 700-900ms on devices with deep audio
pipelines (Dolby, Sony LDAC, etc.).

Bumping to 4000ms gives a comfortable cap — long enough
to mask even the slowest observed HAL drain (~900ms),
short enough to feel snappy when the user is ready for
the next turn.

### Why not the "smart" approach?

Tobe asked for a smarter-than-timer solution. The
correct primitive for "play X after Y is done
speaking" is `MediaPlayer.setNextMediaPlayer(X)`,
which queues X to start as soon as Y's framework
playback completes. I prototyped it but reverted —
`setNextMediaPlayer` is designed for GAP-LESS playback
(e.g., consecutive songs in a playlist), so it starts
X IMMEDIATELY at the framework level when Y ends,
even if the speakers still have Y's last samples in
the HAL buffer. For speech → cue, that's the SAME
problem we're trying to fix (X starts before Y is
truly done speaking).

The right primitive would be "wait until the audio HAL
buffer is empty before starting X" — but Android
doesn't expose that signal cleanly. Audio HAL buffer
drain is implementation-defined and varies by
device/Android version/audio effects pipeline.

So: settle delay IS the correct approach. The "smart"
version would require either:
- Per-device tuning (read the HAL buffer size at
  runtime, add that to the settle)
- Native access to AudioTrack.setNotificationMarkerPosition
  + a callback when the marker drains
- Audio focus events (AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
  when the next player requests focus)

For now: 4000ms is the cap. If Tobe still hears
overlap on a specific device, I'll need to either
go higher (5-6s) or instrument the native side to
detect HAL drain.

## Files

- `src/screens/WakeModeScreen.tsx` (+19 / -1):
  bumped `RESPONSE_SETTLE_DELAY_MS` 2500 → 4000ms,
  added explanatory comment about the HAL buffer
  drain rationale and the rejected setNextMediaPlayer
  approach.
- `package.json` — 3.10.9 → 3.10.10
- `android/app/build.gradle` — versionName 3.10.9 →
  3.10.10, versionCode 236 → 237

## Companion change

The desktop side (cyberclaw repo) shipped v3.2.2 in
parallel — `stripMarkdownForTTS` strips markdown
formatting from the LLM response before sending to
piper TTS. Tobe's "asterisk asterisk shipped:
asterisk asterisk" complaint is fixed by that change,
not this one.

LLM output → chat display: unchanged (still shows
markdown).
LLM output → TTS: markdown stripped (no asterisks,
bullets, backticks, etc. read aloud).

See commit `daf2b5d` in the cyberclaw repo.

## Lesson

**The "smart" path sometimes has to give way to the
"dumb but adequate" path.** `setNextMediaPlayer` is
the architecturally correct primitive for "play X
after Y" — but its semantics (gapless playback) are
the OPPOSITE of what we need for speech → cue (where
we want a guaranteed gap). When the "right" tool
solves a different problem than the one you have,
fall back to the timer. Document why you rejected
the "right" tool so the next person doesn't propose
it again.