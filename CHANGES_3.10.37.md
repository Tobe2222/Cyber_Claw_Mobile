# v3.10.37 — Working cue/speech always plays + cycle-status UI split + learning-bar combine

Tobe (post v3.10.36):

> "Firstly i noticed that it said thinking and working in the status.
> It did not say working with sound when it started working, which
> it should, it should say what i inputted, just like it says the
> greeting.
> And. It responded but something happens after its my turn again,
> since it jumps back to responding again shortly after, skipping
> sending and transcribing etc.
> I also thought that we could have the status cycle say 'listening'
> Instead of 'your turn', but have your turn additionaly but kind
> of separately in big green but right under the cycle status.
> The learning bar also say 0+50 for some reason. It should just
> say 1/1000 if it uses 1 sample to analyze my voice currently."

Three fixes in this version.

## 1. Working cue + speech now always play (no 1500ms gate)

v3.10.34 added the working cue + TTS speech with a 1500ms gate
inside `stopAndSendRecording`:

```js
thinkingTimerRef.current = setTimeout(async () => {
  // only flip to 'thinking' status + fire cue/speech
  // if the LLM hadn't already responded in those 1500ms
}, thinkingThresholdMs);
```

The intent was "don't make a quick LLM response wait for the
cue + speech". The actual behavior was: ANY response landing
within 1500ms suppressed the cue + speech entirely. On Tobe's
setup, the desktop typically responds in ~700-1200ms — well
inside the 1500ms window. Result: the cue rarely fired.

Tobe: "it should say what i inputted, just like it says the
greeting". The greeting plays immediately and unconditionally
when voice mode opens. The working cue should match.

**Fix:** dropped the 1500ms gate. The trigger inside
`stopAndSendRecording` is now:

```js
if (voiceMode) {
  cancelWorkingCue();
  setVoiceStatus('thinking');     // immediate flip, no
                                   // 'transcribing' in-between
                                   // for voice-mode turns
  addVoiceLog('🧠 Thinking...');
  void playWorkingCueAndSpeak();   // fires in the background;
                                   // cancels via
                                   // cancelWorkingCue() when
                                   // onChat / onAudioResponse
                                   // arrives
}
```

The internal `delayMs` wait inside `playWorkingCueAndSpeak`
(1500ms before speaking the TTS phrase) is also dropped.
Now the cue + speech fire in parallel as soon as the user
finishes their turn:

- **Cue** (non-verbal WAV, ≤800ms typical): always plays
  to completion. Not cancellable mid-sound.
