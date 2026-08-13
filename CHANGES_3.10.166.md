# v3.10.166 — voice change now reaches the greeting, 100 active turns for the learning bar, delete samples actually wipes the JS counter

## Bugs Tobe hit on 2026-08-13 (post-v3.10.165)

### 1. Voice change in the picker didn't change the greeting or exit voice

Tobe picked a new piper voice in the mobile picker, opened voice mode, and heard the SAME voice in the greeting as before (and the same voice in the exit reply). Two layers were wrong:

- **Desktop `src/sync-server.js`** hardcoded `'lessac'` in all three piper synthesis calls (greeting at line 1780, working at 1844, exit reply at 1876). The mobile had been sending `request_greeting_audio` etc. without a voice parameter, so the desktop had nothing to read; it just synthesized with `lessac` regardless of what the user picked in either the desktop or the mobile picker. The picker was a no-op for the actual audio the user heard.

- **Mobile caches (`GreetingAudioCache`, `ExitReplyAudioCache`, `WorkingSpeechAudioCache`)** keyed their WAV filenames by `hashPhrase(phrase)` only. Even after the desktop started synthesizing with the right voice, a cache hit on the old voice's WAV would still play back the old voice. The caches needed to be keyed by `(phrase, voice)`.

**Fix:**

- `src/sync-server.js`: new `_getTtsVoice()` reads the desktop's `localStorage.cyberclaw-settings.ttsVoice` (the same inline-read main.js does at line 5200). All three synthesis calls (`_handleGreetingAudio`, `_handleWorkingAudio`, `_handleExitReplyAudio`) now call `await this._getTtsVoice()` instead of passing `'lessac'`. The `audio_response` payload echoes the resolved voice so the mobile writes the cache under the same key.
- `src/services/SyncClient.ts`: `requestGreetingAudio`, `requestExitReplyAudio`, `requestWorkingSpeechAudio` now accept an optional `voice` parameter that's sent in the WS message (default `'lessac'` for backwards-compat).
- `src/services/GreetingAudioCache.ts`, `ExitReplyAudioCache.ts`, `WorkingSpeechAudioCache.ts`: cache key is now `${voice}::${phrase}`. Functions take an optional `voice` arg; when omitted it's resolved from `getCurrentVoiceIdForCache(companionId)` (new helper in VoiceSettings.ts that reads `cyberclaw-voice-local-id-<companionId>` → `cyberclaw-voice-local` → `'lessac'`).
- `src/services/WorkingSpeechAudioCache.ts`: new `clearWorkingSpeechCache()` (sibling of the existing `clearGreetingCache()` / `clearExitReplyCache()`).
- `src/screens/CompanionSettingsScreen.tsx` `saveVoice()`: after writing the new voice to AsyncStorage + sending `set_tts_voice` to the desktop, also wipes all three piper audio caches so the user hears the new voice on the very next wake / exit / working cue instead of waiting for the stale entry to be naturally evicted.
- `src/screens/HomeScreen.tsx` `greeting_audio` + `exit_reply_audio` listeners: forward `msg.voice` from the desktop response into the cache write, so the cache slot matches what the desktop synthesized against.

The end result: pick 'kristin' in the picker → save → open voice mode → next greeting is kristin, exit reply is kristin, working cue is kristin, AI response is kristin.

### 2. "Learning 20/20" cap was too aggressive

Tobe: "It says Learning 20/20 for some reason. It should be 104/1000 but i think x/100 should be enough, should it not? 100 samples to learn from?"

`VoiceEnrollmentBar.tsx` had `ACTIVE_LOCK_THRESHOLD = 20` for the compact pill in voice mode (the `mode='active-only'` path, used by `WakeModeScreen`). Each voice-mode turn bumps the JS counter by 1, so 20 turns = "20/20" and the bar fills at 100% even though only 20 turns is far too small a sample to actually learn a voice profile.

The active-only mode exists because voice mode pauses the OWW passive listener (the recorder owns the mic), so the passive `samplesTotal` doesn't grow in voice mode. Showing the combined count there is misleading because it includes pre-voice-mode passive samples — the user sees "100/1000" the first time they enter voice mode after a quiet day.

