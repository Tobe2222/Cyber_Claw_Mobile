# v3.1.93 — fold wake mode into voice mode + audio cue + fix normal-open bug

## Why

Three user-experience issues Tobe flagged on 2026-06-25:

1. **App jumped into Wake Mode on normal open.** Tapping the app icon from the launcher sometimes landed in Wake Mode without any wake trigger. Root cause: AsyncStorage `cyberclaw-wake-pending` flag persisted across app kills (force-close during a wake session). The 30s TTL in `checkNativePending` catches most cases but not "force-killed within 30s of wake".

2. **No audible feedback when wake word is detected.** There was a gap between "I said the wake phrase" and "the mic started recording" with no audio confirmation. Users couldn't tell if the device was listening.

3. **Two modes (Wake / Voice) where one would do.** Tobe's proposal: remove the dedicated Wake Mode entry, fold wake-phrase detection into Voice Mode. Single smart-speaker-style flow: open Voice Mode → passive wake-word listening → beep on detection → record user speech → transcribe → respond → loop. No more mode switching.

## What changed

### `App.tsx` — defensive flag clear on mount

New `useEffect` on the App component reads the native SharedPreferences flag on mount. If `wake_pending=true` but the timestamp is older than 30s, clear both the JS AsyncStorage flag AND the native SharedPreferences flag. This catches the "force-killed within 30s of wake" case that the existing TTL check in `checkNativePending` missed.

### `WakeWordModule.kt` — `playBeep(durationMs, frequencyHz)` new method

Short audible tone generated on the fly using AudioTrack (no asset file needed). Default: 880Hz sine wave, 150ms, with a 200-sample fade-in/fade-out envelope to avoid click artifacts. Pure-data synthesis, ~zero latency, ~3KB peak memory. JS calls `WakeWordModule.playBeep(150, 880)` and the device emits a clear "I heard you" beep.

### `WakeModeScreen.tsx` — unified wake/voice flow

**Removed the voiceMode branch** that previously skipped wake-word detection. Now both `voiceMode=true` and the default wake mode run the same flow:
1. Load trained samples
2. Start sample-matcher listener (passive)
3. On match → play 880Hz beep → 180ms pause → start recording
4. Record → silence detection → send to desktop for transcription
5. Play desktop's response audio → loop back to step 2

The `voiceMode` prop still affects UI styling (which button is visible, the voice log overlay) but no longer the wake-listener path. Both modes are functionally identical from the user's perspective.

**Audio cue on wake detection** — `handleWakeWordInner` plays a beep at the start of the wake-matched flow. The 180ms pause after the beep (before starting the recorder) avoids a known race where MediaRecorder's prepare() can clip the first 50-80ms of AudioTrack playback.

### `arena.html` — Wake Mode button removed

The WebView's "Wake Mode" button (which sent `{type:'wakeword'}` to React Native) is removed. Only the "Voice Mode" button remains. Tapping it routes to the WakeModeScreen with wake-phrase detection enabled. So there's no separate entry point — Voice Mode IS the wake mode now.

## Expected behaviour

**App open (no recent wake):**
- Launches to home screen, normal flow

**App open (within 30s of a real wake trigger):**
- Lands in Wake Mode (because the JS+native flags are fresh — handled by existing checkNativePending)

**App open (≥30s after a stale wake):**
- Launches to home screen (the new defensive clear handles this)

**Voice Mode flow:**
- User taps Voice Mode → fullscreen black with companion sprite
- Status: "🎤 Listening for wake phrase..."
- User says "hey clawsuu" → 880Hz beep → "🎤 Listening..."
- Status: "🔴 Recording..." (after 180ms pause)
- User talks → silence detected → countdown 3-2-1 → send to desktop
- Status: "📝 Transcribing..."
- Desktop responds with audio (via existing TTS pipeline)
- Status: "🔊 Playing response..."
- Loop back to listening for wake phrase

## Files
- `App.tsx` — defensive flag-clear effect
- `src/screens/WakeModeScreen.tsx` — unified flow, beep on match
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — playBeep
- `android/app/src/main/assets/arena.html` — Wake Mode button removed
- `package.json` — 3.1.92 → 3.1.93
- `android/app/build.gradle` — versionCode 142 → 143
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.93

## Lessons
- **TTL checks should be symmetric across native and JS layers.** The original checkNativePending read the native flag's timestamp. The JS AsyncStorage flag had no timestamp — only a presence/absence check, plus a setTimeout(30000) to remove. The asymmetry created the bug. Now both flags get a defensive clear on mount.
- **Two modes are one mode too many.** "Wake Mode" and "Voice Mode" were functionally identical (just different UI labels) and the difference between them confused Tobe. Consolidating to one entry point with one flow is simpler to reason about, simpler to test, and matches the smart-speaker UX users already know.
- **Audio cues matter for trust.** When the wake word is detected but no audio plays, users assume the device didn't hear them and say the wake word again — which the matcher might not match the second time, or might match during the response audio. A short beep closes that gap.
- **AudioTrack can synthesize tones on the fly.** No need to ship an asset file for a simple confirmation beep. ~50 lines of Kotlin and you have a clean sine-wave generator with envelope shaping.