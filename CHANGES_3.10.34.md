# v3.10.34 — Reduce post-response settle + add Working/Thinking cue/speech status

Tobe (post v3.10.33):

> "Okey tested voice mode again. It seems that the companion response
> actually has a delay now, its still in responding some seconds
> after the sound sentence is finished. Then i said my turn. Then
> the companion responded again like the previous round but now my
> turn was very short and it went into responding again, without me
> being able to say my turn. And stayed in responding. Hmm. Does it
> say responding while its working? Perhaps we need a working
> status? Since some times i ask it to do things which might take
> some time. During this time it should say working i realize. We
> should get a working sound response also. The user should be able
> to config what that speech should be also, it should be a voice
> mode setting. Working response where the user can input 'working'
> or 'digging' or Whatever he wants. What do you think? This would
> be most natural?"
>
> "alright lets reset the delay and add working/thinking status, it
> will lead to less confusion in debugging also"

Two fixes in this version:

## 1. Reduced RESPONSE_SETTLE_DELAY_MS 4000ms → 1500ms

### What was happening

The audio-HAL buffer drain race was fixed in v3.10.18 by passing
`queueIfPlaying=true` to `WakeWordModule.startPlayer` — MediaPlayer's
`setNextMediaPlayer` chains the cue sound to the response audio
natively, so the cue waits for the response audio's HAL buffer to
drain at the framework level. With that "smart" chain in place,
the JS-side settle delay only needs to mask the speaker-buffer
drain (typically 100-300ms observed on Android 12+), not the full
4-second chunk the v3.10.9 round assumed.

### What was wrong

The previous 4-second settle ALSO kept the voiceStatus overlay on
"Responding..." for those 4 seconds AFTER the audio had finished
playing. The user (Tobe) looked at the screen, saw "Responding...",
assumed "the LLM is still working," and either:
a) Started talking during those 4 seconds (overlap with audio HAL
   drain — picked up his "your turn" sound mid-burst)
b) Felt awkward that "responding" was lingering without the audio
   playing

### The fix

Two parts:

- **Immediate visual flip.** afterPlayback's first action is now
  `setVoiceStatus('listening')` so "YOUR TURN" appears the moment
  the audio finishes. The settle + cue + recorder then run
  sequentially underneath. Visually: audio done → YOUR TURN
  (small pause while HAL drains) → cue plays → mic live.

- **Reduced settle.** Dropped RESPONSE_SETTLE_DELAY_MS from 4000ms
  to 1500ms. With `queueIfPlaying=true` in the cue path, the cue
  natively delays itself behind any still-playing audio. The 1.5s
  settle is the slack for edge cases (audio HAL unusually slow,
  system under load).

Result: the user-perceived audio-finished → mic-live gap drops
from ~6s (4s settle + ~2s cue) to ~3s (1.5s settle + ~1.5s cue) on
typical config; the YOUR TURN light flips immediately instead of
deferring by 4 seconds.

## 2. New 'thinking' voiceStatus + working cue/speech

### What was happening

When the user finishes their turn and the audio is sent to the
desktop, the mobile has no feedback during the LLM processing
window (typically 1-3s for short replies, 5-30s for complex ones
with tool calls). The existing 'transcribing' status flipped to
'responding' only when the LLM sent its text reply, leaving a
visible gap with no audio or visual signal that anything was
happening.

### The fix

Three new settings in voice settings (Android TTS-driven speech +
optional chime, fully configurable per user preference):

| Setting | Default | Range | Saved under |
|---|---|---|---|
| `voiceWorkingCue` | `'off'` | `['off','bird','bell','ding','chime']` | `cyberclaw-voice-working-cue` |
| `voiceWorkingSpeech` | `"Working on it..."` | up to 60 chars | `cyberclaw-voice-working-speech` |
| `voiceWorkingDelayMs` | `1500` | `800-5000` | `cyberclaw-voice-working-delay-ms` |

#### Flow integration (WakeModeScreen → stopAndSendRecording):

1. User's audio sent (`sendAudioInput`).
2. Status flips to `transcribing` (briefly).
3. Schedule `thinkingTimerRef` to fire at `workingDelayMs`.
4. If `chat` or `audio_response` arrives within the delay →
   clear `thinkingTimerRef` + cancel working cue/speech (response
   wins).
5. Else `thinkingTimerRef` fires:
   - Status flips to `thinking` (only if status is still
     `transcribing`; respects a fast `responding` flip).
   - Working cue plays (if set + not 'off').
   - After `workingDelayMs` more, the configured speech phrase
     TTS-renders via Android's TTS engine.

#### Distinct 'thinking' status styling

- Color: `#a78bfa` (violet-300) — distinct from green (your turn),
  red (recording), amber (responding), yellow (retrying).
- Text: "🧠 Thinking...".

#### Cue cancellation

The working cue + speech TTS are cancellable. When
`cancelWorkingCue()` is called (from `onChat`, `onAudioResponse`,
the 30s transcribing-timeout 'retrying' path, or the unmount
cleanup), any in-flight cue sound stops and no TTS speaks.
The `Promise.race` inside `playWorkingCueAndSpeak` resolves
immediately on cancel — the function never holds the audio focus
past the response landing.

#### Status guarantee

Once any cue starts, the response audio (when it arrives) always
"wins" the speaker. Status goes `thinking` → `responding` →
`listening` (YOUR TURN) cleanly, with no interleaving.

## Files

- `src/services/VoiceSettings.ts` — new constants
  `WORKING_CUE_KEY`, `WORKING_SPEECH_KEY`,
  `WORKING_SPEECH_DELAY_KEY`, defaults + ranges + the
  `workingCue` / `workingSpeech` / `workingDelayMs` fields on
  `VoiceSettings`. Hydration in `loadVoiceSettings()`. New
  `saveWorkingCue`, `saveWorkingSpeech`, `saveWorkingDelayMs`.
- `src/screens/WakeModeScreen.tsx` — restructure `afterPlayback`
  to flip status immediately + reduce settle. New
  `thinkingTimerRef`, `cancelWorkingCueRef`, `cancelWorkingCue`,
  `playWorkingCueAndSpeak` callback. Wire into
  `stopAndSendRecording` (after sendAudioInput) with cancel
  hooks in `onChat`, `onAudioResponse`, the 30s 'retrying'
  path, and unmount cleanup. New `voiceStatusThinking` style +
  status text mapping.
- `src/screens/SettingsScreen.tsx` — new "🧠 Working / thinking
  status" subsection under voice settings with cue buttons,
  speech TextInput, delay OptionBtn row. New state hooks
  `voiceWorkingCue`, `voiceWorkingSpeech`, `voiceWorkingDelayMs`
  + hydration + update/save handlers.
- `android/app/src/main/assets/sounds/working-{bell,bird,chime,
  ding}.wav` — copies of the corresponding `turn-*.wav` files
  (same WAV bytes, different semantic name) so the working cue
  has the same set of pre-synthesized tones. Future v3.11 can
  give them distinct audio without breaking this version's
  contracts.
- `package.json` 3.10.33 → 3.10.34
- `android/app/build.gradle` versionCode 260 → 261, versionName
  3.10.34