/** GreetingAudioCache — desktop-synthesized wake greeting audio. */

const fs = require('react-native-fs');
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from './SyncClient';
import { getCurrentVoiceIdForCache } from './VoiceSettings';

const CACHE_INDEX_KEY = 'cyberclaw-greeting-cache-index';

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

// v3.1.91: cheap deterministic hash for the cache key.
// Not cryptographic — we just need a stable filename.
function hashPhrase(phrase: string): string {
  let h = 5381;
  for (let i = 0; i < phrase.length; i++) {
    h = ((h << 5) + h) + phrase.charCodeAt(i);
    h = h | 0; // int32
  }
  // Convert to unsigned hex
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Cache key includes voice so a voice change in the picker produces a fresh synthesis on the next wake instead of playing the previous-voice…
function cacheKey(phrase: string, voice: string): string {
  return `${voice}::${phrase}`;
}

function fileNameForPhrase(phrase: string, voice: string): string {
  return `cyberclaw-greeting-${hashPhrase(cacheKey(phrase, voice))}.wav`;
}

// Returns the local file path of the cached greeting audio for the given phrase + voice, or null if no cache exists.
export async function getCachedGreetingPath(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim()) return null;
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  const index = await loadIndex();
  const key = cacheKey(phrase, resolvedVoice);
  const fileName = index[key] || fileNameForPhrase(phrase, resolvedVoice);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    const exists = await fs.exists(fullPath);
    if (!exists) {
      // Index points to a missing file — clean up and
      // treat as a cache miss.
      if (index[key]) {
        delete index[key];
        await saveIndex(index);
      }
      return null;
    }
    return fullPath;
  } catch (_) {
    return null;
  }
}

// Ask the desktop to synthesize the greeting and stream it back.
export async function requestGreetingSynthesis(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<void> {
  if (!phrase || !phrase.trim()) return;
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  if (pendingSynthesis && lastRequestedPhrase === phrase) {
    console.log(`[GreetingAudioCache] Synthesis already pending for "${phrase.substring(0, 30)}", skipping duplicate request`);
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = phrase;
  try {
    console.log(`[GreetingAudioCache] Requesting desktop synthesis for "${phrase.substring(0, 40)}" (voice=${resolvedVoice})`);
    syncClient.requestGreetingAudio(phrase, resolvedVoice);
    // The send() method in SyncClient will log a warning if the WS is not open.
  } catch (e: any) {
    console.warn('[GreetingAudioCache] requestGreetingAudio failed:', e?.message);
    pendingSynthesis = false;
  }
}

// Was the synthesis request we made acknowledged by the desktop?
export function isSynthesisPending(): boolean {
  return pendingSynthesis;
}

// Save the desktop-synthesized audio to permanent storage.
export async function saveGreetingAudio(
  phrase: string,
  audioBase64: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim() || !audioBase64) return null;
  pendingSynthesis = false;
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  const fileName = fileNameForPhrase(phrase, resolvedVoice);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    await fs.writeFile(fullPath, audioBase64, 'base64');
    const index = await loadIndex();
    index[cacheKey(phrase, resolvedVoice)] = fileName;
    await saveIndex(index);
    console.log(`[GreetingAudioCache] Saved greeting audio: ${fullPath} (voice=${resolvedVoice}, ${audioBase64.length} base64 chars)`);
    return fullPath;
  } catch (e: any) {
    console.warn('[GreetingAudioCache] saveGreetingAudio failed:', e?.message);
    return null;
  }
}

// Ensure the greeting is cached.
export async function ensureGreetingCached(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  const existing = await getCachedGreetingPath(phrase, voice, companionId);
  if (existing) return existing;
  await requestGreetingSynthesis(phrase, voice, companionId);
  return null;
}

// Clear the cache.
export async function clearGreetingCache(): Promise<void> {
  const index = await loadIndex();
  for (const fileName of Object.values(index)) {
    const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
    try { await fs.unlink(fullPath); } catch (_) {}
  }
  indexCache = {};
  await saveIndex({});
}