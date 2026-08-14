# v3.10.167 — Stop-crash fix in speaker enrollment + Send word moved to its own page

## Bugs Tobe hit on 2026-08-14 (post-v3.10.166)

### 1. Voice enrollment panel crashed when tapping Stop

Tobe: "I now tried to voice train. But when i clicked stop it crashed."

**Stack trace (compressed):**

```
TypeError: Cannot read property 'catch' of undefined
  at ActiveEnrollmentPanel (anonymous@1:...)
```

**Root cause — `.catch()` after `?.()` returns undefined.**

The Stop button in `ActiveEnrollmentPanel.tsx` calls
`WakeWordModule?.stopActiveEnrollment?.()`. That works fine — the
optional-chain returns `Promise<true>` when both the module and the method
exist.

But the panel ALSO listens for the native-side `activeEnrollmentStopped`
event, and the listener calls `showEnrollmentToast('⏹ Stopped')`:

```js
function showEnrollmentToast(message: string) {
  NativeBackground?.showToast?.(message).catch(() => {});
}
```

When `NativeBackground` is null OR `showToast` isn't registered, the
inner expression evaluates to `undefined`, and `.catch(...)` on
`undefined` throws `Cannot read property 'catch' of undefined`. The
exact same pattern existed in two more places (`StrictModeToggle` mount
effect, and SettingsScreen's `openWakePerm` after opening the wake
settings panel).

This wasn't a hypothetical — Tobe's APK hit it on the very first Stop
tap. The 30-second enrollment runs `setTimeout(() =>
WakeWordModule?.stopActiveEnrollment?.()?.catch?.(() => {}), …)`,
and the native thread's `emit("activeEnrollmentStopped", "manual", …)`
fires from the bridge thread. If the native module had partially torn
down between the user's tap and the listener firing, the `?.()` short-
circuit fires `undefined.catch` and the whole panel throws.

**Fix:** defensively optional-chain `.catch?.()` and `.then?.()` too. If
the preceding call returned undefined, both short-circuit and we end up
with a silent no-op instead of a hard crash.

Three call sites patched:

- `src/components/ActiveEnrollmentPanel.tsx` — `showEnrollmentToast`,
  `StrictModeToggle`, the unmount cleanup, and the watchdog
  `setTimeout`.
- `src/screens/SettingsScreen.tsx` — `openWakePerm` and the mount-time
  `checkWakePermissions` listener.

**Audit rule for this bug class (writing it down for next time):**

> When you write `Module?.method?.()`, the call may legitimately return
> `undefined`. Any chained `.then` / `.catch` / `.finally` on that
> result needs the same `?.` chaining. `Promise?.catch?.(fn)` is the
> safe form; `Promise.catch(fn)` is a latent crash.

The safer refactor is to lift the optional chain into a local variable
and only chain when it actually exists:

```js
const p = Module?.method?.();
if (p && typeof p.then === 'function') {
  p.then(handle).catch(handleErr);
}
```

…but `Promise?.catch?.(...)` is the one-line form that keeps the rest
of the call site readable. Both are correct; just don't chain straight
off an `?.()`.

### 2. Voice-mode section in Settings was too messy

Tobe: "we need to clean up that settings, it looks a little messy.
compact the send word and just make a page out of it with a button for
it in the settings."

The 🎙️ Voice mode section had grown to ~110 lines of inline controls:
Background listening toggle, VoiceEnrollmentBar, Delete samples button,
Train my voice panel, Smart silence toggle, **Send word** (phrase input +
Save + Train + trained model badge + classifier test — 100 lines on its
own), Your-turn cue sound, Working/thinking status. The send-word block
in particular pushed the cue-sound and working/thinking blocks below the
fold on most phones.

**Fix — `src/components/SendWordScreen.tsx` (new):**

A dedicated full-screen page that owns:

- A header (← Back, title)
- A short intro card explaining what the send word is for
- The phrase input + Save row
- The trained-model badge (matches the wake-trainer style; tinted green
  when a model is active, gray when no model)
- A "🎙️ Train send word (6 samples)" button that opens the existing
  `SendPhraseTrainer`
- The shared `ClassifierTestPanel` for testing the trained model

The Voice mode section in SettingsScreen now has a single button in the
send-word slot:

```jsx
<SubTitle>✉️ Send word</SubTitle>
<Hint>Backup commit word…</Hint>
<TouchableOpacity onPress={() => setShowSendWordScreen(true)}>
  <Text>{voiceSendPhraseSavedAt
    ? `✉️ "${phrase}" — tap to manage`
    : '✉️ Configure send word →'}</Text>
</TouchableOpacity>
{sendModelInfo ? <Text>✓ Trained …</Text> : <Text>No trained model yet…</Text>}
```

