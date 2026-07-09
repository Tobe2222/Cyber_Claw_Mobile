# v3.8.6 — CI: bump workflows to Node-24-compatible actions

Tobe: "that build failed quickly. Build failed at
step 5 'Set up Android SDK' (android-actions/setup-
android@v3) after 1m 1s."

This release is a CI-only fix. No code changes.

## What happened

GitHub Actions runners moved to **Node.js 24 by
default on 2026-06-02** (Node.js 20 was deprecated
2025-09-19). Our workflow file had been bumped
forward on most actions (`actions/checkout@v4`,
`actions/setup-java@v4`, `actions/setup-node@v4`),
but **`android-actions/setup-android@v3` was left
on @v3**. That action was last updated November 2024
and its `package.json` pins Node 20 as the runtime.
With GitHub now forcing it to run on Node 24, the
internal SDK-download path broke.

Tobe's `v3.8.5` build (`run #541`) hit this at
the `Set up Android SDK` step:

```
build-android
  Set up job                            success
  Checkout                              success
  Set up JDK 17                         success
  Set up Node.js                        success
  Set up Android SDK (android-actions/setup-android@v3)
                                       failure
  Install SDK components                skipped
  ...
```

The previous `v3.8.4` build (`run #409`) had succeeded
the day before with the same workflow file — the cutoff
was the runner image upgrade. The fix is the action
bump.

## Fix

`android-actions/setup-android` released **v4.0.0**
(then 4.0.1, Apr 2026) specifically to address the
Node-20 deprecation. Bumping `@v3` -> `@v4` picks up
the Node-24-compatible release.

Also added the `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`
env var at the workflow level. Per GitHub's
migration guide, this forces any remaining Node-20
actions on the runner to be re-targeted to Node 24
without changing each `uses:` line individually —
useful if a future action update lags.

### build.yml changes

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

# ...

- name: Set up Android SDK
  uses: android-actions/setup-android@v4   # was @v3
```

### android-build.yml changes (the legacy CI workflow)

Was on `@v3` for `checkout` / `setup-node` /
`setup-java` / `setup-android`, plus `node-version:
'18'`. Brought forward to match the main
release-build workflow:

- `actions/checkout@v3` -> `@v4`
- `actions/setup-node@v3` -> `@v4`,
  `node-version: '18'` -> `'22'`
- `actions/setup-java@v3` -> `@v4`
- `android-actions/setup-android@v3` -> `@v4`
- `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` added

This workflow has been stale for a while — its
artifact name was still `app-debug-3.2.27` (Tobe
noted this in v3.8.3's CHANGES). Not bumping the
artifact name here since Tobe hasn't asked; just
fixing the runner break.

## Mobile version bump

- `package.json` `"version": "3.8.5" → "3.8.6"`
- `android/app/build.gradle` `versionCode 220 → 221`,
  `versionName "3.8.5" → "3.8.6"`

The version bump is mostly ceremonial here — no
runtime changes for the user, just CI plumbing.
The next release tag (`v3.8.6`) should now build
end-to-end.

## Files touched

- `.github/workflows/build.yml` (`android-actions@v4`,
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` env)
- `.github/workflows/android-build.yml` (all `@v3`
  -> `@v4`, Node 18 -> 22, FORCE env)
- `package.json` (3.8.5 → 3.8.6)
- `android/app/build.gradle` (versionCode 220 → 221,
  versionName 3.8.5 → 3.8.6)

## Not touched

- No code changes. v3.8.5's wake-trainer fix
  (the empty-slot onChangeText no-op) is unchanged
  on disk and works as designed; the build was
  failing before it got to the bundling step.
- Desktop. No impact.
- Other trainers / screens.
- The stale artifact name `app-debug-3.2.27` —
  out of scope for this fix.