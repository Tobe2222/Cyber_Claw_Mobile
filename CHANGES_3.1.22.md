# v3.1.22 — Android build resilience: JitPack timeouts, repo order, NDK fix

## The problem

v3.1.21 GitHub Actions build kept failing with:

```
Could not GET https://www.jitpack.io/org/asyncstorage/shared_storage/storage-android/1.0.0/storage-android-1.0.0.pom
Read timed out
```

This was *not* a code problem. Two things were going on:

1. **React Native's gradle plugin (DependencyUtils.kt:99) injects JitPack
   into every project's repos automatically.** It's not in our
   `android/build.gradle` but it's there at runtime via the plugin.

2. **JitPack is slow / flaky** — when it times out (or when GitHub Actions
   runners are congested), the whole build fails. The
   `org.asyncstorage.shared_storage:storage-android:1.0.0` artifact is
   actually shipped via a local Maven repo inside
   `node_modules/@react-native-async-storage/async-storage/android/local_repo`
   — it should never need JitPack at all. But the way we had things
   configured, JitPack was being tried first/in_parallel and the
   timeout killed the build.

The release workflow (`build.yml`) also had:
- Wrong NDK version (`26.1.10909125` vs `27.1.12297006` in build.gradle)
- Wrong build-tools (`34.0.0` vs `36.0.0`)

## v3.1.22 — make the build survive JitPack, fix the workflow

### 1. `android/build.gradle` — local_repo first, JitPack explicit

The local_repo (which has the actual async-storage AAR) is now declared
**first** with explicit `metadataSources { mavenPom(); gradleMetadata();
artifact() }`. This tells gradle: "look here, and accept both .pom
and .module files" — so it never needs to fall back to JitPack for
that artifact.

JitPack is now declared **explicitly** with a content filter
(`includeGroupByRegex "com\\.github\\..*"`) and only `mavenPom` /
`artifact` metadata sources. This means JitPack is only consulted
for `com.github.*` artifacts (the only legitimate JitPack use case),
and even then it doesn't need .module files.

### 2. `gradle.properties` — relaxed network timeouts + retries

```properties
systemProp.org.gradle.internal.http.connectionTimeout=120000
systemProp.org.gradle.internal.http.socketTimeout=120000
systemProp.org.gradle.internal.network.retry.max.attempts=5
systemProp.org.gradle.internal.network.retry.initial.backOff=1000
```

120-second connection/socket timeouts (default is 10s/30s). 5 retry
attempts with 1s initial backoff. JitPack or any other slow repo
will be retried 5x before failing.

### 3. `android-build.yml` — fix NDK and build-tools

The debug-build workflow was installing `ndk;26.1.10909125` and
`build-tools;34.0.0` but `android/build.gradle` declares
`ndkVersion = "27.1.12297006"` and `buildToolsVersion = "36.0.0"`.
This wasn't always a hard failure (gradle would fall back to the
declared versions if available) but it wasted time and sometimes
caused subtle issues. Now it installs the versions that match.

## Files

- `android/build.gradle` — repo ordering and metadata sources
- `android/gradle.properties` — network timeouts
- `.github/workflows/android-build.yml` — NDK/build-tools versions
- `package.json` / `android/app/build.gradle` — bumped to v3.1.22

## Note

The v3.1.21 *code* changes (the dropped-send warning and the
auth-time requestAgentsList call) are still in place. v3.1.22 only
fixes the build infrastructure so v3.1.21's actual fix can be
shipped. No code changes from v3.1.21 → v3.1.22.
