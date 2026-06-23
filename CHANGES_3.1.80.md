# v3.1.80

## Two-phase wake: greeting first, then user confirms with a second wake word

### Why

Tobe: "wake mode should not need a second wake confirmation. perhaps
we should introduce a slight change into how wake mode works. Or
perhaps not a change really but when i have tested it before i have
never gotten the wake greeting. When wake mode opens with the first
wake phrase it should open in wake mode and say the wake greeting.
Then the user says the wake phrase again to continue."

Two real problems with the old flow:

1. **The mic picked up the system's own greeting TTS** while the
   wake listener was running. The matcher's DTW sees the
   companion's own voice (similar prosody, same speaker
   characteristics) and either fires a false-positive match
   OR saturates the matcher so the user's actual wake word
   doesn't register.

2. **The user could never hear the greeting** because the
   matcher was already running. They'd say "hey clawsuu",
   Wake Mode would open, the system would start TTS, but
   the matcher would interrupt with a self-match and try
   to start recording — cutting off the greeting.

### The new flow (Siri / Alexa pattern)

1. User says wake word → Wake Mode opens
2. Mic stays OFF, system TTS plays the greeting
   ("Ready to chat" by default, configurable via
   `cyberclaw-ready-phrase` storage key; empty string
   disables the greeting entirely)
3. After 1500ms (typical "Ready to chat" TTS duration), the
   mic comes on and the wake listener starts
4. Visual indicator: "🔊 Greeting... (say wake word to
   continue)" → "🎧 Listening for wake word..."
5. User says the wake word a second time → recording starts

Voice mode (the user pressing the button explicitly) is
unchanged — no greeting, mic comes on immediately. The
greeting only makes sense for the wake-from-cold flow
where the user might not know whether the system is ready.

### Why a fixed 1500ms delay, not "wait for TTS to finish"

TTS completion callbacks on Android are unreliable across
devices and TTS engines. A fixed delay is simpler and
predictable. The user-configured greeting text is
typically short ("Ready to chat" = ~1.2s of audio), so
1500ms is enough headroom. If the user configures a much
longer greeting, they can extend this; for now, the
simplicity wins.

If the user wants to disable the greeting, set
`cyberclaw-ready-phrase` to an empty string. The wake
listener comes on immediately, and the user just says
the wake word once (the pre-v3.1.80 behavior, minus the
mic-during-TTS bug).

### Files

- `src/screens/WakeModeScreen.tsx` — new `greetingPhase`
  state, delayed wake listener start, updated status text,
  mic-off-during-greeting guarantee (listener doesn't call
  `startSampleListening` until the timeout fires)
- `package.json` — 3.1.79 → 3.1.80
- `android/app/build.gradle` — versionCode 129 → 130
- `.github/workflows/{build,android-build}.yml` — artifact
  names
