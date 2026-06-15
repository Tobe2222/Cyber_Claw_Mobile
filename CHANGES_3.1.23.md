# v3.1.23 — AsyncStorage build fix: patch the subproject's own repositories

## The problem

v3.1.21 and v3.1.22 both failed to build with the same JitPack
timeout, despite v3.1.22 declaring the local_repo in the root
`allprojects` block. The error:

```
> Could not resolve org.asyncstorage.shared_storage:storage-android:1.0.0.
  Required by:
      project :app > project :react-native-async-storage_async-storage
> Could not GET https://www.jitpack.io/org/asyncstorage/shared_storage/
  storage-android/1.0.0/storage-android-1.0.0.pom
> Read timed out
```

I diagnosed v3.1.22 wrongly. The root `allprojects { repositories {
... } }` block is **not** the only source of repos for a
subproject. Each gradle subproject can declare its **own**
`repositories` block, and when resolving its own dependencies,
gradle uses **those** repos.

## The actual root cause

`node_modules/@react-native-async-storage/async-storage/android/build.gradle`
has, near the bottom:

```gradle
repositories {
    mavenCentral()
    google()
}

dependencies {
    implementation "com.facebook.react:react-android"
    api "org.asyncstorage.shared_storage:storage-android:1.0.0"
    ...
}
```

When gradle resolves `storage-android:1.0.0` for the AsyncStorage
subproject, it uses **this** `repositories` block — not the root
project's `allprojects` block. JitPack is also added by react-native's
gradle plugin (DependencyUtils.kt:99), so it gets queried too, and
JitPack times out. Build fails.

That's why v3.1.22's root-level changes had no effect.

## v3.1.23 — patch the AsyncStorage subproject at install time

Added a new entry to `scripts/patch-native-modules.js` (the postinstall
script that already patches the audio-recorder-player JVM target).
The patcher runs after `npm install` / `npm ci` and rewrites the
AsyncStorage `repositories` block to put the `local_repo` **first**:

```gradle
repositories {
    // v3.1.23: local_repo must be FIRST so gradle finds
    // storage-android locally and never hits JitPack.
    // rootDir here is the async-storage subproject's android
    // dir, so ../local_repo is the right relative path.
    maven {
        url = uri("${rootDir}/../local_repo")
        metadataSources {
            mavenPom()
            gradleMetadata()
            artifact()
        }
    }
    mavenCentral()
    google()
}
```

`rootDir` inside the AsyncStorage subproject is
`node_modules/@react-native-async-storage/async-storage/android`,
so `${rootDir}/../local_repo` resolves to the actual local Maven
repo that ships with the package. With this in place, gradle finds
the AAR locally and never queries JitPack for it.

The patcher is idempotent — re-running it on an already-patched
file is a no-op (the `find` pattern doesn't match, so it falls
through to "ALREADY APPLIED").

## Why this is the right layer to fix

- The root `allprojects` block is the right place for repos that
  ALL subprojects share, but it doesn't override subproject-level
  repos — it adds to them.
- The AsyncStorage maintainers can't ship a project-relative repo
  path because they don't know where their package will be
  installed. Patching via `npm` postinstall is the standard fix
  for this kind of issue.
- We already have the patcher in place. Adding one more entry is
  one PR away from a clean, reviewable change.

## What I rolled back from v3.1.22

v3.1.22 made three changes. v3.1.23 keeps the v3.1.21 code fix
and the workflow NDK/build-tools version fix. The
`allprojects`-level repo changes from v3.1.22 are kept (they're
harmless and might help for other deps in the future) but they
weren't the cause of the fix. The actual fix that unblocks the
build is the AsyncStorage subproject patch.

## Files

- `scripts/patch-native-modules.js` — new patch entry for AsyncStorage
- `package.json` / `android/app/build.gradle` — bumped to v3.1.23
- `CHANGES_3.1.23.md` — this file
