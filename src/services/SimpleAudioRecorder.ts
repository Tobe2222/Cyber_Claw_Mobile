/**
 * SimpleAudioRecorder - Clean audio recording wrapper
 * 
 * PURPOSE: Handle chat mic and voice mode recording without any wake word logic
 * 
 * API:
 *   - start(filepath: string, silenceTimeoutMs?: number) → Promise<void>
 *   - stop() → Promise<string> (returns WAV filepath; v3.9.4
 *     switched from m4a/MediaRecorder to WAV/AudioRecord so
 *     the recorder stream can be fed to the openWakeWord
 *     send-phrase detector in lockstep with the recording)
 *   - isSilenceDetected() → boolean
 *   - dispose() → void
 * 
 * Events:
 *   - 'silence' → Emitted when silence timeout reached
 *   - 'error' → Emitted on error
 */

import { NativeModules, NativeEventEmitter } from 'react-native';

const { WakeWordModule } = NativeModules;

interface SimpleAudioRecorderListener {
  (event: 'silence' | 'error', message?: string): void;
}

export class SimpleAudioRecorder {
  private recordingPath: string | null = null;
  private isRecording = false;
  private silenceDetected = false;
  private emitter: NativeEventEmitter | null = null;
  private listeners: Map<string, Set<SimpleAudioRecorderListener>> = new Map();

  constructor() {
    // Set up native event listeners (shared with WakeWordModule)
    if (WakeWordModule) {
      this.emitter = new NativeEventEmitter(WakeWordModule);
      
      // Listen for silence events from native module
      this.emitter.addListener('recorderSilence', () => {
        this.silenceDetected = true;
        this.emit('silence');
      });
    }
  }

  /**
   * Start recording to the specified filepath
   * @param filepath Path where the WAV file will be saved
   *   (v3.9.4: was m4a, now WAV — internal format change,
   *   callers should pass a `.wav` path)
   * @param silenceTimeoutMs Timeout in milliseconds (default 5000)
   */
  async start(filepath: string, silenceTimeoutMs: number = 5000): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    try {
      this.recordingPath = filepath;
      this.silenceDetected = false;
      
      if (!WakeWordModule?.startRecorderWithSilence) {
        throw new Error('WakeWordModule not available');
      }

      await WakeWordModule.startRecorderWithSilence(filepath, silenceTimeoutMs);
      this.isRecording = true;
    } catch (error: any) {
      this.isRecording = false;
      this.recordingPath = null;
      this.emit('error', error?.message || 'Failed to start recording');
      throw error;
    }
  }

  /**
   * Stop recording and return the filepath
   */
  async stop(): Promise<string> {
    if (!this.isRecording) {
      throw new Error('No recording in progress');
    }

    try {
      if (!WakeWordModule?.stopRecorder) {
        throw new Error('WakeWordModule not available');
      }

      const resultPath = await WakeWordModule.stopRecorder();
      this.isRecording = false;
      this.recordingPath = null;
      return resultPath || '';
    } catch (error: any) {
      this.isRecording = false;
      this.recordingPath = null;
      this.emit('error', error?.message || 'Failed to stop recording');
      throw error;
    }
  }

  /**
   * Check if silence was detected
   */
  isSilenceDetected(): boolean {
    return this.silenceDetected;
  }

  /**
   * Check if currently recording
   */
  isActive(): boolean {
    return this.isRecording;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.isRecording) {
      this.stop().catch(() => {});
    }
    this.emitter?.removeAllListeners();
    this.listeners.clear();
  }

  /**
   * Event emitter - internal use
   */
  private emit(event: 'silence' | 'error', message?: string): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => cb(event, message));
    }
  }

  /**
   * Register event listener
   */
  on(event: 'silence' | 'error', callback: SimpleAudioRecorderListener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Register one-time event listener
   */
  once(event: 'silence' | 'error', callback: SimpleAudioRecorderListener): () => void {
    const unsubscribe = this.on(event, (e, msg) => {
      callback(e, msg);
      unsubscribe();
    });
    return unsubscribe;
  }
}

// Singleton instance
let recorderInstance: SimpleAudioRecorder | null = null;

export function getSimpleAudioRecorder(): SimpleAudioRecorder {
  if (!recorderInstance) {
    recorderInstance = new SimpleAudioRecorder();
  }
  return recorderInstance;
}

export function disposeSimpleAudioRecorder(): void {
  recorderInstance?.dispose();
  recorderInstance = null;
}
