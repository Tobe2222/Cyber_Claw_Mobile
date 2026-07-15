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
import AsyncStorage from '@react-native-async-storage/async-storage';

const { WakeWordModule } = NativeModules;

// v3.10.28: AsyncStorage key for the smart-silence
// user toggle. Read on every recorder start (not at
// app boot) so the user can change it in Voice mode
// settings and the next recording turn picks up the
// new value without an app restart.
const SMART_SILENCE_KEY = 'cyberclaw-smart-silence';

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

      // Listen for silence events from native module.
      // v3.10.28: payload now carries smart-silence
      // calibration stats (noise floor, speech floor,
      // current thresholds) so the JS side can log
      // them. Backward-compatible: if the payload
      // is null (older native builds), we just
      // don't log.
      this.emitter.addListener('recorderSilence', (payload: any) => {
        this.silenceDetected = true;
        this.lastSilenceEvent = payload || null;
        this.emit('silence');
      });
    }
  }

  // v3.10.28: cache of the most recent silence
  // event payload (null for older native builds).
  // Exposed via getLastSilenceStats() so the
  // caller can log it next to the existing
  // "silence detected after Xms" message.
  private lastSilenceEvent: any = null;
  getLastSilenceStats(): {
    useSmartSilence: boolean;
    smartReady: boolean;
    noiseFloor: number;
    speechFloor: number;
    silenceThreshold: number;
    speechThreshold: number;
    maxRecordingHit: boolean;
  } | null {
    if (!this.lastSilenceEvent) return null;
    return {
      useSmartSilence: !!this.lastSilenceEvent.useSmartSilence,
      smartReady: !!this.lastSilenceEvent.smartReady,
      noiseFloor: Number(this.lastSilenceEvent.noiseFloor) || 0,
      speechFloor: Number(this.lastSilenceEvent.speechFloor) || 0,
      silenceThreshold: Number(this.lastSilenceEvent.silenceThreshold) || 0,
      speechThreshold: Number(this.lastSilenceEvent.speechThreshold) || 0,
      maxRecordingHit: !!this.lastSilenceEvent.maxRecordingHit,
    };
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
      this.lastSilenceEvent = null;

      if (!WakeWordModule?.startRecorderWithSilence) {
        throw new Error('WakeWordModule not available');
      }

      // v3.10.28: read the smart-silence toggle from
      // AsyncStorage. Default ON (true) — the
      // relative-threshold design is strictly better
      // than the v3.10.12 absolute-threshold design
      // in every environment we can think of (quiet
      // room, café, traffic, HVAC). Users who want
      // the old behavior can flip the toggle off in
      // Voice mode settings.
      let useSmartSilence = true;
      try {
        const stored = await AsyncStorage.getItem(SMART_SILENCE_KEY);
        if (stored === 'false') useSmartSilence = false;
      } catch (_) {}

      await WakeWordModule.startRecorderWithSilence(filepath, silenceTimeoutMs, useSmartSilence);
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
