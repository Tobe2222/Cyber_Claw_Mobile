# Phase 5: Wake Word Matching Implementation

## Current Status (v2.13.74)

✅ Native module records audio
✅ Background listening starts/stops
✅ Settings toggle controls listening
❌ **No actual matching yet**

The native module just calculates energy levels. We need real DTW (Dynamic Time Warping) matching.

## What Needs to Happen

### 1. Pass Training Data to Native Module

From JS → Kotlin:
- Training samples (3 audio samples user recorded)
- Extract features (MFCC or simple energy-based)
- Store in native module

**Current blocker:** Need to pass training data from app to native

### 2. Extract Audio Features

When recording:
- Convert audio frames → energy/spectral features
- Build feature vector for each chunk
- Store as circular buffer

**Current status:** Energy calculation exists, needs enhancement

### 3. Implement DTW Matching

For each incoming audio chunk:
- Extract features
- Calculate DTW distance to each training sample
- Average the 3 samples
- If distance < threshold → MATCH!

**Current status:** Not implemented

### 4. Trigger Detection

When match found:
- Send event back to JS
- Show Toast: "✅ Wake word detected!"
- Auto-start recording
- OR: Unlock screen
- OR: Launch recording

**Current status:** No event system yet

## Architecture

```
Settings.tsx
    ↓ toggle ON
NativeBackground.startListening()
    ↓
Android AudioRecord
    ↓
Extract Features (MFCC/Energy)
    ↓
DTW vs Training Samples
    ↓
Match? → Send event back to JS
         → Show Toast
         → Start recording/unlock screen
```

## Estimated Work

1. Pass training data to native: ~1 hour
2. Feature extraction: ~30 mins
3. DTW implementation: ~2 hours
4. Event system (JS callback): ~30 mins
5. Testing & tuning: ~1 hour

**Total: ~5 hours**

## Alternative (Simpler)

Instead of DTW in native, we could:
- Record audio in native
- Send to JS periodically
- Do matching in JS (already have code)
- Show results on UI

**Pros:** Faster, reuse existing code
**Cons:** Battery drain, more data transfer

## Next Step

We need to decide:
1. **Full native DTW** - Most efficient, more work
2. **Hybrid (record native, match JS)** - Faster to implement
3. **Both** - Do hybrid first, then optimize to native

**Recommendation:** Start with hybrid, get it working, then optimize.
