# v3.10.49 — TTS install prompt copy recommends RHVoice / eSpeak NG

Tobe asked after seeing v3.10.48's TTS install prompt:
"which should i choose if i run a pixel 8a with graphene?
The prompt to pick one should tell the user which to choose
also."

The v3.10.48 Alert had an Install button that launched the
system TTS picker (`Intent.ACTION_INSTALL_TTS_DATA`) but
provided no guidance on what engine to install. Stock
Android Pixel users typically have Google TTS preinstalled
and never see this prompt. Users on degoogled ROMs (where
TTS isn't preinstalled) need to install one themselves
and have to leave the app to research what's available.

## Fix

Updated the v3.10.48 Alert body to include engine
recommendations inline, sourced from the GrapheneOS
official usage guide
(https://grapheneos.org/usage#accessibility):

> "On stock Android use Google TTS. On GrapheneOS or
> other degoogled ROMs install RHVoice (recommended,
> more natural) or eSpeak NG from F-Droid."

### Why RHVoice for our use case

The "Working..." cue is a short verbal phrase
(default "Working on it...", up to 60 chars). Voice
quality matters more than boot-time availability —
we don't need the phone to speak "Working on it..."
before the first unlock. RHVoice has more natural
voices (community guidance: "good for assistant
replies") which makes the short cue less grating on
repeated triggers.

eSpeak NG is the alternative if RHVoice has licensing
concerns or if you want Direct Boot support. Voices
are more robotic but the engine is smaller and lighter
on battery.

For users who haven't thought about it: Google TTS on
stock Android is fine, no install needed.

## What's NOT changed

- The Install button still launches
  `WakeWordModule.installTtsData()` which fires the
  system TTS picker. Same intent, same flow.
- Session-scoped prompt guard
  (`ttsInstallPromptedRef.current`) unchanged.
- Error handling / fallback / diagnostic log
  unchanged.
- The no-TTS-engine path still resolves immediately
  (no WebView fallback) because speechSynthesis is
  also a no-op on devices without TTS.

## Files

- `src/screens/WakeModeScreen.tsx` — Alert body
  updated with engine recommendations.
- `package.json` — 3.10.48 → 3.10.49
- `android/app/build.gradle` — versionCode 275 → 276,
  versionName 3.10.49

## General lesson

**When a generic "install X" prompt can't itself install
X, it needs to teach the user what X to pick.** The
v3.10.48 prompt was technically correct ("open the
system installer?") but assumed the user already knew
what TTS engine to choose. The system picker shows a
generic list of engines; without context the user
couldn't tell which one would work, which one was
best for our use case, or whether they had one
already installed and just hadn't enabled it.

The fix is a one-paragraph recommendation right in the
prompt body, sourced from authoritative community
documentation (the GrapheneOS official usage guide, in
this case). The recommendation is generic enough for
stock-Android users ("Google TTS") while being specific
enough for degoogled users to make a choice
("RHVoice — more natural" / "eSpeak NG — lighter").

Same pattern as iOS permission denials: the OS doesn't
just say "go to Settings" — it says "go to Settings →
Privacy → Microphone and toggle CyberClaw on". Generic
"go to X" is much harder to act on than "go to X and
toggle Y".