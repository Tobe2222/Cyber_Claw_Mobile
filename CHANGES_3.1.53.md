# 3.1.53 — Even calmer companion state machine

## What it fixes
Tobe reported clawsuu was "spamming up and down hastily" even after v3.1.51's tuning. Lamasuu seemed calmer. The state distribution and direction bias from v3.1.51 weren't enough.

## Why the bias didn't help much
The v3.1.51 logic: 35% idle / 60% walk / 5% zoomies, with 60% direction bias. The issue: with 60% walk, the companion rolls walk 60% of the time. Each walk roll is independent, and 25% of those walks end up going UP and 25% DOWN (dir=0 vs dir=1). So on any given walk, there's a 50% chance of going vertical. Combined with the 60% bias, the companion still alternates between vertical directions over time.

The "spam up and down" pattern is the state machine flipping between dir=0 (down) and dir=1 (up) on consecutive rolls. Each roll has 25% chance of each direction. With the bias at 60%, the bias prevents some flips but not all.

## The fix
- **State distribution: 60% idle / 38% walk / 2% zoomies** (was 35/60/5 → 50/47/3 → now 60/38/2).
- **Direction bias: 75%** (was 60%). Companion has 75% chance of keeping the same direction on next walk.
- **Idle duration 3-6s** (was 2-5s). Longer rest periods.
- **Walk duration 3-6s** (was 3-7s). Slightly shorter walks.
- **Zoomies duration 0.3-0.6s** (was 0.4-0.8s). Very short dashes.

The companion now spends ~60% of its time resting, ~38% walking (mostly in one direction for 3-6s), and ~2% zoomies. The "spam up and down" pattern should be very rare.

## Files changed
- `android/app/src/main/assets/arena.html` — pickState tuning
- `package.json` — 3.1.52 → 3.1.53
- `android/app/build.gradle` — versionCode 102 → 103, versionName "3.1.53"
- `.github/workflows/{build,android-build}.yml` — artifact names to 3.1.53
- `CHANGES_3.1.53.md` (new)

## On the lamasuu size question
Tobe: "Lamasuu has become big 🤷"

I checked the config. The desktop has:
- `clawsuu`: no scale set (uses desktop default 5 → mobile 2)
- `lamasuu`: scale=3 (→ mobile 1)

So clawsuu SHOULD be 2x larger than lamasuu on mobile (64px vs 32px sprite). But the screenshot shows lamasuu's body taller than clawsuu's.

This might be a perception issue — the hare sprite has long ears that extend the visible height, while the boar sprite's body fills the frame compactly. At scale 2 vs scale 1, the boar's COMPACT body might LOOK smaller than the hare's spread-out (ears + body) silhouette, even though the boar has more pixels.

To verify: open Settings → Wake Word → click the gear icon → check the actual scale values for each companion. Or add the debug overlay back briefly to see the numeric scales.

## On qwen + voice mode
Tobe: "Can lamasuu which uses qwen handle voice mode?"

Yes, with caveats. Voice mode works like this:
1. You tap the mic / wake fires → audio is captured on the phone
2. The audio is sent to the desktop via the sync client (`sendAudioInput`)
3. The desktop transcribes the audio to text (using a separate model — Whisper, Vosk, or the speech recognition system, NOT qwen)
4. The transcribed text is sent to the **active chat companion's model** (qwen in this case, if lamasuu is active)
5. qwen generates a response → sent back to the mobile

The transcription step is independent of which companion is active. So voice INPUT works regardless. The text RESPONSE comes from qwen, which is a code-tuned model — it can handle text chat but its responses might be more terse or code-flavored than Claude or minimax. If you want chatty/creative responses, lamasuu might be a worse choice than clawsuu. But it WORKS.

If lamasuu's responses are unusable, the fix is to either (a) set lamasuu's model to a chat-tuned one on the desktop, or (b) route voice responses to clawsuu's model while showing lamasuu as the visible companion. Both would need desktop-side changes.