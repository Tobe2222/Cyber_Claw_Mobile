/**
 * VOICE SETTINGS — v3.2.17
 *
 * AsyncStorage-backed settings for the multi-turn voice-mode loop.
 *
 * Keys:
 *   - cyberclaw-voice-silence-ms      Number (2000..10000), continuous
 *                                     silence in ms that closes a
 *                                     recording turn. Default 5000.
 *   - cyberclaw-voice-exit-phrases    JSON string[] of normalized
 *                                     lowercase phrases, e.g.
 *                                     ["thanks","goodbye","stop",
 *                                      "that's all"]. Empty array
 *                                     means the feature is disabled.
 *
 * Voice mode reads these fresh on every recording start so that a
 * Settings change takes effect immediately for the next turn (no
 * mode restart needed).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SILENCE_MS_KEY = 'cyberclaw-voice-silence-ms';
export const EXIT_PHRASES_KEY = 'cyberclaw-voice-exit-phrases';

export const DEFAULT_SILENCE_MS = 5000;
export const MIN_SILENCE_MS = 2000;
export const MAX_SILENCE_MS = 10000;

// Max phrases the user can keep enabled. 8 keeps the UI
// manageable (4 preset + 4 custom). Custom phrases are
// validated to be 1-4 words so fuzzy-match stays fast.
export const MAX_EXIT_PHRASES = 8;
export const MAX_PHRASE_WORDS = 4;

// Preset phrases the SettingsScreen offers as a starting
// point. Keep these lowercase + trimmed. Phrases are matched
// against the transcribed text using word-substring
// (ExitPhraseMatcher), not strict equals, so plurals like
// "thanks!" and "thanks." all match.
export const PRESET_EXIT_PHRASES: readonly string[] = [
  'thanks',
  'thank you',
  'goodbye',
  'stop',
  "that's all",
  'never mind',
];

export type VoiceSettings = {
  silenceMs: number;
  exitPhrases: string[];
};

/**
 * Read both settings fresh from storage. Returns sensible
 * defaults if either key is missing or corrupt. The returned
 * silenceMs is clamped to [MIN_SILENCE_MS, MAX_SILENCE_MS]
 * so a bad stored value (e.g. from an older build) can never
 * break the recording loop.
 */
export async function loadVoiceSettings(): Promise<VoiceSettings> {
  let silenceMs = DEFAULT_SILENCE_MS;
  let exitPhrases: string[] = [];
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
    const rawPhrases = await AsyncStorage.getItem(EXIT_PHRASES_KEY);
    if (rawPhrases !== null && rawPhrases !== '') {
      const parsed = JSON.parse(rawPhrases);
      if (Array.isArray(parsed)) {
        exitPhrases = parsed
          .filter((p: any) => typeof p === 'string')
          .map((p: string) => p.trim().toLowerCase())
          .filter((p: string) => p.length > 0 && p.length <= 40)
          .slice(0, MAX_EXIT_PHRASES);
      }
    }
  } catch (_) {}
  return { silenceMs, exitPhrases };
}

export async function saveSilenceMs(ms: number): Promise<void> {
  const clamped = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, Math.round(ms)));
  await AsyncStorage.setItem(SILENCE_MS_KEY, String(clamped));
}

export async function saveExitPhrases(phrases: string[]): Promise<void> {
  const sanitized = phrases
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0 && p.length <= 40 && p.split(/\s+/).length <= MAX_PHRASE_WORDS)
    .slice(0, MAX_EXIT_PHRASES);
  await AsyncStorage.setItem(EXIT_PHRASES_KEY, JSON.stringify(sanitized));
}
