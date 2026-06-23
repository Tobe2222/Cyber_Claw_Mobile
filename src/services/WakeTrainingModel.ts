// v3.1.77: shared types and storage helpers for the wake-word
// training model. Replaces the v3.1.67 trainer's flat data
// shape with a per-companion entry that supports multiple
// wake phrases and style-tagged samples.
//
// Storage: one entry per companion under
// `cyberclaw-wake-samples-<companionId>`. The entry contains
// a `phrases` array (each phrase has style-tagged samples)
// plus a top-level `features` array that's the flattened sum
// across all phrases and styles. The matcher in HomeScreen /
// WakeWordTester reads `features` directly without caring
// about phrase or style structure.
//
// Pre-v3.1.77 the trainer wrote one entry per companion with
// a single phrase and flat features, while the menu / tester
// / matcher used per-phrase keys. The two key shapes didn't
// share data, so samples trained after v3.1.67 didn't appear
// in the menu. v3.1.77 consolidates everything under the
// per-companion key.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AudioFeatures } from './AudioSampleMatcher';

export type WakeSampleStyle = 'normal' | 'loud' | 'whisper' | 'short' | 'elongated';

// The canonical set of styles. Tobe: "1 of each mandatory,
// up to 3 of each optional" — these limits are enforced by
// the trainer UI.
export const WAKE_SAMPLE_STYLES: WakeSampleStyle[] = [
  'normal',
  'loud',
  'whisper',
  'short',
  'elongated',
];

export const WAKE_SAMPLE_STYLE_LABELS: Record<WakeSampleStyle, string> = {
  normal: '🗣️ Normal',
  loud: '📢 Loud',
  whisper: '🤫 Whisper',
  short: '⚡ Short',
  elongated: '🐢 Elongated',
};

export const WAKE_STYLE_MIN = 1;
export const WAKE_STYLE_MAX = 3;

export interface WakeSample {
  style: WakeSampleStyle;
  features: AudioFeatures;
  duration: number;
  quality: number;
  date: string;
}

export interface WakePhrase {
  phrase: string;
  samples: WakeSample[];
}

export interface WakeTrainingEntry {
  features: AudioFeatures[];
  phrases: WakePhrase[];
  trainedAt: string;
}

export const getWakeTrainingKey = (companionId: string) =>
  `cyberclaw-wake-samples-${companionId}`;

// Recompute the flattened `features` array. Called on every
// save so the matcher's view stays in sync with the
// structured view.
export function flattenFeatures(entry: WakeTrainingEntry): AudioFeatures[] {
  const out: AudioFeatures[] = [];
  for (const p of entry.phrases) {
    for (const s of p.samples) out.push(s.features);
  }
  return out;
}

