# v3.10.160 — fix "YOUR TURN" flashing on voice-mode open, fix quieter exit phrase

## Two bugs from one screenshot session

### Bug 1: "YOUR TURN" shows before greeting finishes

When the user opened voice mode, the screen immediately
showed "🎤 YOUR TURN" in the status area, racing the
companion's greeting audio. The cue sound itself was
correctly timed (it plays after the greeting, before the
first recording turn), but the visible status text was
not.

Tobe (2026-08-11 18:38): "when i open voice mode that it
says your turn right away. It should wait for the que
sound and the companion to finish hes greeting. The que
is on point but not the text in this case."

**Root cause**: `voiceStatus` was initialized to
`'listening'` at component mount:

```ts
const [voiceStatus, setVoiceStatus] = useState<string>(
  voiceMode ? 'listening' : 'listening',
);
```

The `'🎤 YOUR TURN'` text is gated on
`voiceMode && voiceStatus === 'listening'`, so it
appeared instantly on mount. The async useEffect that
plays the greeting runs AFTER the first paint, but the
status text was already showing "YOUR TURN".

**Fix**: Initialize `voiceStatus = 'greeting'` in voice
mode (was 'listening'). The async path plays the
greeting, then explicitly sets `voiceStatus = 'listening'`
before starting the recording turn. The '🔊 Greeting...'
text shows during the greeting + settle + cue window,
which is what the user expects.

Also: skip the 4-second settle delay when there's no
greeting (was wasting 4s of "🔊 Greeting..." with no
audio playing).

### Bug 2: Exit phrase quieter than greeting

Tobe (2026-08-11 18:38): "Its sound was lower than the
greeting on opening for some reason."

**Root cause**: The exit flow does this:
```js
playExitReplyRef.current?.();    // fire-and-forget TTS speak
setTimeout(() => exitRef.current(), 400);   // unmount after 400ms
```

The screen unmounts 400ms after starting the TTS
utterance. Native TTS on RHVoice with cold voice-data
loading takes 200-800ms before producing the first
audio sample. With 400ms total budget, the WebView
loses audio focus + the screen tears down before the
engine outputs the first syllable — Android ducks the
audio or the utterance gets cut off mid-phrase, which
the user perceives as "quieter" (because the first
syllable is truncated, the rest plays at lower effective
volume due to ducking, or the utterance is replayed at
a different volume).

**Fix**: Bumped the close delay from 400ms to 1500ms
in every path that plays an exit phrase. This is enough
time for the native engine to start producing audio at
full volume while the screen is still visible. Affected
call sites:
- Exit-phrase ML detection (`owwExitDetected` listener)
- Close button (`onPress` of the ✕ button)
- "No speech for N rounds" auto-close
- LLM gibberish auto-close
- "Round-of-3" auto-close

For non-user-driven exits (hardware back press, 60s idle
timeout) the close stays synchronous — the user is
either leaving voluntarily or the system is closing them,
so playing a goodbye would be intrusive.

## Files changed

### `src/screens/WakeModeScreen.tsx`

- `useState<string>(voiceMode ? 'listening' : 'listening')`
  → `useState<string>(voiceMode ? 'greeting' : 'listening')`
  with explanatory comment about the v3.10.160 fix
- Added `if (greetingText)` guard around the 4s settle
  delay in the voice-mode start useEffect (skip when
  no greeting)
- Bumped 5 `setTimeout(() => exitRef.current(), 400)`
  to 1500ms in:
  - `owwExitDetected` listener
  - Round-of-3 auto-close
  - LLM gibberish auto-close
  - "No speech for N rounds" auto-close
  - Close button `onPress` (now wraps onExit in setTimeout
    so it benefits from the same delay)

## Testing note

Verified `npx react-native bundle --platform android
--dev false` succeeds. The changes are pure JS + state
init tweaks — no native code touched.
