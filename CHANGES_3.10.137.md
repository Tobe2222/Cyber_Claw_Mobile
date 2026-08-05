# v3.10.137 — fix double JSON.stringify in arena_treat WebSocket sends

Tobe 2026-08-05 12:45 confirmed via the mobile Log
tab that the WebView→React Native handoff works
correctly:

```
[12:45:33 PM] 🎬 Arena message: type=treat_placed
[12:45:34 PM] 🎬 Arena message: type=treat_eaten
```

But the desktop's sync-server never logged
`arena_treat_placed` (added in desktop v3.2.72) for
those drops. So the message reached the React Native
side but never crossed the WS to the desktop.

## Root cause

`HomeScreen.tsx` lines 1385 and 1396 (both arena
treat paths) call:

```ts
syncClient.send(JSON.stringify({
  type: 'arena_treat_placed',
  treat: msg.treat,
}));
```

`SyncClient.send()` is `private send(obj: any)` and
`_attemptSend` does `this.ws.send(JSON.stringify(obj))`.

So when the caller pre-stringifies, `send` receives
a STRING, then stringifies it AGAIN. The actual WS
frame is a JSON-encoded string, not a JSON object.

On the desktop, `JSON.parse` decodes the outer JSON
back to the inner STRING. The dispatch checks
`msg.type`, which is `undefined`. With no `default:`
case in the switch, the message silently falls
through. The desktop's
`[SyncServer] arena_treat_placed` diagnostic (v3.2.72)
never fires because the case is never matched.

Tobe has been feeding the mobile companion for the
last few hours; **none** of those drops ever
reached the desktop. The chat-reaction bug has been
broken since v3.10.72 first added this code.

## Fix

Pass the object directly:

```ts
syncClient.send({
  type: 'arena_treat_placed',
  treat: msg.treat,
});
```

Same change for `treat_eaten`. `SyncClient.send()`
handles the JSON.stringify internally — call sites
that pre-stringify are bugs.

## Other callers (verified correct)

All other `syncClient.send*` helpers pass objects
directly:

- `syncClient.sendChat(text, agentId, deviceMeta)`
  → `send({ type: 'chat', text, agentId, ... })`
- `syncClient.sendWakeAgent(agentId)`
- `syncClient.sendAudioInput(audio, mime)`
- `syncClient.sendActivityPing(agentId)`
- `syncClient.sendCompanionAction({...})`
- `syncClient.sendRemoteToolResult(id, ok, data,
  error)`

Only the two arena_treat call sites were wrong.
Reverted them to follow the same pattern.

## Detection

Tobe's mobile Log tab was the diagnostic that
nailed it. Without that hint, I'd still be guessing
at "why doesn't the WS message arrive". The
diagnostic process:

1. v3.2.72: sync-server log → silent (message
   never arrives at desktop)
2. v3.2.73: main.js wrapper log → silent
3. Tobe 12:45: mobile Log tab shows treat_placed
   reaching React Native → chain breaks at the
   SyncClient.send step
4. Grep all `syncClient.send*` callers → find the
   double-stringify

Lesson: when a fix doesn't work AND the diagnostic
says "the message reaches me but I can't recognize
the format", suspect a serialization mismatch in the
sender. Either the sender uses the wrong field name,
the wrong shape, or as here, double-stringifies.

## Files

- `src/screens/HomeScreen.tsx`:
  - `treat_placed` handler: `JSON.stringify` removed
  - `treat_eaten` handler: `JSON.stringify` removed
- `android/app/build.gradle`:
  - versionName 3.10.136 → 3.10.137
  - versionCode 360 → 361

## Build

`cd cyberclaw-mobile && ./build-android.sh` to
produce a new APK. Tobe needs to install v3.10.137
on his phone for the fix to take effect.
---

## Build artifacts

Tobe's local build environment was missing `ninja`
and the Android SDK's `cmake/3.22.1` package. Fixed:

```bash
# Download prebuilt ninja
curl -sSL "https://github.com/ninja-build/ninja/releases/download/v1.13.0/ninja-linux.zip" -o /tmp/ninja.zip
mkdir -p ~/.local/bin && unzip -q /tmp/ninja.zip -d ~/.local/bin && chmod +x ~/.local/bin/ninja
export PATH="$HOME/.local/bin:$PATH"

# Install Android SDK CMake
curl -sSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" -o /tmp/cmdline-tools.zip
mkdir -p /home/humpsuu/Android/Sdk/cmdline-tools/latest
unzip -q /tmp/cmdline-tools.zip -d /tmp/ext && mv /tmp/ext/cmdline-tools/* /home/humpsuu/Android/Sdk/cmdline-tools/latest/
export ANDROID_HOME=/home/humpsuu/Android/Sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses > /dev/null 2>&1
sdkmanager --install "cmake;3.22.1"
```

Then:
```bash
cd CyberClawMobile/android
./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/app-release.apk
```

APK uploaded to v3.10.137 release on GitHub for
direct download. Tobe 2026-08-05 14:03.
