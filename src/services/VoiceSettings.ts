/** VOICE SETTINGS — v3.2.20 / v3.4.0 / v3.6.0 AsyncStorage-backed settings for the multi-turn voice-mode loop. */

import AsyncStorage from '@react-native-async-storage/async-storage';

// SILENCE_MS_KEY is now the *fallback* key.
export const SILENCE_MS_KEY = 'cyberclaw-voice-silence-ms';

// Tightened defaults.
export const DEFAULT_SILENCE_MS = 1800;
export const MIN_SILENCE_MS = 800;
export const MAX_SILENCE_MS = 6000;

/** v3.7.2: per-companion silence key builder. */
export const getSilenceMsKey = (companionId: string) =>
  `cyberclaw-voice-silence-ms-${companionId}`;

export const DEFAULT_EXIT_PHRASE = 'thanks';
export const MAX_PHRASE_WORDS = 4;
export const MAX_PHRASE_LENGTH = 40;

/** v3.6.0: send word. Global, single word, default 'send'. */
export const SEND_PHRASE_KEY = 'cyberclaw-send-phrase';
export const DEFAULT_SEND_PHRASE = 'send';

/** Your-turn cue sound. */
export const TURN_CUE_KEY = 'cyberclaw-voice-turn-cue';
export const LEGACY_TURN_CUE_KEY = 'cyberc…-turn-cue'; // v3.10.1: was the canonical key by accident; SettingsScreen wrote/read `cyberclaw-voice-turn-cue`, so the user-selected cue was never read by WakeModeScreen and no cue ever played. Fixed by aligning the two paths to the SettingsScreen canonical key.
export const DEFAULT_TURN_CUE = 'off';
export const TURN_CUE_OPTIONS = ['off', 'bird', 'bell', 'ding', 'chime'] as const;
export type TurnCueId = typeof TURN_CUE_OPTIONS[number];

/** 'working' / 'thinking' cue + speech while the LLM is processing. */
export const WORKING_CUE_KEY = 'cyberclaw-voice-working-cue';
export const DEFAULT_WORKING_CUE = 'off';
export const WORKING_CUE_OPTIONS = ['off', 'bird', 'bell', 'ding', 'chime'] as const;
export type WorkingCueId = typeof WORKING_CUE_OPTIONS[number];

export const WORKING_SPEECH_KEY = 'cyberclaw-voice-working-speech';
export const DEFAULT_WORKING_SPEECH = 'Working on it...';
export const MAX_WORKING_SPEECH_LENGTH = 60;
export const MIN_WORKING_SPEECH_DELAY_MS = 800;
export const MAX_WORKING_SPEECH_DELAY_MS = 5000;
export const WORKING_SPEECH_DELAY_KEY = 'cyberclaw-voice-working-delay-ms';
export const DEFAULT_WORKING_DELAY_MS = 1500;

/** Migrate the legacy turn-cue key (cyberc…-turn-cue, with the ellipsis as a typo'd abbreviation) to the canonical key… */
export async function migrateLegacyTurnCueKey(): Promise<boolean> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const [legacy, current] = await Promise.all([
      AsyncStorage.getItem(LEGACY_TURN_CUE_KEY),
      AsyncStorage.getItem(TURN_CUE_KEY),
    ]);
    if (!legacy) return false;
    if (current) {
      // The user has a value at the canonical key
      // (e.g. set by SettingsScreen). Drop the
      // legacy value — it's stale.
      await AsyncStorage.removeItem(LEGACY_TURN_CUE_KEY);
      return false;
    }
    // Migrate: copy legacy to canonical.
    await AsyncStorage.setItem(TURN_CUE_KEY, legacy);
    await AsyncStorage.removeItem(LEGACY_TURN_CUE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}
export const getSendSamplesKey = (phrase: string) =>
  `cyberclaw-send-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

/** v3.4.0: per-companion keys (replaces the v3.3.0 global keys). */
export const getExitPhraseKey = (companionId: string) =>
  `cyberclaw-exit-phrase-${companionId}`;

export const getExitSamplesKey = (companionId: string, phrase: string) =>
  `cyberclaw-exit-samples-${companionId}-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

