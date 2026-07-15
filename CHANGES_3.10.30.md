# v3.10.30 — bar repositioning, attachment fix, wake-test diagnostics

**Four issues from v3.10.29 testing:**

1. Bar position in voice mode: Tobe wanted it centered horizontally
   with some top padding, and the YOUR TURN / cycle text moved
   down so they don't crowd the bar.
2. Settings bar should match the voice mode pill look (so the
   user recognises them as the same indicator), and have a
   moving internal bar showing the live count.
3. Chat attachments: pasting/adding a picture didn't show in the
   input area, and the send button stayed disabled because
   attachments didn't count toward the "has content" check.
4. Wake test gave "0% on 3 tries" with no diagnostic — Tobe
   couldn't tell if the mic was dead, the wake phrase was wrong,
   or the model was broken.

## What shipped

### 1. Bar positioning

**`src/screens/WakeModeScreen.tsx`:**
- `enrollmentBarCompact` View changed:
  - `alignItems: 'flex-start'` → `'center'` (the pill is
    now centered horizontally)
  - `top: 0` → `paddingTop: 16` (so it sits below the
    status bar / iOS notch with breathing room)
  - Removed the `paddingTop: Platform.OS === 'ios' ? 50 : 12`
    (replaced by the new uniform `paddingTop: 16`)
- `voiceStatusOverlay` (YOUR TURN text) moved:
  - `top: 60` → `top: 110` (so it sits below the
    centered pill without crowding)

**`src/components/VoiceEnrollmentBar.tsx`:**
- Pill `alignSelf: 'flex-start'` → `'center'`. The pill
  now centers within whatever parent it's in (the
  voice-mode top container centers it, the settings
  Section's default layout also centers it).

### 2. Settings bar matches voice mode

**`src/screens/SettingsScreen.tsx`:**
- `<VoiceEnrollmentBar variant="full" />` →
  `<VoiceEnrollmentBar variant="compact" />` so the
  settings bar uses the same pill design as voice
  mode. Same shape, same colors, same pulse, same
  internal progress strip. The "1/1000" count shows
  in the pill label as the user uses voice mode
  (every 2s poll updates it).

The compact pill in settings is centered (because
the pill uses `alignSelf: 'center'`) and floats
inside the Section's content area, matching the
look-and-feel of the voice mode pill. The two
variants now read as the same indicator regardless
of where the user sees them.

### 3. Chat attachment fix

**`src/screens/HomeScreen.tsx`:**
- New `<View style={styles.attachmentPreviewRow}>` rendered
  ABOVE the inputContainer, between the chatStatusBar and
  the input row, only when `attachments.length > 0`.
- Each attachment renders as a 60×60 thumbnail (image
  preview) or a small file card (text filename). Each
  has a small red × button in the top-right corner that
  calls `removeAttachment(att.id)`.
- The send button's `disabled` condition now includes
  `attachments.length === 0` in the check:
  ```ts
  // before
  disabled={!pendingAudioPath && (!inputText.trim() || !isConnected)}
  // after
  disabled={!pendingAudioPath && !inputText.trim() && attachments.length === 0 || !isConnected}
  ```
  So adding a picture (or a file) now enables the send
  button even with empty text.
- Six new styles for the preview row, thumbnails, file
  cards, and remove buttons.

### 4. Wake test diagnostics

**`src/components/ClassifierTest.tsx`:**
- `ClassifierTestResult` shape extended with three new
  fields:
  - `avg: number` — average score across all polled
    chunks during the test window
  - `maxChunk: number` — highest single-chunk score
    (useful for brief wake phrases)
  - `avgRms: number` — average RMS energy, a proxy
    for "did the mic hear anything at all"
- The result panel now renders two new rows:
  - "Average" — the mean score
  - "Mic RMS (avg)" — the RMS level, colored red
    when below 0.005 (effectively silence) and
    green otherwise
