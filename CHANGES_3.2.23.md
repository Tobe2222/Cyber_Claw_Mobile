# 3.2.23 — Wait-for-speech-then-silence recorder (Alexa-style)

## Reported by Tobe

After v3.2.22 (1.5s post-response settle delay), Tobe
reported the multi-turn loop still cycling too fast:

```
🔊 done (cached-play, 1555ms)
🎤 Listening for next turn...
🎤 Listening...
⏳ Silence detected (3000ms)...      ← fires immediately
⏳ Silence detected (3000ms)...      ← cycles into next turn
📏 Sent, waiting...
📏 Sent, waiting...
```

User had no chance to speak between the response audio
finishing and the silence timer firing. The loop was
sending empty (mostly-silent) audio repeatedly, with
the LLM responding to nothing.

## Root cause

The native recorder's silence detector (`recorderSilence`
event in WakeWordModule.kt) measured "silence from
recorder start" — not "silence from user speech". If
the user took 3-5 seconds to react to the response,
the silence timer fired before they had a chance to
speak. The result: empty audio sent, LLM responded to
nothing, loop closed.

This was inherited from the wake-mode design where the
recorder starts immediately after the wake word fires
and the user is expected to speak within seconds.
Voice-mode conversation needs the opposite model: the
user might take 10-20+ seconds to compose their next
thought.

## v3.2.23 fix

**Wait-for-speech-then-silence (Alexa-style).** The native
recorder now tracks a `hasUserSpoken` flag:

- Recorder starts, listens passively, NO silence timer
- First non-silent amplitude reading sets `hasUserSpoken = true`
- Once user has spoken, the silence timer starts measuring
  "post-speech silence" (not total silence)
- If `silenceMs` of post-speech quiet elapses → emit
  `recorderSilence`
- If the user never speaks within `MAX_RECORDING_MS = 30s`
  (hard cap) → still emit silence (covers the "user said
  one thing and stayed quiet" case)

Plus a JS-side addition: if the silence handler fires but
the audio is empty (user never spoke at all), the voice
mode loop starts ANOTHER recording turn instead of just
sitting idle. The user gets infinite time to speak — only
the hard cap (30s total recording per turn) or an explicit
exit phrase closes voice mode.

Combined with v3.2.22's 1.5s post-response settle, the
full flow now is:

1. Response audio plays
2. audioPlayerFinished → 1.5s settle
3. New recording turn starts
4. Recorder listens passively — no silence timer running
5. User starts speaking at their own pace
6. `hasUserSpoken = true` → silence timer starts measuring
   post-speech quiet
7. User stops talking → `silenceMs` of quiet (3-10s) →
   `recorderSilence` fires
8. 3s countdown → audio sent → LLM responds
9. Loop continues from step 2

## Files

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — `startRecorderWithSilence` now uses wait-for-speech
  model. `MIN_RECORDING_MS` reduced to 500ms (was 2000ms).
  `MAX_RECORDING_MS` raised to 30s (was 15s).
- `src/screens/WakeModeScreen.tsx` — silence handler with
  empty audio now starts a new recording turn in voice mode
  instead of just setting busy=false
- `package.json` 3.2.22 → 3.2.23
- `android/app/build.gradle` versionCode 168 → 169,
  versionName 3.2.22 → 3.2.23
- `.github/workflows/{build,android-build}.yml` artifact
  names bumped to 3.2.23

## Lessons

- **The right "silence" depends on the use case.** Wake
  mode (single-shot) and voice mode (multi-turn
  conversation) want opposite silence semantics:
  - Wake: "X seconds of total silence after I heard the
    wake word → assume user done"
  - Voice: "X seconds of post-speech silence → assume
    user finished their turn"
  Same code, different definitions of "silence". v3.2.23
  picks the conversation-friendly definition for voice mode.
- **"Right away" usually means "faster than I expected".**
  The recorder's 3s silence was never actually instant
  — it took 3-5 seconds. Tobe perceived it as "right away"
  because he was trying to react in the same window.
  Short feedback loops need to feel like they're waiting
  on the USER, not on a clock.
- **"No input" is a valid input state.** The previous
  design treated "no speech before silence fires" as a
  reason to end the turn. v3.2.23 treats it as "keep
  listening, the user just isn't ready yet." Empty
  audio → no send → restart recorder. The user has
  effectively unlimited time to compose their next
  utterance. The hard cap (30s) is a safety net, not
  a UX feature.
- **Native + JS state coordination needs explicit
  acknowledgment.** The `hasUserSpoken` flag lives in
  Kotlin; the JS handler at the bottom of the silence
  chain decides what to do with an empty recording.
  Without the JS-side "restart on empty", the Kotlin
  change is useless — silence still fires after 30s, JS
  sees empty audio, ends the turn. The two changes
  together implement the full Alexa-style behavior.