**Fix:** bumped `ACTIVE_LOCK_THRESHOLD` from 20 to 100. The active counter still ticks 1 per turn, but the bar now fills after 100 turns instead of 20 — closer to "100 samples to learn from" as Tobe put it. The native OWW profiling threshold (which gates the actual lock + `matchScore`) is unchanged; this is only the UI progress denominator. The cap is still per-turn discrete so the bar moves meaningfully every chat.

### 3. Delete voice samples didn't actually wipe the JS-side counter

Tobe: "Also tried to delete but it still says 104/1000."

The v3.10.165 Delete button calls `WakeWordModule.clearSpeakerEnrollment()` which calls `OpenWakeWordDetector.clearPrimaryProfile()` — that wipes the NATIVE enrollment state and resets `samplesTotal` to 0. But it doesn't touch the JS-side `cyberclaw-voice-enrollment-active` AsyncStorage key that the compact bar reads for `activeContributions`. So:

- `samplesTotal` → 0 (native side cleared)
- `activeContributions` → 104 (JS AsyncStorage key untouched)
- `combinedCount = samplesTotal + activeContributions` → 104
- The compact pill (active-only mode in voice mode) still shows "20/20" but the Settings full pill (combined mode) still shows "104/1000" or similar.

The user thinks the delete didn't work because the count is unchanged.

**Fix:** SettingsScreen.tsx delete button also calls `AsyncStorage.removeItem('cyberclaw-voice-enrollment-active')`. Both sides cleared, the bar drops to 0/N immediately.

## Files changed

- `src/services/VoiceSettings.ts` — new `getCurrentVoiceIdForCache()` helper
- `src/services/SyncClient.ts` — `request*GreetingAudio` accept `voice` param
- `src/services/GreetingAudioCache.ts` — cache key includes voice
- `src/services/ExitReplyAudioCache.ts` — same
- `src/services/WorkingSpeechAudioCache.ts` — same + new `clearWorkingSpeechCache()`
- `src/screens/HomeScreen.tsx` — forward `msg.voice` into cache writes
- `src/screens/CompanionSettingsScreen.tsx` `saveVoice()` — clear all three caches on save
- `src/screens/SettingsScreen.tsx` — delete samples also wipes JS counter
- `src/components/VoiceEnrollmentBar.tsx` — `ACTIVE_LOCK_THRESHOLD` 20 → 100
- `package.json` 3.10.165 → 3.10.166

## Verification

- TypeScript `--noEmit`: pre-existing errors only, none from this change.
- React Native bundle (`npx react-native bundle --platform android --dev false`) → clean, "Done writing bundle output" — no SyntaxError.
- SyncServer module loads cleanly (`node -e "require('./src/sync-server.js')"` exits 0).
- All cache helper signatures stay backwards-compatible (voice param is optional, defaults to internal resolution).
- All callers that don't pass voice still work — they pick up the current voice via the new helper. The change is invisible to existing call sites except for the new async signatures on `requestGreetingSynthesis`, `requestExitReplySynthesis`, `ensureWorkingSpeechCached` (fire-and-forget `.catch()` style still works).

## Companion desktop release

Desktop `v3.2.96` ships the matching `_getTtsVoice()` helper and the `voice` echo on `audio_response`. Mobile v3.10.166 + desktop v3.2.96 must land together; otherwise the mobile's `msg.voice` is undefined and the cache falls back to the locally-resolved voice, which is functionally correct but produces a brief extra round-trip on the first wake after upgrading.

## Lessons

**Audio caches that are parameterized by user preferences need to be keyed by ALL those parameters.** The greeting/exit/working caches were keyed only by phrase because phrase was the only user-controllable input that changed the synthesized output... until v3.2.92 added per-voice picker, which silently turned the cache into a sticky cache of the wrong voice. The same trap applies to any other preference that affects the synthesized output (rate, pitch, audio effects, per-companion variants). When adding a new preference: grep for every cache and storage key that involves the affected output, and add the new preference to the key.

**Two stores for the same logical value (native `samplesTotal` + JS `activeContributions`) need a unified reset path.** When the user hits "Delete", they expect all of it to go to zero — not just the half they can see. The v3.10.165 Delete button only reset the half the native module owned. Always audit `clear*` / `reset*` paths for completeness across storage layers.