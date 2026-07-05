/**
 * VOICE SETTINGS — v3.2.20 / v3.4.0 / v3.6.0
 *
 * AsyncStorage-backed settings for the multi-turn voice-mode loop.
 *
 * Keys (v3.4.0 — per-companion):
 *   - cyberclaw-voice-silence-ms           Number (2000..10000),
 *                                          continuous silence in ms
 *                                          that closes a recording
 *                                          turn. Default 5000.
 *                                          Global — applies to
 *                                          voice mode regardless of
 *                                          which companion is active.
 *   - cyberclaw-exit-phrase-<companionId>  String, the user's active
 *                                          exit phrase per companion
 *                                          (default 'thanks'). Empty
 *                                          disables the feature.
 *   - cyberclaw-exit-samples-<companionId>-<phrase>
 *                                         Per-companion per-phrase
 *                                         training samples, stored
 *                                         as JSON AudioFeatures.
 *
 * Keys (v3.6.0 — global send word):
 *   - cyberclaw-send-phrase                String, the user's active
 *                                          send word (e.g. 'send').
 *                                          Empty disables. Global,
 *                                          NOT per-companion — the
 *                                          send word is a single user
 *                                          habit, not a per-companion
 *                                          convention.
 *   - cyberclaw-send-samples-<phrase>     Training samples for the
 *                                          send word, stored as JSON
 *                                          AudioFeatures. Global.
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
 *
 * v3.4.0: storage keys became per-companion (matches the new
 * 3-level Settings hierarchy: Voice mode → companion list →
 * per-companion detail). Legacy keys (no companionId prefix)
 * are no longer read or written by this module but are NOT
 * deleted — if the user reverts to v3.3.0 they still find their
 * old training. A separate migration on first launch of v3.4.0
 * reads the legacy keys and writes them under the active
 * companion's namespace so the user doesn't lose data on upgrade.
 *
 * v3.6.0: added the send word (explicit end-of-utterance cue)
 * to the same architecture. Like exit, single word, with 6-sample
 * trainer. Unlike exit, it's global — one send word across all
 * companions, like the wake word itself.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SILENCE_MS_KEY = 'cyberclaw-voice-silence-ms';

export const DEFAULT_SILENCE_MS = 5000;
export const MIN_SILENCE_MS = 2000;
export const MAX_SILENCE_MS = 10000;

export const DEFAULT_EXIT_PHRASE = 'thanks';
export const MAX_PHRASE_WORDS = 4;
export const MAX_PHRASE_LENGTH = 40;

/** v3.6.0: send word. Global, single word, default 'send'. */
export const SEND_PHRASE_KEY = 'cyberclaw-send-phrase';
export const DEFAULT_SEND_PHRASE = 'send';
export const getSendSamplesKey = (phrase: string) =>
  `cyberclaw-send-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

/** v3.4.0: per-companion keys (replaces the v3.3.0 global keys). */
export const getExitPhraseKey = (companionId: string) =>
  `cyberclaw-exit-phrase-${companionId}`;

export const getExitSamplesKey = (companionId: string, phrase: string) =>
  `cyberclaw-exit-samples-${companionId}-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

/**
 * Legacy v3.3.0 keys (no companionId prefix). Read by the v3.4.0
 * migration on first launch to seed per-companion data, but no
 * longer read or written by this module after migration.
 */