The new screen mounts as a full-page overlay (early-return branch in
`SettingsScreen.tsx`, same pattern as `WakeSetManagerScreen`).
`voiceSendPhrase` / `voiceSendPhraseSavedAt` / `sendModelInfo` stay in
the parent so the existing `loadSendModelInfo(voiceSendPhrase)` effect
keeps the badge in sync on every keystroke — same as before, just
relocated.

### 3. Understanding the voice-training framing (Tobe's question)

> "is this a correct framing for the learning voice? To understand how
> it works. The voice training or enrollment is a initial learning
> setup, with the voice samples from conversations which is up to 100
> samples is additative? So both of these comprise the data of the
> actual learning? Then we feed that data into what? And does it just
> add those samples 1 at a time? Or how does that work? Ideally we
> would just do it like that, add data after initial learning. But
> perhaps one needs to do learn anew from scratch for each addition
> data sample?"

Yes — your framing is correct. Two sources of voice samples, both
contribute to one profile:

1. **Active enrollment (the panel you tapped):** dedicated 30s recording
   pass, samples land in `EnrollmentAudioProcessor`'s ring buffer.
   Force-locks the profile when ≥ 50 samples accumulated (panel shows
   the Lock button). This is the "explicit initial setup."

2. **Background accumulation:** the `CyberClawService` background
   listener sniffs out voice-active audio (energy + spectral gate
   distinguishes speech from background noise) and silently feeds
   those chunks to the same `EnrollmentAudioProcessor` ring buffer.
   The VoiceEnrollmentBar at the top of voice mode shows the running
   counter (`Learning X/100`). The bar caps at 100 — once it hits 100
   the profile is *automatically* locked without user intervention.

Both feed the same model. Once 50+ samples are in the buffer (regardless
of source), `forceLockProfile()` writes them to
`filesDir/speaker_profile/<profileId>/` and the wake word becomes
gated to your voice only.

**Is it additive?**

No — and this is the part that surprised me when I first read the
code. The "training" step (creating the speaker embedding that the
runtime gate compares incoming audio against) only happens once, when
the profile locks. After that:

- The detector compares each new incoming chunk against the *locked*
  embedding and decides "match" or "no match".
- New voice-active samples in conversations are *counted but not
  re-trained into the model*. They show up in the bar's "active"
  counter (up to 1000) but the profile itself is frozen.

**Why one-shot?** Because the profile embedding is the centroid of the
samples at lock time. If we kept retraining every time new audio came
in, the embedding would drift — you'd "feel less like you" over time,
and the threshold for a match would become meaningless.

**Can we re-train with new data without starting from scratch?**

Not in the current implementation. The only path is
`clearSpeakerEnrollment()` (the new "🗑️ Delete voice samples" button
in Settings, added v3.10.165) followed by either a fresh active
enrollment or natural accumulation. The samples are not cached between
locks, so "re-train on new data" effectively means re-record.

If you want incremental training, the path is:

1. Persist the locked samples (currently they're written to the
   embedding centroid and the raw WAVs are discarded after lock).
2. On a "retrain" action, concatenate the persisted samples + the new
   audio and recompute the centroid.
3. Hot-swap the embedding with `setSpeakerEmbedding(...)` (a method
   that doesn't exist yet — would need a native method + JNI hook into
   the current SpeakerVerifier).

This is doable but not in this version. Logged it for v3.10.168+ if
you want it.

## Files changed

- `src/components/ActiveEnrollmentPanel.tsx` — 4 sites patched (the
  Stop crash path + the StrictModeToggle + unmount cleanup + watchdog
  timeout).
- `src/screens/SettingsScreen.tsx` — 2 sites patched
  (`checkWakePermissions` listeners); `send-word` inline block
  replaced with a single button that opens the new screen; added
  `showSendWordScreen` state; removed the now-unused
  `showSendPhraseTrainer` / inline `ClassifierTestPanel` /
  `SendPhraseTrainer` imports (the trainer is still imported by
  `SendWordScreen`).
- `src/components/SendWordScreen.tsx` (new) — full-page send-word
  configuration UI.
- `android/app/build.gradle` — versionCode 376 → 377, versionName
  "3.10.152" → "3.10.167".
- `package.json` — version 3.10.166 → 3.10.167.

## Verification

- `node_modules/.bin/tsc --noEmit` — only pre-existing errors, none
  from these changes (the v3.10.166 commit log already noted "TypeScript
  --noEmit: pre-existing errors only, none from this change.").
- `npx react-native bundle --platform android --dev false` — clean
  (`Done writing bundle output`).
- Bundler picked up `SendWordScreen.tsx` without complaint.
- APK build was not run from this session (no adb / emulator in this
  environment) — Tobe should pull, build with the existing
  `build-android.sh`, and install.