export async function loadWakeTraining(companionId: string): Promise<WakeTrainingEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(getWakeTrainingKey(companionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed) return null;
    // v3.1.77: accept both the new shape (phrases[]) and the
    // v3.1.67 shape (flat features + phrase string). If we
    // see the old shape, upgrade it to the new one in memory
    // and persist on next save.
    if (Array.isArray(parsed.phrases)) {
      return parsed as WakeTrainingEntry;
    }
    if (Array.isArray(parsed.features) && parsed.features.length > 0) {
      return {
        features: parsed.features,
        phrases: [{
          phrase: parsed.phrase || `hey ${companionId}`,
          samples: parsed.features.map((f: AudioFeatures) => {
            // v3.1.78: AudioFeatures.duration is the PCM sample
            // count (set by extractAudioFeatures), NOT seconds.
            // Pre-v3.1.77 the trainer wrote f.duration straight
            // into the WakeSample.duration slot, producing
            // "3934.0s" / "3921.0s" / "3959.0s" on the Normal
            // samples (i.e. ~65 min of audio that doesn't
            // exist). Divide by 16kHz to get seconds. Default
            // 1.0s if the field is missing.
            const durSamples = f.duration ?? 16000;
            return {
              style: 'normal' as WakeSampleStyle,
              features: f,
              duration: durSamples / 16000,
              quality: parsed.overallQuality ?? 0.8,
              date: parsed.trainedAt ?? new Date().toISOString(),
            };
          }),
        }],
        trainedAt: parsed.trainedAt ?? new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveWakeTraining(companionId: string, entry: WakeTrainingEntry): Promise<void> {
  entry.features = flattenFeatures(entry);
  entry.trainedAt = new Date().toISOString();
  await AsyncStorage.setItem(getWakeTrainingKey(companionId), JSON.stringify(entry));
}

// Add a new sample to a phrase (creating the phrase if missing)
// and persist.
export async function addWakeSample(
  companionId: string,
  phrase: string,
  sample: WakeSample,
): Promise<WakeTrainingEntry> {
  const existing = (await loadWakeTraining(companionId)) ?? {
    features: [],
    phrases: [],
    trainedAt: new Date().toISOString(),
  };
  const normPhrase = phrase.toLowerCase().trim();
  let phraseEntry = existing.phrases.find(p => p.phrase.toLowerCase().trim() === normPhrase);
  if (!phraseEntry) {
    phraseEntry = { phrase, samples: [] };
    existing.phrases.push(phraseEntry);
  }
  phraseEntry.samples.push(sample);
  await saveWakeTraining(companionId, existing);
  return existing;
}

export function countByStyle(samples: WakeSample[]): Record<WakeSampleStyle, number> {
  const counts: Record<WakeSampleStyle, number> = {
    normal: 0, loud: 0, whisper: 0, short: 0, elongated: 0,
  };
  for (const s of samples) counts[s.style]++;
  return counts;
}

// ── Migration: pre-v3.1.77 per-phrase keys ─────────────────────────────
// The v3.1.67 trainer wrote to per-companion keys; the menu /
// tester read from per-phrase keys. On first run, copy any
// per-phrase data into the matching companion's training entry
// (treating it as the "normal" style). Skips companions that
// already have new-shape data to avoid clobbering it.
export async function migrateLegacyPhraseKeys(
  availableCompanions: Array<{ id: string; name: string }>,
): Promise<void> {
  let keys: string[] = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return;
  }
  const phraseKeys = keys.filter(k => k.startsWith('cyberclaw-wake-samples-'));
  for (const key of phraseKeys) {
    const suffix = key.replace('cyberclaw-wake-samples-', '');
    // Skip the single-key format (already handled) and
    // per-companion keys whose suffix IS a companionId.
    if (availableCompanions.some(c => c.id === suffix)) continue;
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed?.features?.length) continue;
      const phrase = parsed.phrase ?? suffix.replace(/-/g, ' ');
      const lower = (phrase + ' ' + suffix).toLowerCase();
      const match = availableCompanions.find(c =>
        lower.includes(c.id.toLowerCase()) || lower.includes(c.name.toLowerCase()),
      );
      if (!match) continue;
      const existing = (await loadWakeTraining(match.id)) ?? {
        features: [],
        phrases: [],
        trainedAt: new Date().toISOString(),
      };
      // Don't clobber existing data
      if (existing.phrases.length > 0) continue;
      existing.phrases.push({
        phrase,
        samples: parsed.features.map((f: AudioFeatures) => {
          // v3.1.78: same duration fix as the v3.1.67 migration
          // — AudioFeatures.duration is the PCM sample count,
          // not seconds. Divide by 16000 to get seconds.
          const durSamples = f.duration ?? 16000;
          return {
            style: 'normal' as WakeSampleStyle,
            features: f,
            duration: durSamples / 16000,
            quality: parsed.overallQuality ?? 0.8,
            date: parsed.trainedAt ?? new Date().toISOString(),
          };
        }),
      });
      await saveWakeTraining(match.id, existing);
      // Remove the legacy key so future runs don't re-migrate.
      await AsyncStorage.removeItem(key);
    } catch {
      // skip broken entries
    }
  }
}

