# v3.10.41 — Fix Kotlin compile error introduced by v3.10.40 wake listener changes

Tobe's `build-android.sh` invocation (running
`./gradlew compileReleaseKotlin` lint task on the v3.10.40
build) failed with:

```
WakeWordModule.kt:2810:79 Only safe (?.) or non-null asserted (!!.)
calls are allowed on a nullable receiver of type
'OpenWakeWordDetector?'.
```

## Root cause

In v3.10.40, `startOwwListening` was changed to lazy-init
the OWW detector via:

```kotlin
val detector = owwDetector    // captured at top, BEFORE lazy-init
if (detector == null) {
    // lazy-init: owwDetector = fresh detector
}
try {
    isOwwListening = true
    owwThread = Thread {
        // line 2810 uses the captured `detector` — NOT the
        // freshly-assigned one from lazy-init
        val (recompUpdated, _) = detector.recomputePrimaryProfileIfReady()
    }
}
```

The captured `detector` is `OpenWakeWordDetector?` (nullable).
After the lazy-init block, `detector` *still* holds the
pre-init value (null if lazy-init ran in the recovery
branch) because `val` captures the value at declaration time.

In the OWW thread inside the same function, Kotlin can't
smart-cast across the closure boundary even though we
control flow. Hence the lint failure on `detector.foo()`
calls inside the thread — Kotlin sees `detector` as
`OpenWakeWordDetector?` because the closure might be
called asynchronously after the `val detector =
owwDetector` capture, and the captured value is the
nullable expression, not a smart-cast proof.

## Fix

Two changes in `WakeWordModule.kt`:

1. Removed the stale `val detector = owwDetector` capture
   at the top of `startOwwListening`. The null-check is
   now `if (owwDetector == null) { ... lazy-init ... }`.
2. Inside the OWW `Thread { }` body, re-read `owwDetector`
   from the field with a null-safe early-out:

```kotlin
owwThread = Thread {
    // v3.10.40 fix: re-read owwDetector from the field
    // (NOT the captured val from earlier) AFTER the
    // lazy-init block has had a chance to populate it.
    val detector = owwDetector ?: run {
        Log.e("WakeWord", "OWW listener thread started with null detector; aborting")
        return@Thread
    }
    val readBuf = ShortArray(bufferSize / 2)
    // ... uses non-null `detector` ...
}
```

`?: return@Thread` is null-safe and graceful — if
`owwDetector` is somehow null when the thread starts
(via a path we missed), the thread exits cleanly with a
log line rather than NPE-on-first-access.

## Files

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt`
  — `startOwwListening` removed the stale top-of-fn capture;
  OWW thread re-reads `owwDetector` with null-safe early-out.
- `package.json` 3.10.40 → 3.10.41
- `android/app/build.gradle` versionCode 267 → 268,
  versionName 3.10.41

## Behavior

Same runtime behavior as v3.10.40:
- Wake listener still self-heals on null detector via the
  bundled `'hey_jarvis'` lazy-init.
- `initOww` still retries once on transient failure.
- OWW thread still uses the freshly-assigned detector
  (re-read from the field).

The only change is the Kotlin null-safety handling so
the release build compiles cleanly under
`compileReleaseKotlin`'s strict lint pass.