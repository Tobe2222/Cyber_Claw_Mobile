# v3.10.66 — Speaker enrollment works (mic contention fix) + global panel

## Tobe's report (verbatim, screenshot + text)

> "i updated and retrained. Then i went into wake settings again
> and this shows up. I tried it twice and hit the stop early
> button. But nothing seems to happen after.
>
> Also, this learning voice, should this not be global? Why pack
> this within a companion?"

This release ships three things to address that report.

## 1. The mic-contention fix (the real bug)

**Symptom.** Tobe taps "🟢 Re-train voice (30s)", the UI says
"running", he taps "Stop early" 30s later, "Voice-active
samples" stays at 0 forever.

**Root cause.** Android's microphone is a single-resource device.
Only one `AudioRecord(MediaRecorder.AudioSource.MIC, …)` can
have `RECORDSTATE_RECORDING` at a time. Three things in this app
all want the mic at once:

- `WakeWordModule.startVoskListening()` — foreground wake listener
- `CyberClawService.startWakeListening()` — BG wake listener (the
  one running while the user is on the settings screen)
- `WakeWordModule.startActiveEnrollment()` — active enrollment,
  opened on the panel's tap

All three use the same `AudioSource.MIC`, same sample rate
(16 kHz), same channel config. The active enrollment one would
have its `.read()` return 0 bytes because BG service's
`AudioRecord` already holds the resource. No audio ever reaches
`EnrollmentAudioProcessor.processAudio`, so `samplesTotal` stays
0. UI looks fine ("running"); capture is silently silent.

The CHANGES_3.10.62 notes called for the ReactMethod bridge. The
source HAS those methods (`@ReactMethod fun startActiveEnrollment(...)`
exists at `WakeWordModule.kt:3193`). But there's no coordination
between the BG service and the active-enrollment tap: both try
to hold MIC simultaneously.

**The fix — `EnrollmentCoordinator` singleton.** A simple
top-level Kotlin object with a single `isActive: Boolean` flag.

```kotlin
object EnrollmentCoordinator {
    @Volatile var isActive: Boolean = false
        private set
    fun begin() { isActive = true }
    fun end()   { isActive = false }
}
```

Two integration points:

- **`startActiveEnrollment`** calls `EnrollmentCoordinator.begin()`
  right before opening its `AudioRecord`. If anything throws,
  `begin()` is reversed in the `catch`. `stopActiveEnrollment`
  calls `end()` (also in the catch, defensively).
- **`CyberClawService` listen loop** checks the flag at the top
  of every iteration. If true: it stops its `AudioRecord`, sets
  `wakeListening = false`, breaks out of the loop, and a small
  monitor thread (started by `initAndListen`) sleeps 500ms and
  polls; when the flag flips back to false, it re-opens the
  mic and resumes BG wake. So the experience is:
  user taps Train voice → BG listening pauses → user speaks for
  30s → user taps Stop early (or natural end) → BG listening
  resumes within ~500ms.
- **`WakeWordModule.startVoskListening`** rejects with
  `START_ERROR: Cannot start wake listener: active speaker
  enrollment is recording` if the flag is set. Frontend listener
  can never start while enrollment is recording, so it never
  fights the mic either.

**Files:**
- `android/app/src/main/java/com/cyberclawmobile/EnrollmentCoordinator.kt` *(new, 72 lines)*
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  added `begin()` call at the top of `startActiveEnrollment`,
  added `end()` calls in `stopActiveEnrollment` (success and
  failure paths), added the read-guard at the top of
  `startVoskListening`.
- `android/app/src/main/java/com/cyberclawmobile/CyberClawService.kt` —
  added the loop-top read-guard, the `enrollmentMonitorThread`
  field, the `startEnrollmentMonitor()` method that's spawned
  from `initAndListen`, and the cleanup in `onDestroy`.

## 2. Move `ActiveEnrollmentPanel` to global Settings screen

**Symptom.** The speaker enrollment card lives under
`Wake settings → Clawsuu`, but the profile data is a single
device-wide `SharedPreferences` blob. A user with three
companions would see three copies of the same enrollment card.
Tobe flagged this as the wrong place.

**Fix.** Moved `<ActiveEnrollmentPanel />` from
`CompanionSettingsScreen.tsx` (line 1102 in the v3.10.64 source)
to the top-level `SettingsScreen.tsx`, directly under the
existing `VoiceEnrollmentBar` (compact pill progress) in the
🎙️ Voice mode Section. That Section is already documented as
"voice-mode behaviour shared across every companion" — speaker
profile is the most natural fit.

The bar+panel pair now reads as one concept: compact progress
up top, full card below it for the explicit 30s enrollment
session.

