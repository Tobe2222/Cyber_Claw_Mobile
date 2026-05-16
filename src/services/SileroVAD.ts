/**
 * Simplified Voice Activity Detection (VAD) for Real-Time Audio
 * 
 * Detects speech vs silence using:
 * 1. RMS (Root Mean Square) energy threshold
 * 2. Frequency analysis
 * 3. Zero-crossing rate
 * 
 * Returns probability (0.0-1.0) that current frame contains speech
 */

export interface VADConfig {
  sampleRate: number;
  frameSize: number;  // samples per frame (e.g., 512)
  silenceThreshold: number;  // RMS threshold (0-1)
  minSpeechDuration: number;  // ms of speech before triggering
}

export class SimpleVAD {
  private config: VADConfig;
  private speechFrameCount = 0;
  private silenceFrameCount = 0;
  private isSpeaking = false;
  
  // History for smoothing
  private energyHistory: number[] = [];
  private maxHistorySize = 10;
  
  constructor(config: Partial<VADConfig> = {}) {
    this.config = {
      sampleRate: 16000,
      frameSize: 512,
      silenceThreshold: 0.02,  // Adjusted for typical speech
      minSpeechDuration: 200,  // 200ms of speech detected
      ...config,
    };
  }
  
  /**
   * Process audio frame and return speech probability
   * @param audioFrame PCM audio samples (Int16Array or Float32Array)
   * @returns Probability 0.0-1.0 (0=silence, 1=definite speech)
   */
  process(audioFrame: Int16Array | Float32Array): number {
    // Convert to float if needed
    const samples = this.toFloat32(audioFrame);
    
    // Calculate RMS energy
    const rms = this.calculateRMS(samples);
    
    // Store in history
    this.energyHistory.push(rms);
    if (this.energyHistory.length > this.maxHistorySize) {
      this.energyHistory.shift();
    }
    
    // Calculate smoothed energy (average of recent frames)
    const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
    
    // Calculate zero-crossing rate (indicates speech vs noise)
    const zcr = this.calculateZeroCrossingRate(samples);
    
    // Combined probability
    let probability = 0;
    
    // If energy is above silence threshold
    if (avgEnergy > this.config.silenceThreshold) {
      // Speech typically has higher ZCR variability
      // Give more weight to energy, some to ZCR
      probability = Math.min(1, (avgEnergy / (this.config.silenceThreshold * 3)) * 0.8 + (zcr / 0.3) * 0.2);
    }
    
    // Track speech state
    if (probability > 0.5) {
      this.speechFrameCount++;
      this.silenceFrameCount = 0;
    } else {
      this.silenceFrameCount++;
      this.speechFrameCount = 0;
    }
    
    // Update is speaking state
    const frameMs = (this.config.frameSize / this.config.sampleRate) * 1000;
    const speechDurationMs = this.speechFrameCount * frameMs;
    
    if (speechDurationMs >= this.config.minSpeechDuration && !this.isSpeaking) {
      this.isSpeaking = true;
    } else if (this.silenceFrameCount > 5 && this.isSpeaking) {
      this.isSpeaking = false;
    }
    
    return probability;
  }
  
  /**
   * Check if currently speaking
   */
  isSpeechDetected(): boolean {
    return this.isSpeaking;
  }
  
  /**
   * Get smoothed energy level (for visualization)
   */
  getEnergyLevel(): number {
    if (this.energyHistory.length === 0) return 0;
    return this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
  }
  
  /**
   * Reset state
   */
  reset(): void {
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
    this.isSpeaking = false;
    this.energyHistory = [];
  }
  
  // ─── Private Methods ─────────────────────────────────────────────
  
  private toFloat32(samples: Int16Array | Float32Array): Float32Array {
    if (samples instanceof Float32Array) return samples;
    
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32[i] = samples[i] / 32768;  // Normalize int16 to float
    }
    return float32;
  }
  
  /**
   * Calculate RMS energy of audio frame
   * RMS = sqrt(mean(x^2))
   */
  private calculateRMS(samples: Float32Array): number {
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    return Math.sqrt(sumSquares / samples.length);
  }
  
  /**
   * Calculate zero-crossing rate
   * Speech has specific ZCR patterns, useful for differentiating from noise
   */
  private calculateZeroCrossingRate(samples: Float32Array): number {
    let zeroCount = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0 && samples[i - 1] < 0) ||
          (samples[i] < 0 && samples[i - 1] >= 0)) {
        zeroCount++;
      }
    }
    return zeroCount / samples.length;
  }
}

/**
 * Export singleton instance
 */
let vadInstance: SimpleVAD | null = null;

export function getVAD(config?: Partial<VADConfig>): SimpleVAD {
  if (!vadInstance) {
    vadInstance = new SimpleVAD(config);
  }
  return vadInstance;
}

export function resetVAD(): void {
  if (vadInstance) {
    vadInstance.reset();
  }
}
