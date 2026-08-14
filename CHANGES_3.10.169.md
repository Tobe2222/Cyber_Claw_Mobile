# v3.10.169 — bucket-A false-wake diagnostic + threshold nudge

## What changed

Tobe (2026-08-14): "I still have an issue with false wakes ... its all bucket A false triggers" — so we land both: a **diagnostic log** that captures every wake-event decision AND a **cheap threshold nudge** that should kill the bulk of bucket-A fires immediately. Iterate from data next version.

### 1. FIRE-LOG — every wake decision gets a structured log line

New log tag, both foreground (`WakeWord`) and background (`CyberClawService`):

```
[FIRE-LOG] session={fg|bg} peak=0.XX thr=0.XX frames=N voiceActive={0|1|n/a} speakerMatch={0.XX|n/a} outcome={FIRE|SPEAKER_SUPPRESS|COOLDOWN_SUPPRESS} model={wakeword|bg-oww}
```

Captures:

- `peak` — the OWW wake score at the moment of fire
- `thr` — the active threshold (lets us see how close to the line we are)
- `frames` — consecutive-frames run that satisfied HIGH_SCORE_RUN (3→4 after this version)
- `voiceActive` — was the chunk at wake-fire RMS+ZCR-classified as speech? Foreground only (`n/a` for BG because BG doesn't compute per-chunk RMS)
- `speakerMatch` — cosine similarity to profile, or `n/a` if no profile is locked
- `outcome` — `FIRE`, `SPEAKER_SUPPRESS`, or `COOLDOWN_SUPPRESS`
- `model` — the loaded wake model name

Captured on ALL three branches (FIRE / SPEAKER_SUPPRESS / COOLDOWN_SUPPRESS) so duplicates and suppressions are visible — not just clean fires.

### 2. Threshold tune — cheap and reversible

Two variables nudged from 0.5 to 0.55:

- `WakeWordModule.kt` lazy-init path (line 2554): `fresh.setThreshold(0.5f)` → `0.55f`
- `CyberClawService.kt` (line 51): `bgOwwThreshold: Float = 0.5f` → `0.55f`
- Two JS callers: `OpenWakeWordTrainer.tsx` (lines 392, 400) and `ClassifierTest.tsx` (line 302) `initOww(wakeword, 0.5)` → `0.55`

Only changed **defaults**, not the load-from-SharedPreferences threshold path. If 0.55 turns out to be too aggressive for legitimate wakes (the FIRE-LOG will tell us next week), one-line revert.

### 3. HIGH_SCORE_RUN bump — 3 → 4 frames

`WakeWordModule.kt:2614` and `CyberClawService.kt:74` both bumped:

- 3 frames × 80ms = 240ms sustained above-threshold required
- 4 frames × 80ms = 320ms sustained

A genuine wake is 400-600ms (5-7 frames); a TV/radio blip is rarely more than 150-200ms (2-3 frames). Bumping from 3 to 4 culls the spurious-short-burst fires without affecting real speech.

If the FIRE-LOG shows bucket-A fires cluster at frames=4 (just-barely-hit), next version's bump to 5 frames would catch them. If they shift to frames=5, we know the model itself is producing longer matching runs and HIGH_SCORE_RUN alone won't help — then it's a threshold question.

### 4. NO change to voice training logic

This version deliberately leaves the speaker gate alone. We're collecting data, not guessing. v3.10.169+ will adjust `recentK = 8 → 3` if the FIRE-LOG shows the gate is letting through false wakes whose speakerMatch is spuriously > 0.50 due to averaging over too long a window.

## How to read the diagnostic

```bash
adb logcat -s WakeWord:I CyberClawService:I | tee /tmp/wake.log
```

After ~1 week of normal use, expect a distribution like:

- **Real wakes**: `outcome=FIRE peak=0.70-0.95 frames=5-7 voiceActive=1 speakerMatch=0.85-0.95`
- **Bucket A (TV/radio)**: `outcome=FIRE peak=0.45-0.60 frames=4 voiceActive=0 speakerMatch=n/a` (or `=0.XX` for close-sounding human voices)
- **Bucket B (other speaker)**: `outcome=SPEAKER_SUPPRESS peak=0.XX frames=4 voiceActive=1 speakerMatch=0.30-0.45`

If Bucket A still appears after the threshold bump + HIGH_SCORE_RUN bump, the next levers are:

- Push threshold further (0.55 → 0.60)
- Push HIGH_SCORE_RUN further (4 → 5)
- Tighten `recentK` in `matchRecentSpeaker` (8 → 3) for the human-sounding subset

## Files changed

- `android/app/src/main/java/com/cyberclawmobile/WakeWordModule.kt` — FIRE-LOG in foreground wake path; HIGH_SCORE_RUN 3 → 4; lazy-init threshold 0.5 → 0.55
- `android/app/src/main/java/com/cyberclawmobile/CyberClawService.kt` — FIRE-LOG in background wake path; BG_OWW_HIGH_SCORE_RUN 3 → 4; bgOwwThreshold 0.5 → 0.55
- `src/components/OpenWakeWordTrainer.tsx` — two `initOww(0.5)` → `initOww(0.55)` calls (active + jarvis fallback)
- `src/components/ClassifierTest.tsx` — `initOww(0.5)` → `initOww(0.55)`
- `android/app/build.gradle` — versionCode 378 → 379, versionName "3.10.168" → "3.10.169"
- `package.json` — version 3.10.168 → 3.10.169

## Verification

- `gradlew compileReleaseKotlin` — clean (`BUILD SUCCESSFUL in 35s`)
- `gradlew assembleRelease` — clean (`BUILD SUCCESSFUL in 20s`); APK at `android/app/build/outputs/apk/release/app-release.apk`
- No JS bundle change required (the threshold changes are all native); bundle compiles unchanged

## Follow-ups for v3.10.170+

These are concrete and waiting on the FIRE-LOG data — no need to guess further:

1. **Tune HIGH_SCORE_RUN 4 → 5** if bucket-A still appears at frames=4
2. **Tune threshold 0.55 → 0.6** if real wakes don't get hit by it (mean peak > 0.65) but bucket A does (mean peak < 0.55)
3. **Tune `matchRecentSpeaker` recentK 8 → 3** if bucket-A human-sounding fires show `speakerMatch=0.50-0.55` (meaning the average over 8 frames includes both wake-word audio AND non-speech tail, dragging the match up artificially)
4. **Auto-tier upgrade (the v3.10.168 plan)** — once we have good false-wake data, schedule the speaker-embedding hot-swap path
