/**
 * WorkingSpeechAudioCache — desktop-synthesized working
 * speech audio.
 *
 * v3.10.162: Mirror of GreetingAudioCache + ExitReplyAudioCache
 * for the working speech phrase. The mobile's
 * playWorkingSpeechAndCue() reads from this cache first;
 * on a cache miss it falls back to speak() (Android TTS).
 *
 * Pipeline (same as greeting + exit reply):
 * 1. Mobile sends `request_working_audio` with the phrase.
 * 2. Desktop piper synthesizes the audio and sends back
 *    an `audio_response` tagged `requestId='working_speech'`.
 * 3. Mobile saves the audio to DocumentDirectoryPath
 *    (persistent) keyed by the phrase's sha256 prefix.
 * 4. Next time the same phrase is requested, the cache hit
 *    avoids the round-trip.
 *
 * The cache is keyed by the phrase text so that:
 * - Changing the phrase in Settings naturally invalidates
 *   the previous cache entry (different key).
 * - Whitespace/punctuation variations of the same phrase
 *   hash to the same key (deterministic hashing).
 *
 * Storage: DocumentDirectoryPath (persistent, not cleared
 * on app restart). Files are named
 * `cyberclaw-working-speech-<hash8>.wav`. The cache
 * index lives in AsyncStorage under
 * `cyberclaw-working-speech-cache-index` (phrase → fileName).
 */

const fs = require('react-native-fs');
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from './SyncClient';
import { getCurrentVoiceIdForCache } from './VoiceSettings';

const CACHE_INDEX_KEY = 'cyberclaw-working-speech-cache-index';

type CacheIndex = Record<string, string>; // phrase → fileName

let indexCache: CacheIndex | null = null;
let pendingSynthesis = false;
let lastRequestedPhrase: string | null = null;

async function loadIndex(): Promise<CacheIndex> {
  if (indexCache) return indexCache;
  try {
    const raw = await AsyncStorage.getItem(CACHE_INDEX_KEY);
    indexCache = raw ? JSON.parse(raw) : {};
  } catch (_) {
    indexCache = {};
  }
  return indexCache!;
}

async function saveIndex(index: CacheIndex): Promise<void> {
  indexCache = index;
  try {
    await AsyncStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
  } catch (_) {}
}

// Deterministic 32-bit hash. Same function as the greeting
// + exit-reply caches so swapping caches doesn't surprise
// users with new filenames.
function hashPhrase(phrase: string): string {
  let h = 5381;
  for (let i = 0; i < phrase.length; i++) {
    h = ((h << 5) + h) + phrase.charCodeAt(i);
    h = h | 0; // int32
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// v3.10.166: cache key includes voice so a voice change
// in the picker produces a fresh synthesis on the next
// working-speech cue instead of playing the
// previous-voice WAV. Mirrors the same fix in
// GreetingAudioCache + ExitReplyAudioCache.
function cacheKey(phrase: string, voice: string): string {
  return `${voice}::${phrase}`;
}

function fileNameForPhrase(phrase: string, voice: string): string {
  return `cyberclaw-working-speech-${hashPhrase(cacheKey(phrase, voice))}.wav`;
}

/**
 * Look up the cached audio file path for a phrase. Returns
 * null if no cache hit (caller should fall back to
 * speak()).
 *
 * v3.10.166: takes a voice parameter so the cache is
 * per-(phrase, voice). A voice change in the picker
 * misses the cache, which forces a fresh synthesis
 * against the new desktop piper voice. Voice is resolved
 * internally (per-companion override → global default →
 * 'lessac') when not provided.
 */
export async function getCachedWorkingSpeechPath(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim()) return null;
  const trimmed = phrase.trim();
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  const index = await loadIndex();
  const key = cacheKey(trimmed, resolvedVoice);
  const fileName = index[key];
  if (!fileName) return null;
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  // Verify the file still exists — AsyncStorage index can
  // be stale if the user cleared the cache or the file
  // was deleted out-of-band.
  try {
    const exists = await fs.exists(fullPath);
    if (!exists) {
      // Stale index entry — clean it up.
      delete index[key];
      await saveIndex(index);
      return null;
    }
  } catch (_) {
    return null;
  }
  return fullPath;
}

/**
 * Request a fresh piper synthesis of the phrase from the
 * desktop. Fire-and-forget — the cache will be populated
 * when the desktop's audio_response comes back. Callers
 * should pre-warm this on app open + whenever the user
 * changes the working speech phrase in Settings.
 *
 * v3.10.166: takes a voice parameter that's sent with
 * the request so the desktop can pick the right piper
 * voice. The mobile-side cache key is keyed by
 * (phrase, voice), so a voice change forces a fresh
 * synthesis. Voice is resolved internally when not
 * provided.
 */
export async function ensureWorkingSpeechCached(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<void> {
  if (!phrase || !phrase.trim()) return;
  const trimmed = phrase.trim();
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  if (pendingSynthesis && lastRequestedPhrase === trimmed) {
    // Already requesting this exact phrase. Don't stack.
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = trimmed;
  try {
    syncClient.requestWorkingSpeechAudio?.(trimmed, resolvedVoice);
  } catch (_) {
    pendingSynthesis = false;
  }
}

/**
 * Called from the audio_response listener when
 * requestId === 'working_speech'. Saves the audio to
 * the cache directory + updates the AsyncStorage index.
 *
 * v3.10.166: takes a voice parameter so the saved file
 * is keyed by (phrase, voice). Voice is resolved
 * internally when not provided.
 */
export async function saveWorkingSpeechAudio(
  phrase: string,
  audioBase64: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim() || !audioBase64) return null;
  pendingSynthesis = false;
  const trimmed = phrase.trim();
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  const fileName = fileNameForPhrase(trimmed, resolvedVoice);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    await fs.writeFile(fullPath, audioBase64, 'base64');
    const index = await loadIndex();
    index[cacheKey(trimmed, resolvedVoice)] = fileName;
    await saveIndex(index);
    console.log(`[WorkingSpeechAudioCache] Saved working speech audio: ${fullPath} (voice=${resolvedVoice}, ${audioBase64.length} base64 chars)`);
    return fullPath;
  } catch (e: any) {
    console.warn('[WorkingSpeechAudioCache] saveWorkingSpeechAudio failed:', e?.message);
    return null;
  }
}

export function isWorkingSpeechPending(): boolean {
  return pendingSynthesis;
}

// v3.10.166: wipe the entire working-speech cache.
// CompanionSettingsScreen calls this when the user picks
// a new piper voice in the picker, so the next working
// cue synthesizes with the new voice instead of playing
// a stale WAV. Mirrors clearGreetingCache() and
// clearExitReplyCache() so the three caches have a
// consistent API.
export async function clearWorkingSpeechCache(): Promise<void> {
  const index = await loadIndex();
  for (const fileName of Object.values(index)) {
    const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
    try { await fs.unlink(fullPath); } catch (_) {}
  }
  indexCache = {};
  await saveIndex({});
}
