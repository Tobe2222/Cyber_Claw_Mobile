/**
 * VOICE SETTINGS — v3.2.20 / v3.4.0 / v3.6.0
 *
 * AsyncStorage-backed settings for the multi-turn voice-mode loop.
 *
 * Keys (v3.7.2 — per-companion silence):
 *   - cyberclaw-voice-silence-ms-<companionId>  Number (2000..10000),
 *                                          continuous silence in ms
 *                                          that closes a recording
 *                                          turn. Default 5000. Per-
 *                                          companion so chatty vs
 *                                          terse companions can have
 *                                          different silence.
 *   - cyberclaw-voice-silence-ms          Legacy v3.7.1 global key,
 *                                          read as a fallback for
 *                                          companions without a
 *                                          per-companion override.
 *                                          Not written by v3.7.2+.
 *
 * Keys (v3.4.0 — per-companion exit phrase):
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

// v3.7.2: SILENCE_MS_KEY is now the *fallback* key. The
// per-companion key (getSilenceMsKey(companionId)) is
// consulted first; if missing, we fall back to the global
// value stored under SILENCE_MS_KEY. v3.7.1 users have a
// value in SILENCE_MS_KEY (their existing global silence
// setting); that value becomes the default for any
// companion without a per-companion override, so they
// don't lose their setting on upgrade. The first time
// they touch the silence slider in a companion's voice
// sub-page, that companion gets its own per-companion value.
export const SILENCE_MS_KEY = 'cyberclaw-voice-silence-ms';

export const DEFAULT_SILENCE_MS = 5000;
export const MIN_SILENCE_MS = 2000;
export const MAX_SILENCE_MS = 10000;

/** v3.7.2: per-companion silence key builder. */
export const getSilenceMsKey = (companionId: string) =>
  `cyberclaw-voice-silence-ms-${companionId}`;

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
 * v3.7.0: per-companion voice settings (engine + voice id,
 * for both Local and Premium API paths). Companion-specific
 * overrides let the user pick a different voice per
 * companion (e.g. Lamasuu = Male, Clawsuu = Female) without
 * changing the global default.
 *
 * Each per-companion key is independent. A missing key means
 * "use the global default" — see loadVoiceFor() below.
 *
 * Keys:
 *   - cyberclaw-voice-engine-<companionId>       'local' | 'api' | 'default'
 *   - cyberclaw-voice-local-id-<companionId>     voice id (e.g. 'male', 'female')
 *   - cyberclaw-voice-api-provider-<companionId> provider id (e.g. 'elevenlabs')
 *   - cyberclaw-voice-api-voice-<companionId>    voice id (e.g. 'nova')
 */
export const getVoiceEngineKey = (companionId: string) =>
  `cyberclaw-voice-engine-${companionId}`;

export const getVoiceLocalIdKey = (companionId: string) =>
  `cyberclaw-voice-local-id-${companionId}`;

export const getVoiceApiProviderKey = (companionId: string) =>
  `cyberclaw-voice-api-provider-${companionId}`;

export const getVoiceApiVoiceKey = (companionId: string) =>
  `cyberclaw-voice-api-voice-${companionId}`;

/**
 * v3.7.0: a resolved voice config for one companion, with
 * every field guaranteed non-null. If the per-companion
 * override is missing, the corresponding global default is
 * used instead.
 *
 *   engine:    'local' | 'api'
 *   localId:   one of LOCAL_VOICES[].id
 *   apiProvider: one of PREMIUM_PROVIDERS[].id
 *   apiVoice:  one of PREMIUM_PROVIDERS[].voices[].id
 *
 * The 'default' engine value (stored when the user picks
 * "Use global default") is resolved here to the effective
 * engine, so consumers don't have to special-case it.
 */
export type ResolvedVoiceConfig = {
  engine: 'local' | 'api';
  localId: string;
  apiProvider: string;
  apiVoice: string;
};

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
  // v3.7.2: silence is now per-companion. Read the
  // per-companion key first; fall back to the global
  // key (v3.7.1 value) if missing, then to the default.
  // This way v3.7.1 users keep their existing silence
  // setting for any companion that hasn't been
  // overridden.
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
  return { silenceMs, exitPhrase, sendPhrase };
}

