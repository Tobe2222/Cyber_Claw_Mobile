# 3.2.22 — Multi-turn loop adds post-response settle delay

## Reported by Tobe

After v3.2.21 (response audio plays), Tobe reported the
multi-turn loop was detecting silence "right away" after
the first response. Voice log:

```
🔊 done (cached-play, 1555ms)
🎤 Listening for next turn...
🎤 Listening...
⏳ Silence detected (3000ms)...
```

The response audio finishes, the loop re-arms, and 3s
later the silence window fires — even though the user
hasn't had a chance to react to the response yet.

## Root cause

`afterPlayback` in `onAudioResponse` (WakeModeScreen) was
calling `startRecordingTurnRef.current()` immediately when
`audioPlayerFinished` fired. The new recorder started
right when the response audio ended, with 3s of
configured silence. If the user was still processing
the response mentally, the silence window elapsed
before they had time to speak.

The flow that produced Tobe's screenshot:

1. Response audio plays ("Hey! Why did the cookie cry...")
2. audioPlayerFinished fires → afterPlayback runs
3. New recorder starts immediately
4. 3s of "no one is talking" → silence detected
5. New turn is sent (with no actual user input)

The 3s value is the user's configured silence threshold
(set in Settings → Voice mode loop). The default is 5s.
Either way, the issue is that the silence window starts
counting from a quiet moment that's NOT the user being
done talking — it's the user still processing the
response.

## v3.2.22 fix

Added a 1.5s "let the response settle" delay at the
start of `afterPlayback`, before the next
`startRecordingTurn` is invoked. The flow now is:

1. Response audio plays
2. audioPlayerFinished fires → afterPlayback runs
3. **1.5s settle delay** — user has time to mentally
   prepare their next sentence, mic releases from
   playback audio focus
4. New recorder starts with the configured silenceMs
5. User has the full silence window to start talking
6. If they don't, silence fires and the loop ends

The 1.5s settle is hardcoded (not user-configurable)
because it's a "physical reality" delay (mic handoff
from playback mode) not a UX preference. 1.5s is
short enough to not feel laggy but long enough for
the audio system to settle.

## Files

- `src/screens/WakeModeScreen.tsx` — `afterPlayback`
  in `onAudioResponse` now waits 1.5s before starting
  the next recording turn
- `package.json` 3.2.21 → 3.2.22
- `android/app/build.gradle` versionCode 167 → 168,
  versionName 3.2.21 → 3.2.22
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.22

## Lessons

- **"Time zero" is part of the spec.** The silence
  window's start time matters as much as its duration.
  Measuring "3s of silence" from the moment the
  recorder starts is correct in isolation, but the
  recorder starting at the wrong moment (immediately
  after the response audio) makes the 3s a measurement
  of "post-response quiet", not "user not talking".
  Always think about WHEN the silence window starts
  counting, not just how long it counts.
- **Some delays are physical, not UX.** The 1.5s
  settle isn't a "user preference" — it's how long
  the mic + audio focus + speaker handoff take. Putting
  it in Settings would let users tune it to nothing
  and re-introduce the bug. Hardcode physical delays
  in the code; expose UX preferences in Settings.
- **"Right away" is rarely actually instant.** Tobe's
  log shows 3s elapsed between "Listening..." and
  "Silence detected", which is exactly the configured
  silence window. He perceived it as "right away"
  because the time he was supposed to use to speak
  was eaten by the post-response pause. A 3s window
  is fine for normal speech; a 3s window starting at
  the wrong moment is the actual bug.