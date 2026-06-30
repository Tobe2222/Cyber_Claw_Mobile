# 3.2.17 — Voice mode multi-turn loop + silence/exit-phrase exit

## Reported by Tobe

After v3.2.16 the wake word + greeting still did not land
the user in a usable voice mode. Screen stayed on "Listening
for wake word..." after the greeting played. And the desired
behavior was clarified: voice mode is a multi-turn
conversation loop — wake → greeting → record → response →
record → response → … — that stays open until either
silence or an exit phrase closes it.

## Root cause of the v3.2.16 bug ("Listening for wake word..." stuck)

Voice mode's mount effect started the DTW wake listener,
the same one Wake Mode uses. But in voice mode the wake
word has ALREADY fired (App.tsx swapped into voice-mode on
`onWakeMatch`). So the screen waited for a SECOND wake
phrase that would never come. The screen stayed alive
forever because no error fired — it just sat there.

## v3.2.17 fixes

### Multi-turn voice-mode loop

- Wake → greeting → recording starts → silence triggers
  3s countdown → audio sent → desktop responds →
  `audio_response` fires → another recording window opens
  on the same screen → loop.
- `startRecordingTurn` factored out of `handleWakeWordInner`
  so the wake-match path and the multi-turn continuation
  path use the exact same recorder+silence+send body.
  Refs hold the latest closure so the response handler
  can re-enter without going through the wake matcher.
- Voice-mode mount now bypasses the wake listener entirely
  and starts a recording turn immediately. Wake-mode mount
  keeps the existing wake-listener-then-record flow
  unchanged.

### Exit conditions (in order of precedence)

1. **Continuous silence** ≥ user-configured silence window
   (default 5s, range 2-10s). Hardcoded no longer.
2. **Exit phrase** match in the transcription. Off by
   default. Preset options in Settings: `thanks`, `thank
   you`, `goodbye`, `stop`, `that's all`, `never mind`.
   Up to 4 custom phrases (1-4 words each, 8 phrases max
   total). Pure-JS substring matcher, no LLM call.
3. X button / back button (unchanged).
4. 5-minute hard cap (unchanged from v3.1.79).

### Per-turn UX

- Status badge cycles: `listening → recording →
  silence_countdown → transcribing → responding → listening`
  (loop, skipping `greeting` since the wake-mode greeting
  already played).
- Voice log shows every transition. Voice mode adds
  "🎤 Listening for next turn..." after each response.

## Files

- `src/services/VoiceSettings.ts` (new) — AsyncStorage
  wrapper for `cyberclaw-voice-silence-ms` and
  `cyberclaw-voice-exit-phrases`. Defaults: 5000ms silence,
  4 preset phrases.
- `src/services/ExitPhraseMatcher.ts` (new) — pure-JS
  fuzzy word-substring matcher. Strips filler ("um",
  "okay so"), punctuation, curly apostrophes. Multi-word
  phrases allow 0-1 non-letter between words so "thank
  you" matches "thank-you" too.
- `src/screens/WakeModeScreen.tsx` — voice-mode mount
  skips the wake listener; `startRecordingTurn` extracted;
  `pollForExitPhrase` watches for the next userText chat
  for up to 6s after each send; response handler re-arms
  recording in voice mode.
- `src/screens/SettingsScreen.tsx` — new "Voice mode
  loop" section with silence-window chips (2/3/5/7/10s)
  and exit-phrase toggles + custom-phrase input.
- `package.json` 3.2.16 → 3.2.17
- `android/app/build.gradle` versionCode 162 → 163,
  versionName 3.2.6 → 3.2.17
- `.github/workflows/build.yml` +
  `.github/workflows/android-build.yml` artifact names
  bumped to 3.2.17

## Lessons

- **"Two paths that look the same will drift"**: the
  initial v3.2.17 prototype duplicated the recorder+silence
  block in `handleWakeWordInner` AND in `startRecordingTurn`.
  Within a day they diverged (one reset busy, the other
  didn't). Refs + a single shared function fixed it.
- **`useEffect` empty deps capture stale closures**: the
  post-response `useEffect` references `handleWakeWordInner`.
  Because the deps array re-evaluates, the closure stays
  fresh, but if `startRecordingTurn` had been inlined instead
  of stored in a ref, the multi-turn loop would have hit
  the initial-closure version on every iteration. Refs
  for "latest closure" are the clean fix.
- **Wake-state vs command-state**: voice mode's wake word
  has ALREADY fired externally. The screen must NOT block
  on another wake match — that was the v3.2.16 bug. The
  presence of "listening for wake word..." in the visual
  log was a misleading-but-correct text indicator of a
  wrong-state scenario. Always check that what the screen
  is actually DOING matches what its label is SAYING.
- **LLM-free phrase matching is fast enough for sub-50ms
  responses**. No need to ship it to the desktop. Keeps
  the round-trip at 0 network for the most common exit
  path. Scales to 8 phrases across a multi-turn session
  with no measurable cost.