**Files:**
- `src/screens/SettingsScreen.tsx` — added the import, added
  the `🗣️ Train my voice` SubTitle + Hint + `<ActiveEnrollmentPanel />`
  under the existing `VoiceEnrollmentBar`.
- `src/screens/CompanionSettingsScreen.tsx` — removed the
  `<ActiveEnrollmentPanel />` JSX (kept a comment marker so
  it doesn't get re-added), removed the now-dead import.

## 3. Bundled the `Wake phrases` list cleanup (was v3.10.65)

Same `CompanionSettingsScreen.tsx` now also has the
`<SubTitle>Wake phrases</SubTitle> + Hint + <WakePhrasePicker>`
block removed — same fix I prototyped as v3.10.65 on a stale
local branch. The active wake is shown in the
"Currently active wake" panel up top; the two buttons below
(Train new wake phrase / Manage wake sets) cover every action.

Tobe flagged this in the prior session
(2026-07-21 15:18 GMT+2) as duplicate information. Bundled
into v3.10.66 because we're touching the file anyway.

**Files:**
- `src/screens/CompanionSettingsScreen.tsx` — deleted the
  `Wake phrases` JSX block, kept a JSX comment explaining the
  removal.

## Versioning

- `package.json` 3.10.64 → 3.10.66
- `android/app/build.gradle` `versionCode` 291 → 292,
  `versionName` "3.10.64" → "3.10.66"
- Skipped v3.10.65 — that was an internal-only branch on
  `feature/trainer-manager`. We're on a fresh branch off
  `main` here, so going 64 → 66 to avoid leaving an orphaned
  v3.10.65 in the version history.

## How to verify

1. **APK build.** `cd android && ./gradlew assembleRelease`
   should succeed (Kotlin symbol `EnrollmentCoordinator`
   resolves via the `com.cyberclawmobile` package, already
   auto-included in the build's source set).
2. **Install + relaunch.** Active enrollment will work the
   first time. (If it didn't work before, the new APK fixes
   it; if it did, no regression.)
3. **Open Settings screen** → scroll to 🎙️ Voice mode
   section → confirm the compact bar is followed by
   "🗣️ Train my voice" with the enrollment card below.
4. **Open a companion's wake settings** → confirm no
   `<ActiveEnrollmentPanel>` and no `Wake phrases` list
   (just the active panel + Train / Manage buttons).
5. **Tap "🟢 Train voice (30s)".** Speak the pangram for
   ~30 seconds. Voice-active samples counter should climb
   visibly (target: ≥50 within 30s of normal speech).
6. **Tap "Stop early" before 30s.** Counter should freeze at
   the current number.
7. **Verify BG wake resumes.** Switch the app to background
   (Home button), wait ~2s, return to the app — the BG
   service notification should re-appear and the
   `CyberClawService` log should show
   `Enrollment ended — resuming BG wake listening`.
8. **Verify the gate works.** (Only meaningful if profile
   locks.) When profile is locked, BG wake should only fire
   for voices matching your profile ≥0.5 cosine similarity.

## Lesson (the silent-bridge one)

Optional chaining on the React Native bridge masks missing
native methods as silent no-ops: `Foo?.bar?.()` resolves to
`undefined` cleanly, no throw, no log entry, the `await`
finishes, the JS state updates happily. The visible symptom
is "nothing happened" — which is hard to diagnose because
nothing in the system says anything was wrong.

This bug wasn't a missing-`@ReactMethod` (those existed).
It was a missing-coordination-flag, which is even harder to
spot because the capture mechanism is *technically
working* — it's just starving silently.

Mitigation for future bridge methods:
- Add a `console.warn` if the method you're calling is `undefined`.
  One line, catches any wiring gap at the React layer where
  the user is looking.

```ts
if (typeof WakeWordModule.startActiveEnrollment !== 'function') {
  console.warn('[Bridge] WakeWordModule.startActiveEnrollment is not exposed by native — flag this for clawsuu');
}
```

- Better: drop the optional chaining and require calls to
  land. `WakeWordModule.startActiveEnrollment(...)` (no `?.`)
  throws `TypeError: undefined is not a function` if missing,
  which `try/catch` can log. The pattern is faster to diagnose,
  no schema work needed.

I haven't applied either of these mitigations yet — would be
a follow-up across every bridge call. Worth it; leaving a TODO.

## What I had wrong before this release

`CHANGES_3.10.65c.md` was wrong (I wrote it before checking
the source carefully). The v3.10.62 ReactMethods DO exist on
`WakeWordModule.kt:3193+` — they're proper
`@ReactMethod fun startActiveEnrollment(...) { ... }`
implementations. The bug was mic contention, not missing
methods. Sorry for the false alarm and the wasted thinking
cycle — `_really_ checking the source next time before
writing up a "bug"`, even if it means a slower first
response.
