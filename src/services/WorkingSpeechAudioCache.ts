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

function fileNameForPhrase(phrase: string): string {
  return `cyberclaw-working-speech-${hashPhrase(phrase)}.wav`;
}

/**
 * Look up the cached audio file path for a phrase. Returns
 * null if no cache hit (caller should fall back to
 * speak()).
 */
export async function getCachedWorkingSpeechPath(
  phrase: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim()) return null;
  const trimmed = phrase.trim();
  const index = await loadIndex();
  const fileName = index[trimmed];
  if (!fileName) return null;
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  // Verify the file still exists — AsyncStorage index can
  // be stale if the user cleared the cache or the file
  // was deleted out-of-band.
  try {
    const exists = await fs.exists(fullPath);
    if (!exists) {
      // Stale index entry — clean it up.
      delete index[trimmed];
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
 */
export function ensureWorkingSpeechCached(phrase: string): void {
  if (!phrase || !phrase.trim()) return;
  const trimmed = phrase.trim();
  if (pendingSynthesis && lastRequestedPhrase === trimmed) {
    // Already requesting this exact phrase. Don't stack.
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = trimmed;
  try {
    syncClient.requestWorkingSpeechAudio?.(trimmed);
  } catch (_) {
    pendingSynthesis = false;
  }
}

/**
 * Called from the audio_response listener when
 * requestId === 'working_speech'. Saves the audio to
 * the cache directory + updates the AsyncStorage index.
 */
export async function saveWorkingSpeechAudio(
  phrase: string,
  audioBase64: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim() || !audioBase64) return null;
  pendingSynthesis = false;
  const trimmed = phrase.trim();
  const fileName = fileNameForPhrase(trimmed);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    await fs.writeFile(fullPath, audioBase64, 'base64');
    const index = await loadIndex();
    index[trimmed] = fileName;
    await saveIndex(index);
    console.log(`[WorkingSpeechAudioCache] Saved working speech audio: ${fullPath} (${audioBase64.length} base64 chars)`);
    return fullPath;
  } catch (e: any) {
    console.warn('[WorkingSpeechAudioCache] saveWorkingSpeechAudio failed:', e?.message);
    return null;
  }
}

export function isWorkingSpeechPending(): boolean {
  return pendingSynthesis;
}