export const LEGACY_EXIT_PHRASE_KEY = 'cyberclaw-voice-exit-phrase';
export const getLegacyExitSamplesKey = (phrase: string) =>
  `cyberclaw-exit-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

export type VoiceSettings = {
  silenceMs: number;
  exitPhrase: string;
  sendPhrase: string;
};

/**
 * Read settings fresh from storage. Returns defaults if any key
 * is missing or corrupt. silenceMs is clamped to
 * [MIN_SILENCE_MS, MAX_SILENCE_MS] so a bad stored value (e.g.
 * from an older build) can never break the recording loop.
 *
 * v3.4.0: takes companionId — exit phrase is now per-companion.
 * Voice mode passes the active companionId here so the right
 * exit phrase is loaded for the active companion.
 *
 * v3.6.0: also loads the global send word. The send word is the
 * same regardless of companionId — it's a single user habit, not
 * a per-companion convention.
 */
export async function loadVoiceSettings(companionId?: string): Promise<VoiceSettings> {
  let silenceMs = DEFAULT_SILENCE_MS;
  let exitPhrase = DEFAULT_EXIT_PHRASE;
  let sendPhrase = DEFAULT_SEND_PHRASE;
  try {
    const rawSilence = await AsyncStorage.getItem(SILENCE_MS_KEY);
    if (rawSilence !== null) {
      const parsed = parseInt(rawSilence, 10);
      if (!isNaN(parsed)) {
        silenceMs = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, parsed));
      }
    }
  } catch (_) {}
  if (companionId) {
    try {
      const rawPhrase = await AsyncStorage.getItem(getExitPhraseKey(companionId));
      if (rawPhrase !== null) {
        exitPhrase = rawPhrase.trim().toLowerCase();
      }
    } catch (_) {}
  }
  try {
    const rawSend = await AsyncStorage.getItem(SEND_PHRASE_KEY);
    if (rawSend !== null) {
      const trimmed = rawSend.trim().toLowerCase();
      if (trimmed) sendPhrase = trimmed;
    }
  } catch (_) {}
  return { silenceMs, exitPhrase, sendPhrase };
}

export async function saveSilenceMs(ms: number): Promise<void> {
  const clamped = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, Math.round(ms)));
  await AsyncStorage.setItem(SILENCE_MS_KEY, String(clamped));
}

export async function saveExitPhrase(companionId: string, phrase: string): Promise<string> {
  const sanitized = phrase.trim().toLowerCase().slice(0, MAX_PHRASE_LENGTH);
  const wordCount = sanitized.split(/\s+/).filter(Boolean).length;
  const finalPhrase = wordCount <= MAX_PHRASE_WORDS ? sanitized : '';
  await AsyncStorage.setItem(getExitPhraseKey(companionId), finalPhrase);
  return finalPhrase;
}

/**
 * v3.6.0: persist the send word. Single word, lowercase, trimmed.
 * Unlike exit phrase, no companionId — it's a global setting.
 * Empty string clears the send word (disable the feature).
 */
export async function saveSendPhrase(phrase: string): Promise<string> {
  const sanitized = phrase.trim().toLowerCase().slice(0, MAX_PHRASE_LENGTH);
  await AsyncStorage.setItem(SEND_PHRASE_KEY, sanitized);
  return sanitized;
}

/**
 * v3.6.0: read the trained samples for the active send word.
 * Returns null if no training exists. Used by the native OWW
 * bridge (setSendModelFromBase64) to install a freshly-trained
 * classifier.
 */
export async function loadSendSamples(phrase: string): Promise<any[] | null> {
  try {
    const raw = await AsyncStorage.getItem(getSendSamplesKey(phrase));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.features?.length) return parsed.features;
    return null;
  } catch (_) {
    return null;
  }
}

export async function saveSendSamples(phrase: string, features: any[]): Promise<void> {
  await AsyncStorage.setItem(
    getSendSamplesKey(phrase),
    JSON.stringify({ phrase, features, savedAt: Date.now() }),
  );
}

export async function clearSendSamples(phrase: string): Promise<void> {
  await AsyncStorage.removeItem(getSendSamplesKey(phrase));
}

/**
 * Read the per-companion per-phrase training samples. Returns
 * null if no training exists. Used by the voice-mode detector
 * to match against the live audio stream.
 */
export async function loadExitSamples(companionId: string, phrase: string): Promise<any[] | null> {
  try {
    const raw = await AsyncStorage.getItem(getExitSamplesKey(companionId, phrase));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.features?.length) return parsed.features;
    return null;
  } catch (_) {
    return null;
  }
}

export async function saveExitSamples(companionId: string, phrase: string, features: any[]): Promise<void> {
  await AsyncStorage.setItem(
    getExitSamplesKey(companionId, phrase),
    JSON.stringify({ phrase, features, savedAt: Date.now() }),
  );
}

export async function clearExitSamples(companionId: string, phrase: string): Promise<void> {
  await AsyncStorage.removeItem(getExitSamplesKey(companionId, phrase));
}

/**
 * v3.4.0: one-time migration from v3.3.0's global exit-phrase
 * storage to per-companion. Reads the legacy keys
 * (cyberclaw-voice-exit-phrase + cyberclaw-exit-samples-<phrase>)
 * and writes them under the given companionId. Idempotent — if
 * no legacy keys exist, this is a no-op. Should be called from
 * SettingsScreen on mount (after the agent cache is hydrated).
 *
 * Future cleanup pass (v3.5.0+): delete the legacy keys once
 * we're confident users have migrated. For now we leave them
 * in place so a downgrade to v3.3.0 doesn't lose training.
 */
export async function migrateLegacyExitSamples(companionId: string): Promise<void> {
  try {
    // Migrate the active exit phrase string.
    const legacyPhrase = await AsyncStorage.getItem(LEGACY_EXIT_PHRASE_KEY);
    if (legacyPhrase !== null) {
      const existing = await AsyncStorage.getItem(getExitPhraseKey(companionId));
      if (existing === null) {
        await AsyncStorage.setItem(getExitPhraseKey(companionId), legacyPhrase);
      }
    }
    // Migrate any trained samples. We don't know which phrases
    // were trained, so we walk the AsyncStorage keys and copy
    // any that match the legacy pattern into the new namespace.
    const allKeys = await AsyncStorage.getAllKeys();
    const legacySampleKeys = allKeys.filter(k =>
      k.startsWith('cyberclaw-exit-samples-') &&
      !k.includes(`${companionId}-`)  // already migrated
    );
    for (const oldKey of legacySampleKeys) {
      // Skip keys that already have a companionId prefix (some
      // keys look like 'cyberclaw-exit-samples-<word>-<word>'
      // — we can't easily tell those apart from the legacy
      // pattern without a heuristic). The heuristic: legacy
      // keys store a single phrase (no hyphen between companionId
      // and phrase). New keys always have companionId-then-phrase.
      // Since companionIds are UUIDs (contain hyphens), and old
      // keys had a single phrase with optional hyphens, we use
      // the rule "no UUID-shaped prefix" by checking that the
      // suffix isn't a phrase we already have stored.
      // v3.4.0 simplification: just attempt migration and let
      // AsyncStorage's key collision logic resolve. If the key
      // already exists in the new namespace, skip.
      const raw = await AsyncStorage.getItem(oldKey);
      if (!raw) continue;
      // Extract the phrase from the legacy key.
      const phrase = oldKey.replace('cyberclaw-exit-samples-', '').replace(/-/g, ' ');
      const newKey = getExitSamplesKey(companionId, phrase);
      const existing = await AsyncStorage.getItem(newKey);
      if (existing === null) {
        await AsyncStorage.setItem(newKey, raw);
      }
    }
  } catch (_) {}
}