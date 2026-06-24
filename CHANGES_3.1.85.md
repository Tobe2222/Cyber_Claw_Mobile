# v3.1.85

## Wait for greeting to finish before starting the listener

Tobe (after v3.1.84): "When opened by wake it still dont say the wake
greeting with sound. Perhaps we need some delay?"

(The voice log overlay screenshot showed `🔊 Speaking: "Greetings
master Toby"` and `🔊 (webview fallback)` followed by `🎧 Listening
for wake word...` — but no audio. The fix in v3.1.83 made the
WebView fallback actually fire, but the listener was starting at
T=1500ms regardless, which stole audio focus mid-utterance.)

### Root cause

v3.1.80 introduced the two-phase wake pattern: play the greeting,
then start the listener after a fixed 1500ms delay. The delay was
chosen because that's the typical duration of the default "Ready to
chat" native TTS utterance.

But in v3.1.83 we added the WebView `speechSynthesis` fallback
(native TTS fails silently on cold start because Android's TTS
service is busy). The WebView path has more overhead — queue
latency, longer synthesis for non-default phrases — and 1500ms
isn't enough. Worse, **AudioRecord** (started by the listener at
T=1500ms) steals audio focus on Android, cutting the WebView
utterance off mid-word. Result: the user sees the voice log entries
fire but hears nothing.

### The fix: wait for the greeting to actually finish

`speak()` now returns a `Promise<void>` that resolves when the
greeting has actually finished speaking. The wake-mode useEffect
`await`s the promise before starting the sample-match listener.

**Completion detection per path:**

- **Native TTS** (the happy path): subscribe to the `ttsDone`
  event that `WakeWordModule` already emits from its
  `UtteranceProgressListener` `onDone` / `onError`. One-shot
  listener; removed when the promise resolves.
- **WebView fallback** (cold-start native TTS failure): use a
  duration estimate based on text length (~60ms per char, capped
  at 4s). Real `speechSynthesis.onend` would be more accurate
  but requires a callback bridge from WebView JS back to RN —
  out of scope for this hotfix.
- **Safety timeout** (5s hard cap): resolves the promise no matter
  what, so a stuck TTS never hangs the wake listener start.

**The 1500ms hardcoded delay is removed entirely.** The listener
now starts the moment the greeting finishes (or the safety timeout
fires), whichever comes first. This is correct for both the native
TTS path (typical "Ready to chat" = ~1.2s, plenty of headroom
under the 5s safety) and the WebView fallback (a longer phrase
like "Greetings master Toby" gets the full duration it needs
without the listener cutting it off).

### Voice log changes

The voice log overlay now shows the path that resolved the
speak() promise, e.g.:

- `🔊 done (native)` — native TTS finished normally
- `🔊 done (webview-estimate)` — WebView fallback finished
  (estimated duration, not a real onend)
- `🔊 done (safety)` — neither TTS path completed within 5s;
  the listener started anyway

If the user sees `🔊 done (safety)` consistently, the actual TTS
is broken in some way and needs investigation.

### Files

- `src/screens/WakeModeScreen.tsx` — `speak()` returns a Promise
  resolved on `ttsDone` / WebView estimate / 5s safety; wake-mode
  useEffect awaits it instead of using a hardcoded setTimeout.
- `package.json` — 3.1.84 → 3.1.85
- `android/app/build.gradle` — versionCode 134 → 135
- `.github/workflows/{build,android-build}.yml` — artifact names
- `CHANGES_3.1.85.md` (new)

### Lessons

**"Play X, then start the listener" needs a real completion
signal, not a fixed delay.** The v3.1.80 two-phase wake pattern
worked when the only TTS path was native (typical duration is
predictable). Adding a second TTS path (WebView fallback) that
has a different, longer duration broke the assumption. The fix
isn't a longer delay (the WebView path varies, and a "long enough
for everything" delay would feel sluggish on the happy path) —
it's a completion signal. Native TTS already has one
(`UtteranceProgressListener`); we just weren't listening for it.

**Audio focus is a first-class concern when an app uses both
TTS and audio capture.** AudioRecord stealing focus from a
mid-utterance `speechSynthesis` is the kind of thing that's
invisible from the JS side (no error, no event, just silence).
The voice log entries fired correctly, so it looked like
everything worked — but no audio came out. Visual debugging
overlays (like the voice log) are great but they only show what
the code thinks is happening, not what the user hears. When
debugging "the right code is running but no sound plays,"
suspect audio focus / capture-device contention first.

**Promises are the right shape for "wait until X is done."**
A fixed setTimeout is a guess. A Promise that resolves on the
real event (or a safety timeout) is correct for any duration
and any path. v3.1.85 converts speak() from a fire-and-forget
to a Promise-returning function, and the wake-mode useEffect
`await`s it. This is the same pattern HomeScreen already uses
for `ttsDoneSub` + `audioPlayerFinished` — we just hadn't
applied it here yet.