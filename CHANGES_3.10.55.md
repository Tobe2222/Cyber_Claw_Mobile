# v3.10.55 — Wake test now loads the user's trained model instead of bundled `hey_jarvis`

Tobe (post v3.10.54):

> "updated and tested with a brand new training set.
> Wake peak 0% on 4 tries. avgRms 0.065 (mic working).
> The wake itself works in production."

The screenshot showed `Loaded model: Hey Clawsuu` in the
trainer (good — the .tflite was written) but `Wake peak
0%` on the test (bad). Production wake worked because
`WakeModeScreen.startSampleMatchListener` loads the
user's active wake model explicitly via
`loadOwwSavedModel(activeCompanionId)`. The test path
was different and broken.

## 1. The actual bug: v3.10.40's lazy-init substituted the wrong model

`WakeWordModule.startOwwListening` is called from two
places:

1. **Production** — `WakeModeScreen.startSampleMatchListener`
   calls `initOww(phrase, threshold)` first, then
   `startOwwListening`. By the time `startOwwListening`
   runs, `owwDetector` is non-null with the right model.

2. **Test** — `ClassifierTest.start()` (in
   `src/components/ClassifierTest.tsx`) calls
   `startOwwListening` directly without first calling
   `initOww`. If the user has never opened voice mode
   this session, `owwDetector` is null.

v3.10.40 added a "self-heal" fallback in this null case:
if `owwDetector == null`, lazy-init with the bundled
`'hey_jarvis'` model. The fallback worked for the home
screen's listener (any wake beats none) but **silently
broke the wake test** — the test would lazy-init jarvis,
score the user's "hey clawsuu" against the jarvis
classifier, get ~0, and report 0% on every poll.

The v3.10.40 comment even admitted this:

> *"The fallback cost is the wake word being 'hey_jarvis'
> instead of 'hey clawsuu' for this test session only —
> acceptable for a test path."*

That comment was wrong. The test's whole purpose is to
verify the user's trained model. Loading the wrong
classifier makes the test meaningless — and the test
panel's diagnostic ("Mic heard almost nothing" /
"Model saw something but not enough") couldn't
distinguish "wrong model loaded" from "model
undertrained", so the user got a misleading hint.

### Fix

Before falling back to `hey_jarvis`, scan
`SharedPreferences("wake_models")` for any
`active_<agentId>` entry, resolve its setId → meta →
phrase, and use that phrase as the lazy-init target.
Multi-agent tie-break: first key alphabetically
(deterministic; rare case anyway).

The new logic in `WakeWordModule.startOwwListening`:
1. Try to find an active custom-trained wake set.
2. If found, use its phrase as the lazy-init target.
3. If not found (fresh install, never trained),
   fall back to bundled `hey_jarvis` as before.
4. The `owwDetector` field, `owwWakeword` field, and
   debug log all reflect whichever phrase was used.

The change is ~70 lines including comments. It does
not affect production wake (which loads the right
model explicitly) — only the test path and any other
caller that hits the lazy-init fallback.

## 2. Files changed

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  lazy-init now scans SharedPreferences for an active
  wake set before falling back to `hey_jarvis`.
- `android/app/build.gradle` — versionCode 281→282,
  versionName 3.10.54→3.10.55.
- `package.json` — version 3.10.54→3.10.55.

## 3. How to verify

1. Build + install v3.10.55 APK from the
   `fix/v3.10.54-trainer-stale-closure` branch (or
   merge into your working branch).
2. **Without first opening voice mode**, go to
   Companion settings → Wake → Test wake.
3. Tap "🎤 Test wake", say "hey clawsuu".
4. Expected: Wake peak should be a real number
   (typically 30-80% depending on how the test
   utterance compares to your training samples).
   The `Wake listener` row should say `running`
   (green).
5. Debug log should show
   `Lazy-init using active wake set for
   active_clawsuu: 'hey clawsuu'` instead of the
   old `Lazy-init 'hey_jarvis' first`.

If peak is still 0% after this, the cause is no
longer the wrong model — it's a real mismatch
between the test utterance and the trained samples
(try matching mic distance, pace, and the exact
phrase from training).

## Lessons

**A "self-heal" fallback that substitutes a default
for the user's actual preference can mask the very
bug it tries to prevent.** The v3.10.40 fallback was
added to keep the wake listener from going silently
dead when `initOww` hadn't run yet. That goal was
right. The execution was wrong: "give them something
that works" is the right reflex for a production
listener, but a *test* runner needs the *real* model
or it produces false-negatives that look exactly like
false-positives from the user's perspective.

Audit rule for self-heal fallbacks: **what does the
fallback do when the user's intent is "test my
trained model"?** If the answer is "use the bundled
default instead", the fallback is wrong for that
caller. Either:

1. Resolve the user's actual preference from
   persistent storage (SharedPreferences, DB,
   AsyncStorage) and use THAT for the fallback, or
2. Don't fall back; surface the missing-init as a
   hard error with a clear message ("open voice mode
   first").

Option 1 (this fix) is better UX. Option 2 is honest.
Never option 3: "use a default that looks the same to
the caller but is actually different".

**Diagnostic layers can't observe root causes they
weren't designed for.** v3.10.30/31 added diagnostic
columns to the test result panel (avg score, avg RMS,
listener running state) to help the user figure out
why the test failed. Those columns were correct as
far as they went, but they couldn't distinguish
"wrong model loaded" from "model undertrained" — both
look identical from JS. When the test layer can't
observe the cause, the fix has to be at the cause
layer, not the test layer.

**Before bumping versionName, check THREE sources
and pick the max.** I read `versionName "3.10.43"` in
build.gradle on the main checkout, didn't check git
history or `latest.md`, and assumed "+1" was the
right next version. It wasn't — Tobe's working branch
was already at v3.10.54. The "+1" instinct only works
when the file you're looking at is on the same branch
the user is testing. Faster:
`git show <branch>:android/app/build.gradle |
grep versionCode` reads any branch's versionCode
without checking it out.

## Earlier fix-attempts (none landed — kept for context)

The diagnostic-tip additions in v3.10.30/31
(ClassifierTest.tsx) were the right move for the
"0% on N tries" diagnostic story, but they could
only describe the symptom. The cause (wrong model)
was invisible from JS. The v3.10.55 root-cause fix
in `WakeWordModule.kt` makes the diagnostics useful
again — if peak is still 0% after this, the
diagnostic tip will point at the *actual* remaining
cause (undertrained model, mic issue, etc.) instead
of misattributing everything to "mic heard almost
nothing".

## Verification on device

After Tobe rebuilds + installs v3.10.55, the wake
test should report:
- Wake peak: real number (30-80% range typical)
- Wake listener: running (green)
- Debug log: `Lazy-init using active wake set for
  active_clawsuu: 'hey clawsuu'`

If the test still shows 0% with listener running and
mic RMS > 0.005, the next thing to check is whether
the test utterance matches the training samples
(mic distance, pace, exact phrase, room noise). The
test is now testing the right classifier; any
remaining mismatch is a real training-data issue.