- **Speech** (Android TTS, ~200-700ms typical): cancels
  cleanly via `cancelWorkingCue()` when the LLM responds
  mid-utterance. Quick LLM responses = truncated working
  speech (the user gets enough of the phrase to read what
  kind of state they're in; non-verbal cue always finishes).

The cancel gates (onChat, onAudioResponse, 30s retrying
path, unmount) are unchanged — they're robust and still
kill any in-flight cue/speech sequence when the response
lands.

## 2. Status cycle UI split — cycle text + big YOUR TURN

v3.10.34 used a single text element that swapped through
cycle states:

```
🔊 Greeting... (say wake word to continue)
🎤 YOUR TURN  <- the action prompt
🔴 Recording...
⏳ Sending...
📝 Transcribing...
🧠 Thinking...
💬 Responding...
⏳ Retrying...
```

Tobe: "the status cycle say 'listening' Instead of 'your
turn', but have your turn additionaly but kind of
separately in big green but right under the cycle status."

**Fix:** split into two stacked elements.

**Cycle text** (small, 16pt, color-coded) — drives the
user's understanding of where the system is in the cycle:

```
🎧 Listening
🧠 Thinking
💬 Responding
⏳ Retrying
🔴 Recording
📝 Transcribing
⏳ Sending
🔊 Greeting
```

The cycle text shows the **state**. Always small. Color-coded
so a quick glance identifies the phase.

**Big YOUR TURN sub-overlay** (28pt, green, shadowed) —
renders BELOW the cycle text, exclusively when
`voiceMode && status === 'listening'`:

```
🎧 Listening           <- cycle text (16pt green)
🎤 YOUR TURN           <- big green sub-overlay (28pt)
```

Reads as: "the cycle is in the LISTENING phase" (small text)
+ "your moment is NOW" (big green). Two pieces of info, two
distinct visual layers.

The cycle text and the big YOUR TURN share a color (green)
when both are visible, so they feel like the same state
despite being two rendering layers.

## 3. Learning bar combines to one number

The v3.10.35 compact variant displayed the bar as:

```
Learning 0+50/1000   ← OWW passive samples + voice-mode contributions
```

Tobe: "the learning bar also say 0+50 for some reason. It
should just say 1/1000 if it uses 1 sample to analyze my
voice currently".

The "+50" was visible to convey that voice-mode chats are
also contributing, but it read as an error rather than as
a UX value-add.

**Fix:** single combined count with a small inline
contribution badge in the full (settings) variant.

**Compact variant (voice mode):**
```
Learning 50/1000           ← combined count, single fraction
Learning 1050/1000         ← clamped, shows complete
```

**Full variant (settings):**
```
🎙 Learning your voice — 50/1000   🎤 50 chats
```

The compact variant shows a clean fraction (no "+"). The
full variant shows the same fraction with a small "🎤 N
chats" suffix so the user can see their contributions are
working. Both variants now have the bar fill MATCH the
displayed fraction — bar fill = `(samplesTotal +
activeContributions) / 1000`, capped at 100%. Previously
the bar filled on max(samplesTotal, activeContributions)
only, which disagreed with the displayed combined count
when activeContributions was the dominant value.

## Files

- `src/screens/WakeModeScreen.tsx` — dropped the 1500ms
  thinking-state gate (`setTimeout → setVoiceStatus('thinking')
  + playWorkingCueAndSpeak` is now immediate). Dropped the
  internal `delayMs` wait inside `playWorkingCueAndSpeak`.
  Refactored `voiceStatusOverlay` rendering into two stacked
  layers (cycle text + big YOUR TURN). Replaced
  `voiceStatusText` color-coded overrides with
  `voiceStatusCycle*` style variants.
- `src/components/VoiceEnrollmentBar.tsx` — single combined
  count in both label variants; bar fill tied to the
  combined count so display matches visual.
- `package.json` 3.10.36 → 3.10.37
- `android/app/build.gradle` versionCode 263 → 264, versionName
  3.10.37

## Migration / behavior

- **Working cue/speech.** Every voice-mode turn now plays
  the cue. The cue WAVs are 400-800ms; no perceptible
  latency added. The TTS speech can be truncated by a
  fast response — acceptable, the user gets at least
  partial feedback.
- **Status cycle UI.** On first install the status reads
  correctly. No settings to migrate.
- **Learning bar.** Uses the new combined display
  immediately. Existing v3.10.36 installs will see
  `0/1000` (passive=0, active=0) until they speak in
  voice mode; the first voice-mode turn bumps to `50/1000`.


## On the voice-mode cycle bug Tobe reported

> "It responded but something happens after its my turn again, since
> it jumps back to responding again shortly after, skipping
> sending and transcribing etc."

Not definitively diagnosed in this release. Most likely root
causes worth investigating in v3.10.38+:

1. **Background noise VAD mis-fire.** The smart-silence path
   uses RMS > 0.010 to mark `recorderHasUserSpoken = true`. A
   brief noise (phone click, table creak, the working cue's
   audio bleeding back into the mic via speakers) can
   legitimately cross that threshold. Once the flag is set,
   a fast silence window fires, an empty-ish audio is sent,
   the LLM responds quickly, and the cycle continues with
   no real user input. Mitigation: require >= 300ms of
   sustained above-threshold RMS before flagging as speech.

2. **Working cue audio feedback into mic.** With the cue
   playing IMMEDIATELY at the start of the working cycle
   (this release's fix), the cue audio could feed back into
   the recorder's MIC via the speakers. The recorder is
   typically off by the time the cue plays (this version's
   working cue fires AFTER sendAudioInput), but if there's
   any timing where the recorder and cue overlap...

3. **Response audio queue collision.** The working cue uses
   `startPlayer(path, false)` (don't queue behind response
   audio). If the response audio from the PREVIOUS turn is
   somehow still playing (rare, but possible if the audio
   HAL didn't fully drain), the working cue would cut it
   off, and the cleanup logic could trigger an extra
   cycle.

Will need voice log from next test session with the
working-cue fix active to narrow down.