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
          samples: parsed.features.map((f: AudioFeatures) => ({
            style: 'normal' as WakeSampleStyle,
            features: f,
            duration: f.duration ?? 1.0,
            quality: parsed.overallQuality ?? 0.8,
            date: parsed.trainedAt ?? new Date().toISOString(),
          })),
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
        samples: parsed.features.map((f: AudioFeatures) => ({
          style: 'normal' as WakeSampleStyle,
          features: f,
          duration: f.duration ?? 1.0,
          quality: parsed.overallQuality ?? 0.8,
          date: parsed.trainedAt ?? new Date().toISOString(),
        })),
      });
      await saveWakeTraining(match.id, existing);
      // Remove the legacy key so future runs don't re-migrate.
      await AsyncStorage.removeItem(key);
    } catch {
      // skip broken entries
    }
  }
}