// ── v3.1.79: Auto-retrain for normal samples ────────────────────────────
//
// Tobe: "I did not see a retrain button for normal samples.
// That should automatically use better samples which is
// retrained to replace worse samples."
//
// The idea: when the user records a new normal sample and we
// already have 3 normal samples for a phrase, check whether
// the new sample is more consistent with the others than one
// of the existing ones. If so, silently replace the worst
// existing sample with the new one. The user sees a small
// toast/hint instead of a manual retrain flow.
//
// "More consistent" = higher average DTW similarity to the
// other samples. We don't need a full retrain pipeline — the
// comparison is O(N) DTW calls, fine on-device.
//
// Returns: { replaced: boolean, replacedIndex: number | null,
//            oldQuality: number | null, newQuality: number }
// If `replaced` is false, the caller should just append the
// new sample as normal. If true, the caller should NOT append
// (the new sample has already replaced the old one in storage).
export interface AutoRetrainResult {
  replaced: boolean;
  replacedIndex: number | null;
  oldQuality: number | null;
  newQuality: number;
}

import { compareAudioFeatures } from './AudioSampleMatcher';

export async function autoRetrainNormal(
  companionId: string,
  phrase: string,
  newSample: WakeSample,
  newQuality: number,
): Promise<AutoRetrainResult> {
  // Only auto-retrain NORMAL samples. Loud / whisper / short /
  // elongated have intentional acoustic differences; replacing
  // them based on similarity would erase the diversity the user
  // explicitly trained. Normal samples should all sound
  // similar, so picking the most-similar-to-others is correct.
  if (newSample.style !== 'normal') {
    return { replaced: false, replacedIndex: null, oldQuality: null, newQuality };
  }

  const entry = await loadWakeTraining(companionId);
  if (!entry) return { replaced: false, replacedIndex: null, oldQuality: null, newQuality };

  const phraseEntry = entry.phrases.find(p => p.phrase.toLowerCase() === phrase.toLowerCase());
  if (!phraseEntry) return { replaced: false, replacedIndex: null, oldQuality: null, newQuality };

  // Only auto-retrain when we already have WAKE_STYLE_MAX (=3)
  // normal samples for this phrase. If we have fewer, just
  // append the new one (the normal flow).
  const normalSamples = phraseEntry.samples.filter(s => s.style === 'normal');
  if (normalSamples.length < WAKE_STYLE_MAX) {
    return { replaced: false, replacedIndex: null, oldQuality: null, newQuality };
  }

  // Score each existing normal sample by its average DTW
  // similarity to the other normal samples. The sample with
  // the lowest avg score is the "worst" — least consistent
  // with the rest of the training set.
  const scores: number[] = normalSamples.map(s => {
    const others = normalSamples.filter(x => x !== s);
    const sims = others.map(o => compareAudioFeatures(s.features, o.features));
    return sims.reduce((a, b) => a + b, 0) / sims.length;
  });
  let worstIdx = 0;
  let worstScore = scores[0];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < worstScore) {
      worstScore = scores[i];
      worstIdx = i;
    }
  }

  // Only replace if the new sample is meaningfully better than
  // the worst existing one. Threshold 0.05: anything tighter
  // causes noisy flicker; anything looser replaces too eagerly.
  if (newQuality <= worstScore + 0.05) {
    return {
      replaced: false,
      replacedIndex: null,
      oldQuality: worstScore,
      newQuality,
    };
  }

  // Find the absolute index in phraseEntry.samples (not the
  // filtered normalSamples list) so the splice removes the
  // right element.
  const worstSample = normalSamples[worstIdx];
  const absoluteIdx = phraseEntry.samples.findIndex(s => s === worstSample);
  if (absoluteIdx === -1) {
    return { replaced: false, replacedIndex: null, oldQuality: null, newQuality };
  }

  phraseEntry.samples.splice(absoluteIdx, 1, newSample);
  await saveWakeTraining(companionId, entry);

  return {
    replaced: true,
    replacedIndex: absoluteIdx,
    oldQuality: worstScore,
    newQuality,
  };
}

// ── v3.1.79: False-open detection ───────────────────────────────────────
//
// Tobe: "the recording starts getting long. Perhaps we
// should set a maximum or a smart feature to detect false
// opens."
//
// A "false open" is a wake event that fires but the user
// wasn't actually addressing the device — typically a TV
// or another person said something wake-word-like, or the
// matcher hit a false positive. We can't perfectly detect
// these, but two signals are strong:
//   1. The user exits Wake Mode within 3s of opening it
//      (no recording happened — they didn't actually need
//      to talk to the companion).
//   2. Wake Mode times out idle for > 60s (the user
//      probably triggered this by accident and walked away).
//
// When 3 false opens accumulate within 5 minutes, raise the
// match threshold by 0.05 (auto-tighten). Reset the counter
// after 5 minutes of clean operation. Threshold is capped at
// 0.85 — beyond that, legitimate wake words get rejected.

