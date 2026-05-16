// Wake Word Mode: Intelligent Multi-Speaker Voice Control
// 
// Feature: Always-listening wake word with sentence recording
// Use case: Family/group conversations - only trigger when you use wake word
//
// Flow:
// 1. App starts → Wake word detector listening in background
// 2. User says "Hey Claw" → Trigger sentence recording
// 3. User speaks sentence(s) with natural pauses
// 4. If another "Hey Claw" during sending/reply → Interrupt & append new audio
// 5. Response includes all spoken parts

import { NativeModules } from 'react-native';
import { SimpleAudioRecorder } from '../services/SimpleAudioRecorder';

interface WakeWordSession {
  id: string;
  startTime: number;
  audioChunks: string[];  // base64 audio segments
  isActive: boolean;
  isProcessing: boolean;  // true during send/reply
}

/**
 * WakeWordController - Manages continuous listening + sentence recording
 * 
 * Key features:
 * - Always listening for wake word (low power)
 * - When detected: Start sentence recording
 * - Handle interrupts during send/reply
 * - Append new audio to existing message
 */
export class WakeWordController {
  private session: WakeWordSession | null = null;
  private recorder: SimpleAudioRecorder | null = null;
  private isListening = false;
  
  /**
   * Start background wake word detection
   */
  async startWakeWordDetection() {
    if (this.isListening) return;
    this.isListening = true;
    
    // Wake word module from native bridge already handles this
    // We just need to react to the wakeword:detected event
  }
  
  /**
   * When wake word detected - start recording sentence
   */
  async onWakeWordDetected() {
    // Create new session
    this.session = {
      id: Date.now().toString(),
      startTime: Date.now(),
      audioChunks: [],
      isActive: true,
      isProcessing: false,
    };
    
    // Start recording
    this.recorder = new SimpleAudioRecorder();
    const path = `/tmp/wake-sentence-${this.session.id}.m4a`;
    await this.recorder.start(path, 5000);  // 5s silence timeout
  }
  
  /**
   * If wake word comes DURING sending/reply, interrupt & append
   */
  async onWakeWordInterrupt() {
    if (!this.session || !this.session.isProcessing) {
      // Not in send/reply, just start new sentence
      return this.onWakeWordDetected();
    }
    
    // In send/reply - append new audio
    console.log('[WakeWord] Interrupt during processing - appending...');
    
    // Stop current recording if any
    if (this.recorder) {
      const audioPath = await this.recorder.stop();
      if (audioPath) {
        // Save this audio chunk
        const base64 = await readFile(audioPath, 'base64');
        this.session.audioChunks.push(base64);
      }
    }
    
    // Start new recording session
    this.recorder = new SimpleAudioRecorder();
    const path = `/tmp/wake-append-${this.session.id}-${Date.now()}.m4a`;
    await this.recorder.start(path, 5000);
  }
  
  /**
   * Complete the session - send all audio
   */
  async finalizeSpeech() {
    if (!this.session || !this.recorder) return null;
    
    this.session.isActive = false;
    
    // Stop recording
    const lastAudioPath = await this.recorder.stop();
    if (lastAudioPath) {
      const base64 = await readFile(lastAudioPath, 'base64');
      this.session.audioChunks.push(base64);
    }
    
    // Return combined audio (will be sent to desktop for processing)
    return {
      sessionId: this.session.id,
      audioSegments: this.session.audioChunks,
      totalDuration: Date.now() - this.session.startTime,
    };
  }
  
  /**
   * Mark that we're in send/reply phase
   */
  setProcessing(isProcessing: boolean) {
    if (this.session) {
      this.session.isProcessing = isProcessing;
    }
  }
}

/**
 * Integration points in HomeScreen:
 * 
 * // At startup
 * useEffect(() => {
 *   wakeWordController.startWakeWordDetection();
 * }, []);
 * 
 * // When wake word fires (from native module)
 * const onWakeWord = () => {
 *   wakeWordController.onWakeWordDetected();
 * };
 * 
 * // During send/reply
 * const sendAudio = async (base64) => {
 *   wakeWordController.setProcessing(true);
 *   syncClient.sendAudioInput(base64, 'audio/m4a');
 *   // Wait for response...
 *   wakeWordController.setProcessing(false);
 * };
 * 
 * // If wake word comes during send/reply
 * const onWakeWordDuringSend = () => {
 *   wakeWordController.onWakeWordInterrupt();
 * };
 */
