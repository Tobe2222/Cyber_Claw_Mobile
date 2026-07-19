# v3.10.58 — TTS install opens Play Store instead of deprecated system installer

Tobe (post v3.10.57):

> "I noticed it prompted me for the TTS install again.
> Clicked install but nothing happened"

## The bug

`WakeWordModule.installTtsData()` launched
`TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA`, which
was deprecated in API 29+ (Android 10). On modern
Android (Tobe's device is likely Android 13/14/15),
the deprecated intent either silently does nothing
or shows a blank system dialog. The user sees no
feedback — they click "Install", the Alert
dismisses, and nothing happens.

This bug has been latent for years but became
user-visible once the v3.10.49 hint about RHVoice /
eSpeak NG landed in the install prompt (the
install prompt itself was added earlier; the
recommendation text just made the action more
prominent, so Tobe actually clicked Install and
noticed).

## Fix

Replaced the deprecated `ACTION_INSTALL_TTS_DATA`
launch with a tiered fallback chain that opens
the most appropriate app store for the user's
device:

1. **Play Store** for `com.google.android.tts`
   (Google TTS engine — universally recommended
   on stock Android). Tried first via
   `market://details?id=com.google.android.tts`.
2. **Browser fallback** for Play Store, in case
   `market://` isn't handled but `https://` is.
   `https://play.google.com/store/apps/details?id=com.google.android.tts`.
3. **F-Droid** for degoogled ROMs (GrapheneOS,
   CalyxOS, LineageOS without microG, /e/ OS).
   The user can search for "RHVoice" (recommended)
   or "eSpeak NG" (fallback) once F-Droid opens.
4. **Deprecated system installer** as a last
   resort. Likely does nothing on modern Android,
   but better than failing silently with no UI
   feedback at all.

The `installTtsData` Promise now resolves with a
string indicating which path was taken
(`"play_store"`, `"play_store_web"`, `"fdroid"`,
or `"system"`) so the JS layer can log/show
feedback if useful. The Alert still dismisses
immediately on click, but at least SOMETHING
opens.

## Files changed

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  `installTtsData` rewritten with the tiered
  fallback chain.
- `android/app/build.gradle` — versionCode 284→285,
  versionName 3.10.57→3.10.58.
- `package.json` — version 3.10.57→3.10.58.

## Lesson

When wrapping a system API that's been deprecated
for years, ALWAYS test on a current OS version
before shipping. The deprecated
`ACTION_INSTALL_TTS_DATA` intent has been broken
on stock Android since ~2019 (API 29), but the
warning was buried in the AOSP source and the
intent "resolves" (no exception) so the failure
mode is silent.

Audit rule for any code that uses a system
intent: check the AOSP deprecation timeline and
add a fallback if the intent has been deprecated.
For TTS specifically:
- API 1-28: ACTION_INSTALL_TTS_DATA works
- API 29+ (Android 10+): ACTION_INSTALL_TTS_DATA
  is deprecated and silently does nothing on stock
  Android
- Workaround: open the Play Store for the engine
  you want (Google TTS, Samsung TTS, etc.)

## Verification on device

Trigger the TTS-missing path (e.g. start voice mode
without a TTS engine installed). Tap Install on
the Alert. Expected: the Play Store opens to the
"Speech Services by Google" install page. Tap
Install there. After the engine installs, the
voice-mode speech should work.

On a degoogled ROM: F-Droid opens instead. Search
"rhvoice" or "espeak ng" and install one.

## Related: the wake test 0% issue (NOT fixed in this release)

Tobe also reported the wake test still shows 0%
peak even though "it triggers voice mode easily".
Investigation revealed:

- **Production wake fires from `CyberClawService`
  (Vosk + PhoneticMatcher)** — text-based
  matching against the wake phrase string, not
  against the trained .tflite model.
- **The wake test reads scores from the OWW
  TFLite classifier** (`OpenWakeWordDetector`),
  which uses the trained .tflite model.
- The two paths are independent. Vosk fires
  reliably because it does text matching
  ("hey clawsuu" → recognized → matched). The
  TFLite classifier doesn't fire because the
  trained model isn't matching Tobe's voice
  (likely undertrained or with conditions
  diverging from production).

This means the trained .tflite model is essentially
unused for production wake detection on Tobe's
device. The test (correctly) shows 0% because it's
measuring the unused path.

The fix for the underlying issue is a separate
design decision: either make OWW TFLite the
primary detector (and fix the training), or
remove the test (since it doesn't measure the
production path). v3.10.58 only fixes the TTS
install — the wake test issue is logged for
follow-up discussion.