- New `diagnosticTip()` helper picks the most likely
  cause from four categories:
  - RMS < 0.005 → "Mic heard almost nothing. Check
    mic permission, speak louder, or hold the phone
    closer."
  - peak < 5% but RMS OK → "Mic heard you, but the
    model never matched. The wake phrase in the
    trained model may differ from what you said."
  - peak 5-30% → "Model saw something but not
    enough. Try a clearer pronunciation, or retrain."
  - peak 30-70% → "Model saw a real signal (peak X%)
    but below the 70% fire threshold. Try again, or
    retrain if it keeps happening."
  - peak ≥ 70% → existing "aim for 70%" tip
- The test runner also subscribes to the native
  `owwVad` event to capture the RMS values (5Hz
  cadence from the wake detector loop) and
  averages them over the test window.

## How the wake test is now useful

Tobe's report: "all tries gave 0%". With the new
diagnostics, the next set of tries will produce:

- If mic is dead: "0% / 0% / 0% / Mic RMS 0.001"
  → "Mic heard almost nothing"
- If wake phrase is wrong: "0% / 1% / 2% / Mic RMS 0.04"
  → "Mic heard you, but the model never matched"
- If retraining needed: "12% / 18% / 8% / Mic RMS 0.05"
  → "Model saw something but not enough"
- If threshold is the issue: "45% / 52% / 38% / Mic RMS 0.06"
  → "Model saw a real signal but below 70%"

Each tier has a specific remediation. The user doesn't
have to guess.

## Why I extended the test with avg + maxChunk

The peak is a single number. If the user said the
wake phrase once during a 4s test and the score went
0.02 → 0.05 → 0.08 → 0.12 → 0.04 → 0.02 → 0.01 → 0.01,
the peak is 0.12 (the "I said it" frame) but the avg
is 0.06 (everything else). The peak alone could lead
the user to "model matched 12%, retrain to push it
up" — when actually the model IS matching, just on
the brief frame. The avg makes the
"intermittent-match" pattern visible.

maxChunk is the high-water mark across the same
data. It's the most useful single number for
"did the model ever see something that looks
like the wake phrase" — but it's noisy in a quiet
test where the user said nothing. The combination
of peak + avg + maxChunk + RMS gives a complete
picture.

## Build artifacts

- `package.json`: 3.10.30
- `android/app/build.gradle`: versionCode 257, versionName 3.10.30
- Modified: `src/components/VoiceEnrollmentBar.tsx` —
  pill centering
- Modified: `src/screens/WakeModeScreen.tsx` —
  enrollmentBarCompact + voiceStatusOverlay positions
- Modified: `src/screens/SettingsScreen.tsx` —
  variant full → compact
- Modified: `src/components/ClassifierTest.tsx` —
  new diagnostic fields + dynamic tip
- Modified: `src/screens/HomeScreen.tsx` —
  attachment preview row, send-button enable check,
  new styles
- Pre-existing HomeScreen.tsx(2560)/(2841) TS errors
  remain — unrelated to this release per the AGENTS.md
  "pre-existing TS errors" rule.

## What's NOT in v3.10.30

- **Cycle (orb) text repositioning**: Tobe mentioned
  "move the cycle and your turn text a bit further
  down". The cycle is the companion WebView animation
  (in the center of the screen) — the user's
  reference to "the cycle" might be the recording
  indicator dot, or the WebView's central animation.
  I moved the YOUR TURN text down (top: 60 → 110) but
  didn't reposition the WebView itself. If the cycle
  is overlapping the bar, that's a v3.10.31 fix.
- **Voice mode pill click-to-expand**: the pill
  could expand on tap to show the full
  Learning X/1000 + sample count + last lock
  timestamp. Deferred; pointerEvents="none" is
  intentional so the pill never eats WebView taps.
  A v3.10.31 could add a long-press → expand
  affordance that doesn't conflict.
- **Attachment caption / annotation**: attachments
  can be sent but the user can't add a caption.
  Deferred; v3.10.20's attachment support was a
  quick add and the message composition flow is
  separate scope.