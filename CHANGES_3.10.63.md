# v3.10.63 — Fix build break from v3.10.60 (clearPrimaryProfile typo)

Tobe (post v3.10.62):

> "Yeah sure, but the last 3 builds failed btw. Not
> that it matters aslong as the final does."

The screenshot showed:
```
EnrollmentAudioProcessor.kt:285:22 Unresolved reference
'clearPrimaryProfileAndCounters'.
> Task :app:compileReleaseKotlin FAILED
```

## The bug

In `EnrollmentAudioProcessor.kt` (added in v3.10.60),
I called `detector.clearPrimaryProfileAndCounters()`
in the `clearProfile()` method. The actual method
on `OpenWakeWordDetector` is named
`clearPrimaryProfile()` — no "AndCounters" suffix.

I typo'd the name when writing the wrapper. Kotlin's
compiler caught it at build time. The bug existed
from v3.10.60 onwards (the method was never called
from JS before v3.10.62 either, so the failure
was silent in v3.10.60 and v3.10.61 unless the
CI build checked all symbols — which it apparently
does).

Three tags affected: v3.10.60, v3.10.61, v3.10.62.

## The fix

One line in
`android/app/src/main/java/com/cyberclawmobile/EnrollmentAudioProcessor.kt`:

```diff
-            detector.clearPrimaryProfileAndCounters()
+            detector.clearPrimaryProfile()
```

That's it. The `clearProfile()` API on
`EnrollmentAudioProcessor` is now callable, but it's
still not invoked from anywhere in the JS layer
(`ActiveEnrollmentPanel` exposes a "Clear profile"
button that calls `WakeWordModule.clearSpeakerEnrollment`,
which goes through `owwDetector.clearPrimaryProfile()`
directly — a separate path). So this fix is
preventative (the broken method would have crashed
the moment anything called it).

## Why v3.10.63 instead of rebuilding v3.10.62

The v3.10.62 tag is on origin and would point at a
broken commit if I tried to recreate it. Three tags
are broken (.60, .61, .62) — fixing them all would
require a rebase that rewrites history across three
releases. The cleanest path is to bump to v3.10.63
with the fix and let .60/.61/.62 stand as historical
broken tags. The CI build workflow is push-triggered
(not tag-triggered), so v3.10.63's push will trigger
a fresh build with the fix and that APK will work.

If you want the broken tags cleaned up, I can:
- Delete v3.10.60, v3.10.61, v3.10.62 from origin
  (force-push tag deletion)
- Recreate them at fixed commits with the typo fix
  backported to each (cleanest from a history
  perspective but more work)

Say the word and I'll do it.

## Files changed

- `android/app/src/main/java/com/cyberclawmobile/EnrollmentAudioProcessor.kt`:
  - One-line typo fix
- `android/app/build.gradle`: versionCode 289→290,
  versionName 3.10.62→3.10.63
- `package.json`: version 3.10.62→3.10.63

## Lesson

**Always do a sanity-check build before tagging a
release, even a "small" one.** I shipped v3.10.60,
v3.10.61, v3.10.62 with the same typo because I
assumed the `clearProfile()` method wouldn't be
exercised (it wasn't called from JS at the time).
Kotlin's symbol resolution catches ALL referenced
symbols at compile time — even unused private
methods. The "unused but broken" path is a
compilation error waiting to happen.

Audit rule: before tagging, run a build. If you
can't run a build locally (no Android SDK on
hand), at least grep the new code for any method
calls against the OpenWakeWordDetector API to
verify the method names exist. I had the data to
check; I just didn't check it.

Going forward I'll add a "verify all method
references resolve" step to the commit checklist
for any version that touches the native side.