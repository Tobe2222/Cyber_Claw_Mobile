# v3.1.86

## Timestamped wake-pending flag — fresh vs stale on cold launch

Tobe (after v3.1.85): "i also noticed that when opening the app it goes
right into wake mode again... It should go to home screen"

### Root cause

The v3.1.82 native SharedPreferences `wake_pending` flag was added to
recover from the rare case where the JS context never came up within
the 5s emit-retry budget and the user had to kill+reopen the app. The
flag is set in `MainActivity.checkWakeIntent` when a wake intent is
detected, and cleared in three places:
1. `MainActivity.emitWakeOpenedWithRetry` on successful emit
2. The JS-side `wakeOpenSub` listener after catching the emit
3. The JS-side `onExit` handler when the user manually exits Wake Mode

But once set, the flag has no expiration. If any of those clear paths
fail (e.g. user kills the app before `onExit` runs, or the JS context
genuinely never came up before the user killed the app), the flag
persists across app kills. On the next cold launch, `checkNativePending`
in App.tsx reads the flag and yanks the user into Wake Mode — even
though no wake event fired in this session.

### v3.1.83 / v3.1.84 / v3.1.85 attempts

v3.1.83 removed the `AppState=active` re-check, but the mount-time
check still fired and opened wake mode on cold launch when the flag
was stale.

v3.1.84 re-added the `AppState=active` listener with a `screenRef`
guard (`if (screenRef.current !== 'home') return`). The guard prevents
the ping-pong after manual exit, but it doesn't help on the initial
mount because `screenRef` starts at `'home'` — the guard is true and
the flag is consumed.

v3.1.85 changed only the greeting flow. The cold-launch auto-entry
bug persisted.

### The fix: timestamp + expiry

**Native side (`WakeWordModule.kt` + `MainActivity.kt`):** when the
flag is set, also store `wake_pending_at = System.currentTimeMillis()`.
`isWakePending` now returns `{pending: boolean, setAt: number}` instead
of just a boolean. Both values are cleared together in `clearWakePending`
and on emit success.

**JS side (`App.tsx`):** `checkNativePending` only consumes the flag
if `Date.now() - setAt < 30_000`. Stale flags (set more than 30s ago,
presumably in a prior session) are cleared without consuming — the user
gets a normal home-screen launch.

### Why 30 seconds?

The wake-from-cold recovery case is:
1. Wake word fires
2. `MainActivity.checkWakeIntent` sets the flag + schedules retry
3. Retries fail (JS context genuinely stuck)
4. User kills the app
5. User reopens the app

For step 5 to recover the wake intent, the user has to reopen within
the same intent's "lifetime" — but Android doesn't have a defined
lifetime for an intent that opened an activity. The 30s window is
arbitrary but generous: it covers "user said wake word, app got stuck,
user force-killed and tapped the launcher icon" within a reasonable
human reaction time (kill app ~5s, switch to launcher ~2s, tap icon
~3s). After 30s, the wake intent is effectively abandoned.

If the user takes longer than 30s to reopen, the flag is stale, the
app opens to home, and the user has to say the wake word again. That's
acceptable — it's how Siri/Alexa work too.

### Why this is correct

- **Cold launch, no recent wake event:** flag is not set (cleared
  when the user exited Wake Mode) or stale (cleared without consuming).
  App opens to home. ✓
- **Wake word fires, JS context up:** emit succeeds, flag cleared in
  emit-success path, `wakeOpenSub` catches. ✓
- **Wake word fires, JS context NOT up, user reopens within 30s:**
  retry exhausts, flag stays. User reopens. `checkNativePending` reads
  flag, sees it's fresh, consumes, opens Wake Mode. ✓
- **Wake word fires, JS context NOT up, user reopens after 30s:**
  retry exhausts, flag stays but timestamp is old. User reopens.
  `checkNativePending` reads flag, sees it's stale, clears without
  consuming. App opens to home. User has to say wake word again. ✓
- **Wake mode visible, user taps X:** `onExit` clears flag + timestamp.
  AppState=active fires `checkNativePending`, reads no flag. No-op.
  No ping-pong. ✓

### Files

- `App.tsx` — `checkNativePending` checks `ageMs < STALE_FLAG_MS`
  (30s); stale flags cleared without consuming
- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` —
  `isWakePending` returns `{pending, setAt}`; `clearWakePending` clears
  both
- `android/app/src/main/java/com/cyberclawmobile/MainActivity.kt` —
  `checkWakeIntent` also stores `wake_pending_at`; `emitWakeOpenedWithRetry`
  clears it on success
- `package.json` — 3.1.85 → 3.1.86
- `android/app/build.gradle` — versionCode 135 → 136
- `.github/workflows/{build,android-build}.yml` — artifact names
- `CHANGES_3.1.86.md` (new)

### Lessons

**Recovery flags need an expiration.** The v3.1.82 flag was
correctly motivated — it solved a real bug (JS context stuck across
kill+restart). But it had no expiration. A flag with no expiration
becomes a state that "exists forever until someone clears it," and
in a system with killable processes and unpredictable user behavior,
that's effectively "exists forever." Whenever you reach for a
persistent flag as a recovery mechanism, pair it with: (a) a
timestamp, (b) a sanity-check consumer that drops stale values, OR
(c) a periodic janitor that clears old entries. Without one of
those, the recovery mechanism itself becomes a source of bugs.

**A guard at the wrong scope is no guard at all.** v3.1.84's
`screenRef.current === 'home'` check was meant to prevent the
ping-pong after manual exit. It worked for that case. But it
didn't help on the initial mount because `screenRef` starts at
`'home'`. The guard was correct at one scope (re-firing on
AppState=active) and useless at another (initial mount). When
debugging "my guard didn't work," check what state the guard
reads on the path that's failing.

**Three attempts to fix the same bug means the diagnosis is
wrong.** v3.1.83, v3.1.84, v3.1.85 each tried a different angle
on the cold-launch auto-entry bug and none fully fixed it. The
pattern was: keep tweaking the JS-side `checkNativePending` /
`AppState=active` listener while leaving the underlying issue
(a flag with no expiration) untouched. The actual fix is on the
native side (add a timestamp) + a tiny change on the JS side
(drop stale flags). When you've made multiple attempts at the
same bug and the bug keeps coming back, the next move is to
stop tweaking the symptom and look for a different layer of the
solution — in this case, the data shape of the flag itself.