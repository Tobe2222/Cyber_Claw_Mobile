/**
 * AudioBuffer — Rolling audio recording service
 * Records audio continuously in chunks, maintains a rolling buffer,
 * and provides lookback capability for the wake word system.
 * 
 * NOTE: File I/O (RNFS) will be integrated when actual audio recording is added.
 * For now this manages in-memory chunk references and settings only.
 */

const CHUNK_DURATION_MS = 30_000; // 30 seconds per chunk
const MAX_CHUNKS_DEFAULT = 120;   // 60 minutes at 30s chunks

export interface AudioChunk {
  path: string;
  startTime: number;  // epoch ms
  duration: number;    // ms
  size: number;        // bytes
}

export interface AudioBufferSettings {
  enabled: boolean;
  lookbackMinutes: number;      // 5, 10, 30, 60
  wakeWord: string;             // "Hey CyberClaw"
  // v3.6.1: removed retentionDays and conversationTimeoutMinutes.
  // Both were write-only — saved to AsyncStorage and surfaced in
  // the UI but never read. Daily recording + log rotation is
  // not implemented; the rolling audio buffer is bounded solely
  // by lookbackMinutes × CHUNK_DURATION_MS below.
}

export const DEFAULT_SETTINGS: AudioBufferSettings = {
  enabled: false,
  lookbackMinutes: 10,
  wakeWord: 'Hey CyberClaw',
};

class AudioBufferService {
  private chunks: AudioChunk[] = [];
  private settings: AudioBufferSettings = DEFAULT_SETTINGS;
  private maxChunks: number = MAX_CHUNKS_DEFAULT;

  async init() {
    // Will create audio directories when RNFS is integrated
  }

  updateSettings(settings: Partial<AudioBufferSettings>) {
    this.settings = { ...this.settings, ...settings };
    this.maxChunks = Math.ceil((this.settings.lookbackMinutes * 60_000) / CHUNK_DURATION_MS);
  }

  getSettings(): AudioBufferSettings {
    return { ...this.settings };
  }

  /**
   * Add a recorded chunk to the buffer
   * Called by the native recording module
   */
  async addChunk(path: string, startTime: number, duration: number, size: number = 0): Promise<void> {
    this.chunks.push({ path, startTime, duration, size });

    // Remove old chunks beyond lookback window
    while (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
      // TODO: delete file via RNFS when integrated
    }
  }

  /**
   * Get audio chunks from the last N minutes
   */
  getChunksForLookback(minutes: number): AudioChunk[] {
    const cutoff = Date.now() - minutes * 60_000;
    return this.chunks.filter(c => c.startTime >= cutoff);
  }

  /**
   * Get all chunk paths for the last N minutes (for sending to STT)
   */
  getPathsForLookback(minutes: number): string[] {
    return this.getChunksForLookback(minutes).map(c => c.path);
  }

  /**
   * Clear all buffered audio references
   */
  async clear(): Promise<void> {
    // TODO: delete files via RNFS when integrated
    this.chunks = [];
  }

  /**
   * Get buffer stats
   */
  getStats() {
    const totalSize = this.chunks.reduce((acc, c) => acc + c.size, 0);
    const totalDuration = this.chunks.reduce((acc, c) => acc + c.duration, 0);
    return {
      chunks: this.chunks.length,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(1),
      totalDurationMinutes: (totalDuration / 60_000).toFixed(1),
      oldestChunk: this.chunks[0]?.startTime || null,
      newestChunk: this.chunks[this.chunks.length - 1]?.startTime || null,
    };
  }
}

export const audioBuffer = new AudioBufferService();
export default audioBuffer;
