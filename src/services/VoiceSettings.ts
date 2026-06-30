/**
 * VOICE SETTINGS — v3.2.20
 *
 * AsyncStorage-backed settings for the multi-turn voice-mode loop.
 *
 * Keys:
 *   - cyberclaw-voice-silence-ms      Number (2000..10000), continuous
 *                                     silence in ms that closes a
 *                                     recording turn. Default 5000.
 *   - cyberclaw-voice-exit-phrase     String, the user's exit phrase
 *                                     (single phrase, default
 *                                     "thanks"). Matched against the
 *                                     transcription with fuzzy
 *                                     substring (ExitPhraseMatcher).
 *                                     Empty string disables the
 *                                     feature.
 *   - cyberclaw-exit-samples-<phrase>  Per-phrase training samples,
 *                                     stored as JSON AudioFeatures.
 *
 * Voice mode reads these fresh on every recording start so that a
 * Settings change takes effect immediately for the next turn (no
 * mode restart needed).
 *
 * v3.2.20 simplification: dropped the multi-phrase list (8 max)
 * and the preset toggles. Single phrase only. The user can also
 * train the phrase with 6 audio samples (see ExitPhraseTrainer),
 * which enables the in-audio-stream detector that closes voice
 * mode the moment the user says the phrase (no STT wait).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SILENCE_MS_KEY = 'cyberclaw-voice-silence-ms';
export const EXIT_PHRASE_KEY = 'cyberclaw-voice-exit-phrase';

export const DEFAULT_SILENCE_MS = 5000;
export const MIN_SILENCE_MS = 2000;
export const MAX_SILENCE_MS = 10000;

export const DEFAULT_EXIT_PHRASE = 'thanks';
export const MAX_PHRASE_WORDS = 4;
export const MAX_PHRASE_LENGTH = 40;

export const getExitSamplesKey = (phrase: string) =>
  `cyberclaw-exit-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

export type VoiceSettings = {
  silenceMs: number;
  exitPhrase: string;
};

/**
 * Read settings fresh from storage. Returns defaults if either
 * key is missing or corrupt. silenceMs is clamped to
 * [MIN_SILENCE_MS, MAX_SILENCE_MS] so a bad stored value (e.g.
 * from an older build) can never break the recording loop.
 */
export async function loadVoiceSettings(): Promise<VoiceSettings> {
  let silenceMs = DEFAULT_SILENCE_MS;
  let exitPhrase = DEFAULT_EXIT_PHRASE;
  try {
    const rawSilence = await AsyncStorage.getItem(SILENCE_MS_KEY);
    if (rawSilence !== null) {
      const parsed = parseInt(rawSilence, 10);
      if (!isNaN(parsed)) {
        silenceMs = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, parsed));
      }
    }
  } catch (_) {}
  try {
    const rawPhrase = await AsyncStorage.getItem(EXIT_PHRASE_KEY);
    if (rawPhrase !== null) {
      exitPhrase = rawPhrase.trim().toLowerCase();
    }
  } catch (_) {}
  return { silenceMs, exitPhrase };
}

export async function saveSilenceMs(ms: number): Promise<void> {
  const clamped = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, Math.round(ms)));
  await AsyncStorage.setItem(SILENCE_MS_KEY, String(clamped));
}

export async function saveExitPhrase(phrase: string): Promise<string> {
  const sanitized = phrase.trim().toLowerCase().slice(0, MAX_PHRASE_LENGTH);
  const wordCount = sanitized.split(/\s+/).filter(Boolean).length;
  const finalPhrase = wordCount <= MAX_PHRASE_WORDS ? sanitized : '';
  await AsyncStorage.setItem(EXIT_PHRASE_KEY, finalPhrase);
  return finalPhrase;
}

/**
 * Read the per-phrase training samples (audio features). Returns
 * null if no training exists for the given phrase. Used by the
 * voice-mode detector to match against the live audio stream.
 */
export async function loadExitSamples(phrase: string): Promise<any[] | null> {
  try {
    const raw = await AsyncStorage.getItem(getExitSamplesKey(phrase));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.features?.length) return parsed.features;
    return null;
  } catch (_) {
    return null;
  }
}

export async function saveExitSamples(phrase: string, features: any[]): Promise<void> {
  await AsyncStorage.setItem(
    getExitSamplesKey(phrase),
    JSON.stringify({ phrase, features, savedAt: Date.now() }),
  );
}

export async function clearExitSamples(phrase: string): Promise<void> {
  await AsyncStorage.removeItem(getExitSamplesKey(phrase));
}