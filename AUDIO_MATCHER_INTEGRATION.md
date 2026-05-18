# Audio Sample Matching Integration Plan

## Current Status (v2.13.43)

✅ **Completed:**
- AudioSampleMatcher.ts created with DTW algorithm
- WakeWordTester UI shows audio sample matching approach
- Training data loads and displays correctly
- Native module records and listens

❌ **Missing:**
- Native module doesn't use AudioSampleMatcher
- Matcher is TypeScript, native is Kotlin
- No audio feature extraction happening
- No matching/scoring being done

## Implementation Options

### Option 1: Bridge-based (Recommended for MVP)
1. During test listening, save audio to temp file
2. When listening stops, pass file path to JavaScript
3. JavaScript loads training samples + incoming audio
4. Extract features + run DTW matching
5. Return match score to native module
6. Show result in UI

**Pros:** Uses existing TypeScript matcher, no Kotlin needed
**Cons:** File I/O overhead, one-shot matching (not real-time)

### Option 2: Native Implementation (Better long-term)
1. Port AudioSampleMatcher to Kotlin
2. Extract features from audio frames as they come in
3. Run DTW matching in real-time
4. Emit match events to JS

**Pros:** Real-time detection, efficient, production-ready
**Cons:** Requires Kotlin DTW implementation

### Option 3: Hybrid (Best approach)
1. Use SimpleAudioRecorder to record test audio
2. JavaScript loads training samples from AsyncStorage
3. Load recorded audio from file
4. Extract features for both
5. Run DTW matching in JavaScript
6. Show confidence score

**Pros:** Uses existing code, can iterate quickly
**Cons:** Slightly slower, but fine for testing

## Recommendation: Implement Option 3 (Hybrid)

### Step 1: Get Audio Data
```typescript
// Load training samples as audio files
const trainingPaths = ['wake_sample_0.wav', 'wake_sample_1.wav', 'wake_sample_2.wav'];
const recordedPath = '/path/to/test_recording.wav';

// Read files as binary
const trainingSamples = await Promise.all(
  trainingPaths.map(path => RNFS.readFile(path, 'base64'))
);
const recordedAudio = await RNFS.readFile(recordedPath, 'base64');
```

### Step 2: Convert to PCM16
```typescript
// Convert base64 to PCM16 audio
const trainingFeatures = trainingSamples.map(b64 => 
  extractAudioFeatures(base64ToInt16Array(b64))
);
const recordedFeatures = extractAudioFeatures(base64ToInt16Array(recordedAudio));
```

### Step 3: Match
```typescript
const result = await matchAgainstTraining(
  recordedFeatures,
  trainingFeatures,
  0.65  // threshold
);

if (result.matched) {
  setTestLog(prev => [...prev, `✅ MATCH! Score: ${(result.score * 100).toFixed(0)}%`]);
} else {
  setTestLog(prev => [...prev, `❌ No match. Best: ${(result.score * 100).toFixed(0)}%`]);
}
```

### Step 4: Show Results
Display match score, best match sample, and confidence

## Files to Modify

1. **WakeWordTester.tsx**
   - Integrate AudioSampleMatcher
   - Load training samples from AsyncStorage
   - After stop, process recorded audio
   - Show match results

2. **SimpleAudioRecorder.ts** 
   - Save audio file path for later processing
   - Or save base64 for direct processing

3. **HomeScreen.tsx** (later)
   - Use same matcher in actual Wake Mode
   - Real-time detection in background

## Testing Strategy

1. Train wake phrase (done)
2. Open tester
3. Record test audio
4. See real-time matching results
5. Adjust threshold if needed
6. Once working, integrate to Wake Mode

## Success Criteria

- ✅ Test recording loads
- ✅ Training samples load
- ✅ Features extract without errors
- ✅ DTW matching runs
- ✅ Match score displayed (0-1)
- ✅ Matches own training samples (high score)
- ✅ Rejects different sounds (low score)
- ✅ Threshold ~0.65-0.75 triggers detection
