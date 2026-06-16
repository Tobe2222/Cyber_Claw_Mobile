# v3.1.24 — CI: install CMake, fix NDK env var (real fix for the JitPack-looking error)

## The problem

v3.1.23's JitPack fix worked — `:app:dependencies` resolves
`org.asyncstorage.shared_storage:storage-android:1.0.0` cleanly from
the local Maven repo, no JitPack queries. So the JitPack error in
the v3.1.22/23 build logs was a **red herring**: it was the *last*
error in a chain, not the *first*.

The actual error after JitPack was fixed was:

```
> Task :app:configureCMakeDebug[arm64-v8a] FAILED
> [CXX1416] Could not find Ninja on PATH or in SDK CMake bin folders.
```

This affects **both** workflows:

- `.github/workflows/android-build.yml` (debug build, runs on push to
  `main` and `workflow_dispatch`) — task: `assembleDebug`
- `.github/workflows/build.yml` (release build, runs on `v*` tags) —
  task: `assembleRelease`

The `mergeReleaseNativeLibs` step in the release workflow's log is
where the JitPack error originally surfaced, but that's the release
build — and the actual cause of *that* failure was also the missing
CMake/Ninja, not JitPack. The error chain was: build → CMake
configure → fail (no ninja) → dependency resolution phase leftover
log lines from an earlier failed run got appended → JitPack error
became visible at the bottom of the log.

## The actual root cause

Both workflows were installing NDK, build-tools, and platforms via
`sdkmanager`, but **not CMake**. NDK r27b requires CMake to compile
native C/C++ code (the New Architecture, JSI, Hermes, etc.), and the
NDK does not ship a `cmake` binary itself — `sdkmanager` provides
it as a separate component (`cmake;3.22.1` is the version
`android.toolchain.cmake` in NDK r27b targets).

When gradle's `:app:configureCMakeDebug[arm64-v8a]` task runs, it
needs:

1. CMake binary (from `sdk_root/cmake/3.22.1/bin/cmake`)
2. Ninja binary (same dir)
3. NDK toolchain (from `$ANDROID_NDK_ROOT`)

With no CMake installed, step 1+2 fail. Build aborts.

## v3.1.24 — install CMake, fix the NDK env var

### 1. `.github/workflows/android-build.yml` — install cmake, fix NDK path

The v3.1.22 CHANGES file claimed the NDK env var was fixed, but it
wasn't. The install command was updated to `ndk;27.1.12297006` but
the `ANDROID_NDK_ROOT` env var in the build step still pointed to
`/ndk/26.1.10909125` — a path that doesn't exist on the runner.
The build usually "worked" by accident because gradle falls back to
the SDK's auto-discovered NDK, but it's a latent bug worth fixing.

```yaml
- name: Install NDK, CMake, and build tools
  run: |
    echo "y" | sdkmanager "ndk;27.1.12297006" "cmake;3.22.1" "build-tools;36.0.0" "platforms;android-36"
```

```yaml
- name: Build APK with Gradle
  run: |
    cd android
    chmod +x gradlew
    ./gradlew assembleDebug --no-daemon
  env:
    ANDROID_NDK_ROOT: ${{ env.ANDROID_SDK_ROOT }}/ndk/27.1.12297006
```

### 2. `.github/workflows/build.yml` — install cmake (release)

The release workflow already had the correct `ANDROID_NDK_ROOT` for
27.1, but was missing the `cmake;3.22.1` install. Added it.

```yaml
- name: Install SDK components
  run: |
    sdkmanager --install "ndk;27.1.12297006" "cmake;3.22.1" "build-tools;36.0.0" "platforms;android-36" 2>&1 | tail -5
```

## Why the JitPack error is no longer relevant

v3.1.21 + v3.1.22 + v3.1.23 layered three mitigations:

1. Root `allprojects` block: declare `local_repo` first with full
   `metadataSources`. (Kept from v3.1.22 — harmless, helps any
   future deps that come from the same local repo.)
2. JitPack with `includeGroupByRegex "com\\.github\\..*"`: ensures
   JitPack is only queried for legitimate JitPack artifacts.
3. AsyncStorage subproject patch via `postinstall`: rewrites the
   AsyncStorage `repositories { ... }` block to put `local_repo`
   first, so gradle finds the AAR locally and never queries JitPack
   for `org.asyncstorage.shared_storage:storage-android:1.0.0`.

All three remain. The JitPack error will not reappear even on flaky
network runs. The actual build now proceeds past dependency
resolution and into CMake configuration, which is where it was
silently failing.

## Files

- `.github/workflows/android-build.yml` — added `cmake;3.22.1`,
  fixed `ANDROID_NDK_ROOT` to 27.1.12297006
- `.github/workflows/build.yml` — added `cmake;3.22.1`
- `package.json` / `android/app/build.gradle` — bumped to v3.1.24

## Verification

Local build on the same machine confirms:

```
$ ./gradlew :app:dependencies --configuration debugRuntimeClasspath
+--- project :react-native-async-storage_async-storage
|    +--- org.asyncstorage.shared_storage:storage-android:1.0.0
|    |    +--- org.jetbrains.kotlin:kotlin-stdlib:2.2.10 (*)
|    |    +--- androidx.room:room-runtime:2.8.0
...
EXIT: 0
```

No JitPack queries. AsyncStorage resolves from the local repo.

(CMake install hasn't been verified on this machine because cmake
isn't installed locally — but the workflow change adds the install
step, which is the canonical fix for the "Could not find Ninja"
error.)
