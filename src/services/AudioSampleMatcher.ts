/**
 * AudioSampleMatcher — Compare incoming audio against training samples
 * 
 * Approach:
 * 1. Load training audio samples from AsyncStorage
 * 2. Record incoming audio
 * 3. Extract audio features (energy envelope, zero-crossing rate)
 * 4. Compare using dynamic time warping
 * 5. Score similarity (0-1)
 * 6. Threshold match if > 0.7
 * 
 * This avoids speech-to-text entirely and compares waveforms directly
 */

export interface AudioFeatures {
  // Energy frame-by-frame (volume envelope)
  energy: number[];
  
  // Zero-crossing rate (how many times signal crosses zero)
  zcr: number[];
  
  // Duration in frames
  duration: number;
}

/**
 * Extract audio features from PCM16 data
 * Processes ~512 samples at a time (32ms at 16kHz)
 */
export function extractAudioFeatures(
  pcm16Data: Int16Array,
  sampleRate: number = 16000,
  frameSize: number = 512
): AudioFeatures {
  const energy: number[] = [];
  const zcr: number[] = [];

  // Process audio in frames
  for (let i = 0; i < pcm16Data.length; i += frameSize) {
    const frame = pcm16Data.slice(i, Math.min(i + frameSize, pcm16Data.length));
    
    // Energy: RMS of frame
    let sum = 0;
    for (let j = 0; j < frame.length; j++) {
      sum += frame[j] * frame[j];
    }
    const rms = Math.sqrt(sum / frame.length);
    energy.push(rms);
    
    // Zero-crossing rate
    let crossings = 0;
    for (let j = 1; j < frame.length; j++) {
      if ((frame[j] >= 0) !== (frame[j - 1] >= 0)) {
        crossings++;
      }
    }
    zcr.push(crossings / frame.length);
  }

  return {
    energy,
    zcr,
    duration: pcm16Data.length,
  };
}

/**
 * Dynamic Time Warping — compare two sequences of different lengths
 * Returns similarity score 0-1 (1 = identical, 0 = completely different)
 */
export function compareAudioFeatures(
  features1: AudioFeatures,
  features2: AudioFeatures,
  energyWeight: number = 0.7,
  zcrWeight: number = 0.3
): number {
  if (features1.energy.length === 0 || features2.energy.length === 0) {
    return 0;
  }

  // Get max energy values for normalization
  const maxEnergy1 = Math.max(...features1.energy);
  const maxEnergy2 = Math.max(...features2.energy);
  const maxEnergy = Math.max(maxEnergy1, maxEnergy2) || 1;

  // Normalize energy values to 0-1 range
  const energy1Normalized = features1.energy.map(e => e / maxEnergy);
  const energy2Normalized = features2.energy.map(e => e / maxEnergy);

  // DTW on normalized energy envelope
  const energyDist = dtw(energy1Normalized, energy2Normalized);
  const maxEnergyDist = Math.max(features1.energy.length, features2.energy.length); // Length-based normalization
  const energyScore = Math.max(0, 1 - energyDist / (maxEnergyDist || 1));

  // DTW on zero-crossing rate (already normalized to 0-1)
  const zcrDist = dtw(features1.zcr, features2.zcr);
  const maxZcrDist = Math.max(features1.zcr.length, features2.zcr.length);
  const zcrScore = Math.max(0, 1 - zcrDist / (maxZcrDist || 1));

  // Weighted combination
  return energyWeight * energyScore + zcrWeight * zcrScore;
}

/**
 * Simplified DTW distance
 * Lower = more similar
 */
function dtw(seq1: number[], seq2: number[]): number {
  const n = seq1.length;
  const m = seq2.length;

  // Create cost matrix
  const cost = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(Infinity));
  cost[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const dist = Math.abs(seq1[i - 1] - seq2[j - 1]);
      cost[i][j] = dist + Math.min(cost[i - 1][j], cost[i][j - 1], cost[i - 1][j - 1]);
    }
  }

  return cost[n][m];
}

/**
 * Match incoming audio against training samples
 * Returns: { matched: boolean, score: number, bestMatch: number }
 */
export async function matchAgainstTraining(
  incomingFeatures: AudioFeatures,
  trainingFeaturesList: AudioFeatures[],
  threshold: number = 0.55
): Promise<{
  matched: boolean;
  score: number;
  bestMatchIndex: number;
}> {
  let bestScore = 0;
  let bestMatchIndex = -1;

  for (let i = 0; i < trainingFeaturesList.length; i++) {
    const score = compareAudioFeatures(incomingFeatures, trainingFeaturesList[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMatchIndex = i;
    }
  }

  return {
    matched: bestScore >= threshold,
    score: bestScore,
    bestMatchIndex,
  };
}

/**
 * v3.1.67: per-companion matching. Each companion can have
 * its own wake word (e.g. "hey clawsuu" for clawsuu, "yo
 * lamasuu" for lamasuu). The wake listener matches against
 * ALL companions' training data and returns the matched
 * companionId so the wake mode can show the right one.
 * Tobe: "we should rather train other wake words for other
 * companions. So, in the settings for wake training the
 * user should select which companion to train for."
 */
export async function matchAgainstAllCompanions(
  incomingFeatures: AudioFeatures,
  companionsTraining: Array<{ companionId: string; features: AudioFeatures[] }>,
  threshold: number = 0.55
): Promise<{
  matched: boolean;
  score: number;
  matchedCompanionId: string | null;
}> {
  let bestScore = 0;
  let bestCompanionId: string | null = null;

  for (const { companionId, features } of companionsTraining) {
    for (const training of features) {
      const score = compareAudioFeatures(incomingFeatures, training);
      if (score > bestScore) {
        bestScore = score;
        bestCompanionId = companionId;
      }
    }
  }

  return {
    matched: bestScore >= threshold,
    score: bestScore,
    matchedCompanionId: bestCompanionId,
  };
}
