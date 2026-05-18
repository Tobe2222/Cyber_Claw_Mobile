/**
 * AudioUtils — Convert between audio formats
 * 
 * Handles:
 * - Base64 ↔ binary conversion
 * - PCM16 array creation
 * - WAV file parsing
 */

/**
 * Convert base64 string to Int16Array (PCM16 audio)
 */
export function base64ToInt16Array(base64: string): Int16Array {
  try {
    // Remove any whitespace
    base64 = base64.trim();
    
    // Decode base64 to binary string
    const binaryString = atob(base64);
    
    // Convert to Uint8Array
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // If it's a WAV file, skip the header (44 bytes)
    let dataStart = 0;
    if (bytes.length > 12) {
      const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
      if (riff === 'RIFF') {
        // It's a WAV file, find the 'data' chunk
        dataStart = 44; // Standard WAV header
      }
    }
    
    // Convert bytes to Int16Array (2 bytes per sample)
    const audioData = new Int16Array(bytes.buffer, dataStart);
    return audioData;
  } catch (e) {
    console.error('Error converting audio:', e);
    return new Int16Array(0);
  }
}

/**
 * Convert Int16Array to base64 string
 */
export function int16ArrayToBase64(audioData: Int16Array): string {
  try {
    const bytes = new Uint8Array(audioData.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (e) {
    console.error('Error encoding audio:', e);
    return '';
  }
}

/**
 * Get duration of audio in seconds
 */
export function getAudioDuration(pcm16: Int16Array, sampleRate: number = 16000): number {
  return pcm16.length / sampleRate;
}

/**
 * Normalize audio data to -1.0 to 1.0 range
 */
export function normalizeAudio(pcm16: Int16Array): Float32Array {
  const normalized = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    normalized[i] = pcm16[i] / 32768; // int16 max value
  }
  return normalized;
}

/**
 * Simple audio validation - check if audio has content
 */
export function validateAudio(pcm16: Int16Array, minDuration: number = 0.3): {
  valid: boolean;
  reason?: string;
} {
  const sampleRate = 16000;
  const duration = pcm16.length / sampleRate;

  if (duration < minDuration) {
    return {
      valid: false,
      reason: `Too short: ${duration.toFixed(2)}s (need >${minDuration}s)`,
    };
  }

  // Check for non-zero data
  let nonZero = 0;
  for (let i = 0; i < pcm16.length; i++) {
    if (Math.abs(pcm16[i]) > 100) {
      nonZero++;
    }
  }

  if (nonZero < pcm16.length * 0.1) {
    return {
      valid: false,
      reason: `Audio is too quiet or silent`,
    };
  }

  return { valid: true };
}
