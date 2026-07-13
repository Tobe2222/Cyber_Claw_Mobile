# v3.9.2 — Hotfix: "⏳ Sending..." overlay stuck after no-speech skip

Tobe: "tested voice on mobile again. I asked how it was going
and it detected silence and sent. But then it said no voice
detected in the log there you see. I tried again but the same
happened. Also it said sending in the top there while log said
still listening."

Screenshot from voice mode showed:

```
top of screen:   ⏳ Sending...
log:             🎤 Listening...
                 🔊 done (cached-play, 1601ms)
                 ⏰ Silence detected (3000ms)...
                 🚫 No speech detected, skipping...
                 🎤 Still listening...
```

Two things visible at once: the **"⏳ Sending..." overlay
stuck on the screen** while the **log says "Still
listening"**. This is a state-machine desync.

## Root cause

`stopAndSendRecording` in `src/screens/WakeModeScreen.tsx`
has four early-return branches that *skip* sending audio
because the recording shouldn't go to STT:

1. `recorder.stop()` threw (line 902)
2. no recording path returned (line 908)
3. base64 < 100 chars (recorder captured nothing — line 921)
4. **`!speechDetectedDuringRecordingRef.current`** — the
   v3.6.0 gibberish gate (line 937)

…plus a fifth path inside the success branch:

5. transcribing-timeout fired while still waiting for
   desktop reply (line 964)

Each of these branches correctly clears
`wakeWordBusyRef.current` and `stopInFlightRef.current`,
and the voice-mode restart ones (3, 4, 5) also call
`startRecordingTurnRef.current?.()` to loop into the next
turn.

**But none of them reset `voiceStatus`.**

The previous state was `'silence_countdown'` (set by the
silence callback at line 1037), which renders as
`"⏳ Sending..."` (line 1633). Once we skip the send, the
state stays there forever. The restart then starts a new
recording turn, the silence detector fires again 3s
later, the skip happens again, repeat. Each cycle leaves
the overlay showing the stale "Sending..." message
because nothing in the skip path ever resets it.

This only affects voice mode (`voiceMode === true`). In
wake mode the same skip paths just sit idle waiting for
the next wake word, but the overlay still mis-displays.

## Fix

`src/screens/WakeModeScreen.tsx` (single function):

Added a `resetVoiceStatus()` helper at the top of
`stopAndSendRecording`. It only resets to `'listening'`
when the current state is one of the transient send-side
states (`'silence_countdown'` or `'transcribing'`), so it
never clobbers `'greeting'` or `'responding'` which are
owned by other handlers.

Called from all five skip paths so the overlay returns to
"🎤 YOUR TURN" (voice mode) or "🎧 Listening for wake
word..." (wake mode) the moment we decide not to send.

## Why a helper instead of inline `setVoiceStatus('listening')`

The skip paths don't know what state they're in — it
could be `'silence_countdown'` (silence path), but a
different caller (e.g. the send-word path) might invoke
`stopAndSendRecording` from a different state. Using a
guarded setter means each call site is one line and the
guard logic lives in one place. If we ever need to
handle another transient state (e.g. add a
`'warming_up'` state), we change one line.

## Files touched

- `src/screens/WakeModeScreen.tsx` (+18/-0)
- `package.json` (3.9.1 → 3.9.2)

## Verification

TypeScript compiles clean (the one pre-existing TS error
in `HomeScreen.tsx:2666` is unrelated). Log flow after
the fix should be:

```
🎤 Listening...
🔊 done (cached-play, 1601ms)
⏰ Silence detected (3000ms)...
🔇 No speech detected, skipping…
🎤 Still listening...          ← overlay also back to YOUR TURN
                                 (was: stuck on "Sending...")
```

Retry will work normally — overlay shows YOUR TURN, not
Sending.

## Companion release

Nothing desktop-side. This is a mobile-only bug.
