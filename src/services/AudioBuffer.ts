/**
 * AudioBuffer — Rolling audio recording service
 * Records audio continuously in chunks, maintains a rolling buffer,
 * and provides lookback capability for the wake word system.
 * 
 * Architecture:
 *   - Records in 30-second chunks
 *   - Maintains rolling buffer (configurable: 5-60 minutes)
 *   - Old chunks auto-deleted beyond retention period
 *   - Daily transcription files stored for X days (user setting)
 *   - All local, nothing leaves the device unless user requests
 */

import RNFS from 'react-native-fs';

const AUDIO_DIR = `${RNFS.DocumentDirectoryPath}/cyberclaw-audio`;
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
  retentionDays: number;        // 1-30, how long to keep daily recordings
  conversationTimeoutMinutes: number;  // 1, 2, 5 — silence before stopping active listening
  wakeWord: string;             // "Hey CyberClaw"
}

export const DEFAULT_SETTINGS: AudioBufferSettings = {
  enabled: false,
  lookbackMinutes: 10,
  retentionDays: 7,
  conversationTimeoutMinutes: 2,
  wakeWord: 'Hey CyberClaw',
};

class AudioBufferService {
  private chunks: AudioChunk[] = [];
  private recording: boolean = false;
  private settings: AudioBufferSettings = DEFAULT_SETTINGS;
  private maxChunks: number = MAX_CHUNKS_DEFAULT;

  async init() {
    // Ensure audio directory exists
    const exists = await RNFS.exists(AUDIO_DIR);
    if (!exists) {
      await RNFS.mkdir(AUDIO_DIR);
    }
    // Clean old daily recordings
    await this.cleanOldRecordings();
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
  async addChunk(path: string, startTime: number, duration: number): Promise<void> {
    const stat = await RNFS.stat(path);
    this.chunks.push({
      path,
      startTime,
      duration,
      size: parseInt(stat.size || '0', 10),
    });

    // Remove old chunks beyond lookback window
    while (this.chunks.length > this.maxChunks) {
      const old = this.chunks.shift();
      if (old) {
        try { await RNFS.unlink(old.path); } catch {}
      }
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
   * Save current buffer as daily recording
   */
  async saveDailySnapshot(): Promise<string | null> {
    if (this.chunks.length === 0) return null;

    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyDir = `${AUDIO_DIR}/daily/${date}`;
    const exists = await RNFS.exists(dailyDir);
    if (!exists) {
      await RNFS.mkdir(dailyDir);
    }

    // Copy current chunks to daily dir
    for (const chunk of this.chunks) {
      const filename = `chunk_${chunk.startTime}.wav`;
      const dest = `${dailyDir}/${filename}`;
      try {
        await RNFS.copyFile(chunk.path, dest);
      } catch {}
    }

    return dailyDir;
  }

  /**
   * Clean daily recordings older than retention period
   */
  async cleanOldRecordings(): Promise<void> {
    const dailyDir = `${AUDIO_DIR}/daily`;
    const exists = await RNFS.exists(dailyDir);
    if (!exists) return;

    const items = await RNFS.readDir(dailyDir);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.settings.retentionDays);
    const cutoff = cutoffDate.toISOString().split('T')[0];

    for (const item of items) {
      if (item.isDirectory() && item.name < cutoff) {
        try { await RNFS.unlink(item.path); } catch {}
      }
    }
  }

  /**
   * Clear all buffered audio
   */
  async clear(): Promise<void> {
    for (const chunk of this.chunks) {
      try { await RNFS.unlink(chunk.path); } catch {}
    }
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