export async function saveSilenceMs(companionId: string, ms: number): Promise<void> {
  // v3.7.2: silence is per-companion. The save always
  // writes to the per-companion key; the global key
  // (SILENCE_MS_KEY) is read-only fallback, not written
  // by this function.
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
 * v3.8.3: read the trained-model metadata for the active
 * send word. Returns null if no training exists for this
 * phrase. The send-word trainer writes
 * `{ trainedAt, modelPath }` to the same AsyncStorage key
 * after a successful hot-swap; this helper reads that
 * shape (not the legacy `{ phrase, features, savedAt }`
 * shape that loadSendSamples expects, which the trainer
 * never writes). Used by the settings UI to render a
 * "Listening for: <phrase>" badge and a timestamp so the
 * user can see at a glance whether a trained model is
 * installed, when it was trained, and on which file.
 */
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
 * v3.7.0: load the resolved voice config for a companion.
 *
 * Reads the four per-companion keys. For each field, if the
 * per-companion key is missing, falls back to the global
 * default (the keys the v3.6.2 API keys section writes:
 * voiceEngine, voiceLocalId, voiceApiProvider, voiceApiVoice).
 *
 * The 'default' engine value is resolved to the effective
 * engine so the consumer doesn't have to special-case it.
 * If the global engine is also 'default' (legacy v3.6.2 user
 * who never picked one), we fall back to 'local' so the
 * resolved config is always usable.
 */
export async function loadVoiceFor(companionId: string): Promise<ResolvedVoiceConfig> {
  let rawEngine: string | null = null;
  let rawLocalId: string | null = null;
  let rawApiProvider: string | null = null;
  let rawApiVoice: string | null = null;
  let globalEngine: string | null = null;
  let globalLocalId: string | null = null;
  let globalApiProvider: string | null = null;
  let globalApiVoice: string | null = null;
  try {
    [rawEngine, rawLocalId, rawApiProvider, rawApiVoice] = await Promise.all([
      AsyncStorage.getItem(getVoiceEngineKey(companionId)),
      AsyncStorage.getItem(getVoiceLocalIdKey(companionId)),
      AsyncStorage.getItem(getVoiceApiProviderKey(companionId)),
      AsyncStorage.getItem(getVoiceApiVoiceKey(companionId)),
    ]);
  } catch (_) {}
  try {
    [globalEngine, globalLocalId, globalApiProvider, globalApiVoice] = await Promise.all([
      AsyncStorage.getItem('cyberclaw-voice-engine'),
      AsyncStorage.getItem('cyberclaw-voice-local'),
      AsyncStorage.getItem('cyberclaw-voice-api-provider'),
      AsyncStorage.getItem('cyberclaw-voice-api-voice'),
    ]);
  } catch (_) {}

  // Resolve engine: per-companion 'default' falls back to global.
  let effectiveEngine: 'local' | 'api';
  if (rawEngine === 'local' || rawEngine === 'api') {
    effectiveEngine = rawEngine;
  } else if (globalEngine === 'local' || globalEngine === 'api') {
    effectiveEngine = globalEngine;
  } else {
    effectiveEngine = 'local';
  }

  return {
    engine: effectiveEngine,
    localId: rawLocalId || globalLocalId || 'default',
    apiProvider: rawApiProvider || globalApiProvider || 'elevenlabs',
    apiVoice: rawApiVoice || globalApiVoice || 'nova',
  };
}

/**
 * v3.7.0: persist a companion's voice config. Pass any field
 * as undefined to leave it unchanged; pass an explicit value
 * to set it (including the empty string to clear a per-
 * companion override, reverting to the global default).
 */
export async function saveVoiceFor(
  companionId: string,
  patch: {
    engine?: 'local' | 'api' | 'default';
    localId?: string;
    apiProvider?: string;
    apiVoice?: string;
  },
): Promise<void> {
  const ops: Array<Promise<void>> = [];
  if (patch.engine !== undefined) {
    ops.push(AsyncStorage.setItem(getVoiceEngineKey(companionId), patch.engine));
  }
  if (patch.localId !== undefined) {
    ops.push(AsyncStorage.setItem(getVoiceLocalIdKey(companionId), patch.localId));
  }
  if (patch.apiProvider !== undefined) {
    ops.push(AsyncStorage.setItem(getVoiceApiProviderKey(companionId), patch.apiProvider));
  }
  if (patch.apiVoice !== undefined) {
    ops.push(AsyncStorage.setItem(getVoiceApiVoiceKey(companionId), patch.apiVoice));
  }
  await Promise.all(ops);
}

/**
 * v3.7.0: clear the per-companion voice overrides for one
 * companion, reverting to the global defaults. The TTS layer
 * will pick up the global values again.
 */
export async function clearVoiceFor(companionId: string): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(getVoiceEngineKey(companionId)),
    AsyncStorage.removeItem(getVoiceLocalIdKey(companionId)),
    AsyncStorage.removeItem(getVoiceApiProviderKey(companionId)),
    AsyncStorage.removeItem(getVoiceApiVoiceKey(companionId)),
  ]);
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