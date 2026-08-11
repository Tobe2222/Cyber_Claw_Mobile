# v3.10.159 — lazy TTS prompt: only when user engages with voice features

## What

Removed the App.tsx mount-time TTS probe + Alert that
fired on every cold start when no engines were detected.
Tobe (2026-08-11 17:28): "Perhaps by a time queue. It
should only ask when one is trying to use a feature it
depends on. And its still asking, mainly."

The alert now only fires when the user actually engages
with a TTS-dependent feature:

1. Opening voice mode (`WakeModeScreen.tsx` mount).
2. Opening the voice settings sub-page for a companion
   (`CompanionSettingsScreen.tsx` when
   `companionViewPhase === 'voice'`).

Dismissal cooldown bumped from 7 days to 90 days so
tapping "Later" actually sticks.

## Why

The v3.10.155 mount probe had two problems:

### Problem 1: Wrong UX surface

Showing a "no TTS engine" alert while the user is on the
Quests screen — a feature that doesn't depend on TTS at
all — is exactly the nagging that makes notifications
feel hostile. Tobe (2026-08-11 17:28) reported the
prompt appearing on the Quests screen with no relation
to what he was doing. The right time to surface the
prompt is the first time the user tries to USE a TTS
feature, not the first time they open the app.

### Problem 2: False-positive empty `engines` list

On GrapheneOS / degoogled ROMs, even with RHVoice
installed, Android's TTS service may not register RHVoice
as an installed engine (see github.com/RHVoice/RHVoice/
issues/876 — `TextToSpeech.getEngines()` does not list
RHVoice on degoogled ROMs without manual ADB setup of
`tts_default_synth`). Our code uses PackageManager
(`pm.getPackageInfo`), which should work — but if it
returned empty for any reason (race condition with F-Droid
install, package name typo, etc.) the prompt fired falsely.

The fix for #2 was attempted in v3.10.155 via the
auto-bind walk in `getTts()`, but the alert remained.
The cleaner fix is to not surface the prompt at all
unless the user actually tries to speak something.

## Files changed

### `src/services/TtsPrompt.ts` (NEW)

Lazy helper exported as `promptIfMissingTtsEngine(
context: string): Promise<boolean>`. Returns true if the
user tapped "Install", false otherwise. Logic:

1. Check dismissal cooldown (`cyberclaw-tts-prompt-
   dismissed-at`). If dismissed within the last 90 days,
   log + return false (no IPC call).
2. Call `WakeWordModule.listInstalledTtsEngines()`.
3. If ≥1 engine installed, log + return false.
4. Otherwise show `Alert.alert('No TTS engine', ...)`
   with "Later" (sets dismissal timestamp) / "Install"
   (calls `WakeWordModule.installTtsData()`) buttons.
5. Guards against concurrent calls via `probeInFlight`
   module-level lock so rapid screen mounts can't
   stack alerts.

Also exports `clearTtsPromptDismissal()` for tests /
manual re-prompt.

### `App.tsx`

Removed the entire mount-time TTS probe (was ~80 lines).
The native side still prewarms the engine in other code
paths (WakeModeScreen's speak calls, HomeScreen
prewarmTts useEffect) — the JS probe just no longer
pings the user about it.

### `src/screens/WakeModeScreen.tsx`

Added `useEffect(() => {
  promptIfMissingTtsEngine('wake-mode-open').catch(() => {});
}, []);` near the top of the component so the prompt
fires the first time voice mode opens in a session.

### `src/screens/CompanionSettingsScreen.tsx`

Added `useEffect(() => {
  if (companionViewPhase === 'voice') {
    promptIfMissingTtsEngine('companion-voice-page').catch(() => {});
  }
}, [companionViewPhase]);` so the prompt also fires
when the user navigates into the per-companion voice
settings page.

## Cooldown semantics

- Cooldown key: `cyberclaw-tts-prompt-dismissed-at`
  (AsyncStorage)
- Cooldown TTL: **90 days** (was 7)
- After 90 days the prompt will fire again on next
  engagement with a TTS feature — in case the user
  installed an engine off-app and wants to retry.
- The `clearTtsPromptDismissal()` helper is exported
  for any future "Re-check TTS" Settings UI button.

## Why this is a better pattern

The previous approach (probe at mount, prompt on miss)
treats "no TTS engine" as a problem to solve before the
user can use the app. The new approach (probe on first
TTS feature use, prompt on miss) treats it as a
contextual prompt — surfaced only when the user is
about to be blocked by it. This is the difference
between nagware and helpful nudging.

The 90-day cooldown is the safety net for the rare case
where the user dismisses once, then later installs an
engine but never opens a voice feature (because they
forgot the install was needed). They get a gentle
reminder on next voice feature use 90 days later.

## Testing note

Verified bundle builds: `npx react-native bundle
--platform android --dev false` succeeds. The change is
a simple JS-side restructure of an existing prompt
behavior — no native code touched.
