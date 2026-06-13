# Wake Mode Integration Guide

## Current Status (v2.13.23)

✅ **UI Layer Complete:**
- Toggle button (🗣️) next to Mic button
- Green active state
- State management ready
- Log entry on toggle

## Next: Logic Integration

### When Wake Word Detected (Already Working)

The native WakeWordModule already detects "Hey Claw" in background.
When detected, it fires the `recorderWakeWord` event.

**We need to:**
1. In `onWakeWordDetected` handler → Check if `isWakeWordMode` is on
2. If ON → Start recording sentence (auto)
3. If OFF → Only show fullscreen (manual voice mode)

### Code Location to Update

File: `src/screens/HomeScreen.tsx`

Find the `onWakeWordDetected` handler (around line 620-680) and modify:

```typescript
// Current: Starts only on wakeword
const onWakeWordDetected = () => {
  if (isWakeWordMode) {
    // NEW: Auto-enter voice mode to record sentence
    enterVoiceMode('wakeword');
  } else {
    // Existing: Manual mode, just show fullscreen
    enterVoiceMode('wakeword');  
  }
};
```

### Interrupt Handling

**During Send/Reply Phase:**

1. Track session state: `wakeWordSession.isProcessing = true`
2. When another wake word comes in:
   ```typescript
   if (wakeWordSession?.isProcessing) {
     // Append to current message
     const newAudioPath = ... // save current recording
     wakeWordSession.audioChunks.push(newAudioPath);
     // Continue recording next segment
   }
   ```

### Files to Update

1. **HomeScreen.tsx** (Main integration)
   - Modify wakeword detection handler
   - Add interrupt logic
   - Connect isWakeWordMode to audio flow

2. **services/SyncClient.ts** (Optional)
   - Add `sendAudioSegments()` for multi-part messages
   - Or use existing `sendAudioInput()` multiple times

## Implementation Steps

### Phase 1: Auto-trigger on Wake Word
- [  ] Update onWakeWordDetected to check `isWakeWordMode`
- [  ] Auto-enter voice mode when triggered
- [  ] Test: Say "Hey Claw" → auto-record sentence

### Phase 2: Interrupt + Append
- [  ] Track session.isProcessing state
- [  ] When second wake word → save current audio chunk
- [  ] Append to audio chunks array
- [  ] Continue recording

### Phase 3: Send Multi-part Audio
- [  ] Combine all audio chunks
- [  ] Send as single or multiple segments
- [  ] Desktop processes all together

## Testing Checklist

```
Wake Mode OFF:
[ ] Click Mic button → Manual recording works
[ ] Say "Hey Claw" → Just shows fullscreen, doesn't record

Wake Mode ON:
[ ] Say "Hey Claw" → Auto-record starts
[ ] Normal pause → Recording continues
[ ] Say "Hey Claw" again during send → Appends new audio
[ ] No "Hey Claw" → Silent timeout sends after 5s

Multi-person:
[ ] Only records when someone says trigger
[ ] Background noise ignored
[ ] Can continue adding via repeat wake words
```

## Desktop Integration

Desktop needs to:
1. Receive audio segments marked as "wake mode"
2. Know if this is continuation of previous message
3. Wait for final audio (or timeout) before responding
4. Send response after all audio collected