/** Per-companion voice settings stripped of all cloud / API scaffolding. */
export const getVoiceEngineKey = (companionId: string) =>
  `cyberclaw-voice-engine-${companionId}`;

export const getVoiceLocalIdKey = (companionId: string) =>
  `cyberclaw-voice-local-id-${companionId}`;

/** A resolved voice config for one companion, with every field guaranteed non-null. */
export type ResolvedVoiceConfig = {
  engine: 'local';
  localId: string;
};

/** Legacy v3.3.0 keys (no companionId prefix). */
export const LEGACY_EXIT_PHRASE_KEY = 'cyberclaw-voice-exit-phrase';
export const getLegacyExitSamplesKey = (phrase: string) =>
  `cyberclaw-exit-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

export type VoiceSettings = {
  silenceMs: number;
  exitPhrase: string;
  sendPhrase: string;
  // Working cue + speech during LLM processing.
  workingCue: WorkingCueId;
  workingSpeech: string;
  workingDelayMs: number;
};

/** Read settings fresh from storage. */
export async function loadVoiceSettings(companionId?: string): Promise<VoiceSettings> {
  let silenceMs = DEFAULT_SILENCE_MS;
  let exitPhrase = DEFAULT_EXIT_PHRASE;
  let sendPhrase = DEFAULT_SEND_PHRASE;
  // Silence is now per-companion.
  let rawSilence: string | null = null;
  if (companionId) {
    try {
      rawSilence = await AsyncStorage.getItem(getSilenceMsKey(companionId));
    } catch (_) {}
  }
  if (rawSilence === null) {
    try {
      rawSilence = await AsyncStorage.getItem(SILENCE_MS_KEY);
    } catch (_) {}
  }
  if (rawSilence !== null) {
    const parsed = parseInt(rawSilence, 10);
    if (!isNaN(parsed)) {
      silenceMs = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, parsed));
    }
  }
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
  // v3.10.34: working cue + speech + delay. Each is
  // independent and read with a sane default fallback so a
  // bad/corrupt value can't break the loop.
  let workingCue: WorkingCueId = DEFAULT_WORKING_CUE;
  let workingSpeech = DEFAULT_WORKING_SPEECH;
  let workingDelayMs = DEFAULT_WORKING_DELAY_MS;
  try {
    const rawCue = await AsyncStorage.getItem(WORKING_CUE_KEY);
    if (rawCue && (WORKING_CUE_OPTIONS as readonly string[]).includes(rawCue)) {
      workingCue = rawCue as WorkingCueId;
    }
  } catch (_) {}
  try {
    const rawSpeech = await AsyncStorage.getItem(WORKING_SPEECH_KEY);
    if (rawSpeech !== null) {
      const trimmed = rawSpeech.trim().slice(0, MAX_WORKING_SPEECH_LENGTH);
      if (trimmed) workingSpeech = trimmed;
    }
  } catch (_) {}
  try {
    const rawDelay = await AsyncStorage.getItem(WORKING_SPEECH_DELAY_KEY);
    if (rawDelay !== null) {
      const parsed = parseInt(rawDelay, 10);
      if (!isNaN(parsed)) {
        workingDelayMs = Math.max(
          MIN_WORKING_SPEECH_DELAY_MS,
          Math.min(MAX_WORKING_SPEECH_DELAY_MS, parsed),
        );
      }
    }
  } catch (_) {}
  return {
    silenceMs,
    exitPhrase,
    sendPhrase,
    workingCue,
    workingSpeech,
    workingDelayMs,
  };
}

export async function saveSilenceMs(companionId: string, ms: number): Promise<void> {
  // Silence is per-companion.
  const clamped = Math.max(MIN_SILENCE_MS, Math.min(MAX_SILENCE_MS, Math.round(ms)));
  await AsyncStorage.setItem(getSilenceMsKey(companionId), String(clamped));
}

export async function saveExitPhrase(companionId: string, phrase: string): Promise<string> {
  const sanitized = phrase.trim().toLowerCase().slice(0, MAX_PHRASE_LENGTH);
  const wordCount = sanitized.split(/\s+/).filter(Boolean).length;
  const finalPhrase = wordCount <= MAX_PHRASE_WORDS ? sanitized : '';
  await AsyncStorage.setItem(getExitPhraseKey(companionId), finalPhrase);
  return finalPhrase;
}

/** Persist the send word. */
export async function saveSendPhrase(phrase: string): Promise<string> {
  const sanitized = phrase.trim().toLowerCase().slice(0, MAX_PHRASE_LENGTH);
  await AsyncStorage.setItem(SEND_PHRASE_KEY, sanitized);
  return sanitized;
}

/** Persist the working cue sound id, the user's working speech phrase, and the working delay. */
export async function saveWorkingCue(cue: WorkingCueId): Promise<void> {
  if (!(WORKING_CUE_OPTIONS as readonly string[]).includes(cue)) {
    throw new Error(`Invalid working cue: ${cue}`);
  }
  await AsyncStorage.setItem(WORKING_CUE_KEY, cue);
}

export async function saveWorkingSpeech(phrase: string): Promise<string> {
  const sanitized = phrase.trim().slice(0, MAX_WORKING_SPEECH_LENGTH);
  await AsyncStorage.setItem(WORKING_SPEECH_KEY, sanitized);
  return sanitized;
}

export async function saveWorkingDelayMs(ms: number): Promise<number> {
  const clamped = Math.max(
    MIN_WORKING_SPEECH_DELAY_MS,
    Math.min(MAX_WORKING_SPEECH_DELAY_MS, Math.round(ms)),
  );
  await AsyncStorage.setItem(WORKING_SPEECH_DELAY_KEY, String(clamped));
  return clamped;
}

/** Read the trained samples for the active send word. */
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

/** Read the trained-model metadata for the active send word. */
export async function loadSendModelInfo(
  phrase: string,
): Promise<{ trainedAt: number; modelPath: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(getSendSamplesKey(phrase));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.trainedAt === 'number' && typeof parsed?.modelPath === 'string') {
      return { trainedAt: parsed.trainedAt, modelPath: parsed.modelPath };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** Read the per-companion per-phrase training samples. */
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

/** Load the resolved voice config for a companion. */
export async function loadVoiceFor(companionId: string): Promise<ResolvedVoiceConfig> {
  let rawEngine: string | null = null;
  let rawLocalId: string | null = null;
  let globalEngine: string | null = null;
  let globalLocalId: string | null = null;
  try {
    [rawEngine, rawLocalId] = await Promise.all([
      AsyncStorage.getItem(getVoiceEngineKey(companionId)),
      AsyncStorage.getItem(getVoiceLocalIdKey(companionId)),
    ]);
  } catch (_) {}
  try {
    [globalEngine, globalLocalId] = await Promise.all([
      AsyncStorage.getItem('cyberclaw-voice-engine'),
      AsyncStorage.getItem('cyberclaw-voice-local'),
    ]);
  } catch (_) {}

  // Resolve engine: per-companion 'default' falls back to global,
  // anything non-'local' (including the obsolete 'api') falls
  // back to 'local'. There is no 'api' engine anymore.
  const effectiveEngine: 'local' =
    (rawEngine === 'local' || globalEngine === 'local') ? 'local' : 'local';

  return {
    engine: effectiveEngine,
    localId: rawLocalId || globalLocalId || 'default',
  };
}

// Small helper used by the greeting / exit-reply / working-speech audio caches.
export async function getCurrentVoiceIdForCache(companionId?: string): Promise<string> {
  try {
    if (companionId) {
      const cfg = await loadVoiceFor(companionId);
      if (cfg.localId && cfg.localId !== 'default') return cfg.localId;
    }
    const global = await AsyncStorage.getItem('cyberclaw-voice-local');
    if (global && global !== 'default') return global;
  } catch (_) {}
  return 'lessac';
}

/** Persist a companion's voice config. */
export async function saveVoiceFor(
  companionId: string,
  patch: {
    engine?: 'local' | 'default';
    localId?: string;
  },
): Promise<void> {
  const ops: Array<Promise<void>> = [];
  if (patch.engine !== undefined) {
    // 'api' is no longer a valid engine.
    const safeEngine: 'local' | 'default' = patch.engine === 'local' ? 'local' : 'default';
    ops.push(AsyncStorage.setItem(getVoiceEngineKey(companionId), safeEngine));
  }
  if (patch.localId !== undefined) {
    ops.push(AsyncStorage.setItem(getVoiceLocalIdKey(companionId), patch.localId));
  }
  await Promise.all(ops);
}

/** Clear the per-companion voice overrides for one companion, reverting to the global defaults. */
export async function clearVoiceFor(companionId: string): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(getVoiceEngineKey(companionId)),
    AsyncStorage.removeItem(getVoiceLocalIdKey(companionId)),
  ]);
}

/** One-time migration that drops all the cloud-TTS scaffolding. */
export async function migrateV3_10_154_dropCloudTts(): Promise<{
  clearedKeys: number;
  normalizedEngines: number;
  normalizedVoiceIds: number;
}> {
  const result = { clearedKeys: 0, normalizedEngines: 0, normalizedVoiceIds: 0 };
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    // The legacy keys to clear outright. They have no
    // meaning after v3.10.154 — keeping them around would
    // just be dead weight in AsyncStorage.
    const legacyKeys = allKeys.filter(k =>
      k === 'cyberclaw-voice-api-provider' ||
      k === 'cyberclaw-voice-api-voice' ||
      k === 'cyberclaw-voice-api-key' ||
      k.startsWith('cyberclaw-voice-api-provider-') ||
      k.startsWith('cyberclaw-voice-api-voice-')
    );
    if (legacyKeys.length > 0) {
      // AsyncStorage v3 renamed multiRemove → removeMany.
      await (AsyncStorage as any).removeMany
        ? (AsyncStorage as any).removeMany(legacyKeys)
        : (AsyncStorage as any).multiRemove(legacyKeys);
      result.clearedKeys = legacyKeys.length;
    }
    // Normalize any engine value of 'api' to 'default'.
    // Two scopes: global + per-companion.
    const tryNormalizeEngine = async (key: string) => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw === 'api') {
          await AsyncStorage.setItem(key, 'default');
          result.normalizedEngines++;
        }
      } catch (_) {}
    };
    await tryNormalizeEngine('cyberclaw-voice-engine');
    const engineKeys = allKeys.filter(k =>
      k.startsWith('cyberclaw-voice-engine-') &&
      // skip the ones we already migrated above
      k !== 'cyberclaw-voice-api-provider' &&
      k !== 'cyberclaw-voice-api-voice'
    );
    for (const k of engineKeys) {
      await tryNormalizeEngine(k);
    }
    // Normalize any voice id of 'nova' (the ElevenLabs Nova
    // default) back to 'default'. Nova isn't a valid local
    // voice id and would render as a broken picker entry.
    const tryNormalizeVoiceId = async (key: string) => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw === 'nova') {
          await AsyncStorage.setItem(key, 'default');
          result.normalizedVoiceIds++;
        }
      } catch (_) {}
    };
    await tryNormalizeVoiceId('cyberclaw-voice-local');
    const localIdKeys = allKeys.filter(k => k.startsWith('cyberclaw-voice-local-id-'));
    for (const k of localIdKeys) {
      await tryNormalizeVoiceId(k);
    }
  } catch (_) {
    // Migration is best-effort. If AsyncStorage throws
    // (shouldn't happen, but defensive), the next launch
    // will retry.
  }
  return result;
}

/** One-time migration from v3.3.0's global exit-phrase storage to per-companion. */
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
      // Skip keys that already have a companionId prefix (some keys look like 'cyberclaw-exit-samples-<word>-<word>' — we can't easily tell those…
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