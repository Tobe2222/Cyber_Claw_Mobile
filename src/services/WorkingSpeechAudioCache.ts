/** WorkingSpeechAudioCache — desktop-synthesized working speech audio. */

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

// Cache key includes voice so a voice change in the picker produces a fresh synthesis on the next working-speech cue instead of playing the…
function cacheKey(phrase: string, voice: string): string {
  return `${voice}::${phrase}`;
}

function fileNameForPhrase(phrase: string, voice: string): string {
  return `cyberclaw-working-speech-${hashPhrase(cacheKey(phrase, voice))}.wav`;
}

/** Look up the cached audio file path for a phrase. */
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

/** Request a fresh piper synthesis of the phrase from the desktop. */
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

/** Called from the audio_response listener when requestId === 'working_speech'. */
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

// Wipe the entire working-speech cache.
export async function clearWorkingSpeechCache(): Promise<void> {
  const index = await loadIndex();
  for (const fileName of Object.values(index)) {
    const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
    try { await fs.unlink(fullPath); } catch (_) {}
  }
  indexCache = {};
  await saveIndex({});
}
