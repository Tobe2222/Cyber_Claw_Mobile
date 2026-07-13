# Wake Word Training & Testing - How It Works

## Training Phase

### Step 1: Enter Wake Phrase
- Type your phrase (e.g., "hey clawsuu")
- Click "Begin Training"

### Step 2: Record 3 Samples
- Click the Record button
- Speak clearly and naturally
- Let go when done (auto-stops at 5s)
- Records to: `~/cache/wake_sample_0.wav`, etc. (v3.9.4: was `.m4a`/MediaRecorder; now `.wav`/AudioRecord so the recorder stream can feed the openWakeWord send-phrase detector in real time — see `CHANGES_3.9.4.md`)

### Step 3: Audio Validation
Each recording is validated:
- ✅ Duration: 150ms - 5s
- ✅ Not silent (has audio data)
- ✅ Has detectable volume

If fails: Message shows why (e.g., "Too short: 0.0s")

### Step 4: Feature Extraction
For each recording:
1. Convert audio file → PCM16 audio data
2. Calculate energy envelope (volume over time)
3. Calculate zero-crossing rate (frequency patterns)
4. Compare to previous samples for quality

### Step 5: Quality Scoring
- Compare sample 2 to sample 1 → similarity %
- Compare sample 3 to samples 1 & 2 → similarity %
- Average = overall quality (0-100%)

**Quality Interpretation:**
- **> 70% (Green):** Excellent! All samples similar
- **50-70% (Yellow):** Fair. Some variation in samples
- **< 50% (Red):** Poor. Samples too different

### Step 6: Training Summary
Shows:
```
Sample 1: 87% ✅ (0.15s)
Sample 2: 91% ✅ (0.18s)
Sample 3: 65% ⚠️ (0.14s)
─────────────────────
Overall: 81% - Excellent!
```

### Step 7: Save or Retrain
- If happy: Click "Save Training"
- If poor: Click "Retrain"

Saved data includes:
```json
{
  "phrase": "hey clawsuu",
  "sampleCount": 3,
  "qualityScores": [0.87, 0.91, 0.65],
  "overallQuality": 0.81,
  "features": [
    { energy: [...], zcr: [...], duration: 2400 },
    { energy: [...], zcr: [...], duration: 2880 },
    { energy: [...], zcr: [...], duration: 2240 }
  ]
}
```

---

## Testing Phase

### Step 1: Load Training Data
Tester automatically loads saved features:
```
✅ Training loaded
   Phrase: "hey clawsuu"
   Samples: 2 (might be <3 if some failed)
   Quality: 81%
   
✅ Have 2 feature sets for matching
   ⚠️ Only 2 samples - retrain for full accuracy
   
✅ Ready to test - features loaded
```

### Why Only 2 Samples?
If 3rd recording failed validation:
- Got flagged as "Too short" or "Silent"
- Wasn't saved to feature set
- Training continued with 2 samples
- Still works, but not as accurate

**Solution:** Retrain and speak more clearly/longer

### Step 2: Match Score Display
Shows current training quality:
```
✅ Match Score: 81% (Match!)
```

This is the **baseline quality** of your training.
- 81% = your 2-3 samples are consistent with each other
- Ready for live testing

### Step 3: Record Test Audio
- Click "Start Test"
- Speak your phrase multiple times
- Click "Stop" when done

Tester records audio and processes it.

### Step 4: Audio Matching (Future)
Once integration complete:
1. Load recorded test audio
2. Extract features (same as training)
3. Compare recorded features to training features
4. Run DTW (Dynamic Time Warping) algorithm
5. Return match score: 0-100%
6. **> 65% = Detection triggered! ✅**

---

## Audio Features Explained

### Energy Envelope
"Loudness over time"
- Measures volume in 10ms windows
- Creates array: [0.1, 0.2, 0.15, 0.18, ...]
- Used to match speaking style/intensity

### Zero-Crossing Rate (ZCR)
"Frequency patterns"
- Counts how often audio crosses zero
- Low ZCR = low frequency (bass)
- High ZCR = high frequency (treble)
- Used to match voice characteristics

### Example:
```
"hey clawsuu" spoken by you:
Energy:  [0.15, 0.18, 0.22, 0.19, 0.16, ...]
ZCR:     [0.08, 0.10, 0.12, 0.11, 0.09, ...]

Same phrase spoken again:
Energy:  [0.14, 0.19, 0.21, 0.20, 0.17, ...]  ← Similar!
ZCR:     [0.09, 0.11, 0.13, 0.10, 0.08, ...]  ← Similar!

Result: High match score ✅
```

---

## Troubleshooting

### "Too Short: 0.0s"
- Audio completely silent or not recorded
- Try again, speak more clearly
- Check microphone isn't muted

### "Only 2 samples" in Tester
- 3rd recording failed validation
- Retrain - speak more clearly
- Make recordings 0.2-1.0 seconds each

### Low Quality (< 50%)
- Samples too different from each other
- Retrain - try to be consistent
- Speak with same tone/speed each time

### Quality shows but no detection during test
- Training summary shows 80-90% ✅
- Live matching not yet integrated
- Currently shows training quality only
- Full detection coming soon!

---

## What's Next

**Current State (v2.13.52):**
- ✅ Train with 3 samples
- ✅ Extract audio features
- ✅ Show training quality
- ✅ Display sample summary
- ❌ Real-time detection not yet integrated

**TODO:**
1. Load recorded test audio
2. Extract features from test
3. Run DTW matching
4. Compare to training features
5. Auto-detect when score > 65%
6. Trigger on "hey clawsuu" automatically

---

## Quick Reference

| Action | What Happens |
|--------|-------------|
| Train | Record 3x → Extract features → Save quality |
| Test Start | Load training features → Show quality |
| Test Record | Capture audio → Process → Show match |
| Match > 65% | DETECTED! ✅ |
| Quality > 70% | Excellent training ✅ |
| Quality 50-70% | Fair training ⚠️ |
| Quality < 50% | Poor training ❌ Retrain |