const FALSE_OPEN_WINDOW_MS = 5 * 60 * 1000;
const FALSE_OPEN_THRESHOLD = 3;
const FALSE_OPEN_EXIT_MS = 3000;
const FALSE_OPEN_IDLE_MS = 60 * 1000;
const FALSE_OPEN_INCREMENT = 0.05;
const FALSE_OPEN_CAP = 0.85;

interface FalseOpenState {
  timestamps: number[];
  threshold: number;
  lastIncrement: number;
}

function emptyFalseOpenState(): FalseOpenState {
  return { timestamps: [], threshold: 0, lastIncrement: 0 };
}

function getFalseOpenStorageKey(): string {
  return 'cyberclaw-false-open-state';
}

async function readFalseOpenState(): Promise<FalseOpenState> {
  try {
    const raw = await AsyncStorage.getItem(getFalseOpenStorageKey());
    if (!raw) return emptyFalseOpenState();
    const parsed = JSON.parse(raw);
    return {
      timestamps: Array.isArray(parsed?.timestamps) ? parsed.timestamps : [],
      threshold: typeof parsed?.threshold === 'number' ? parsed.threshold : 0,
      lastIncrement: typeof parsed?.lastIncrement === 'number' ? parsed.lastIncrement : 0,
    };
  } catch {
    return emptyFalseOpenState();
  }
}

async function writeFalseOpenState(state: FalseOpenState): Promise<void> {
  try {
    await AsyncStorage.setItem(getFalseOpenStorageKey(), JSON.stringify(state));
  } catch {
    // best-effort
  }
}

// Call this on entering Wake / Voice Mode. Returns the
// current auto-tightened threshold (add to the user-configured
// base threshold).
export async function noteWakeModeOpen(): Promise<number> {
  const state = await readFalseOpenState();
  return state.threshold;
}

// Call this on exiting Wake / Voice Mode. If the mode was
// open for less than FALSE_OPEN_EXIT_MS (no real recording
// happened), count it as a false open. Returns the new
// auto-incremented threshold if the count hit the limit,
// or 0 if no change.
export async function noteWakeModeExit(
  mode: 'wake' | 'voice',
  openDurationMs: number,
  hadRecording: boolean,
): Promise<{ newThreshold: number; falseOpenRecorded: boolean }> {
  const state = await readFalseOpenState();
  const now = Date.now();
  // Drop timestamps outside the rolling 5-minute window
  state.timestamps = state.timestamps.filter(t => now - t < FALSE_OPEN_WINDOW_MS);

  let falseOpenRecorded = false;
  // False open: short open, no recording happened
  if (!hadRecording && openDurationMs < FALSE_OPEN_EXIT_MS) {
    state.timestamps.push(now);
    falseOpenRecorded = true;
  }
  // False open: idle for too long (mode still open, no input)
  // This is detected by the idle-timeout caller, not here.
  if (!hadRecording && openDurationMs > FALSE_OPEN_IDLE_MS) {
    state.timestamps.push(now);
    falseOpenRecorded = true;
  }

  // Reset threshold if the last increment was > 5 min ago
  // and we have no recent false opens. This lets the user
  // recover after tightening if their environment changed.
  if (state.timestamps.length === 0 && now - state.lastIncrement > FALSE_OPEN_WINDOW_MS) {
    state.threshold = 0;
  }

  if (state.timestamps.length >= FALSE_OPEN_THRESHOLD) {
    state.threshold = Math.min(FALSE_OPEN_CAP, state.threshold + FALSE_OPEN_INCREMENT);
    state.lastIncrement = now;
    state.timestamps = []; // reset window after applying
  }

  await writeFalseOpenState(state);
  return { newThreshold: state.threshold, falseOpenRecorded };
}