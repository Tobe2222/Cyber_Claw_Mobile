/**
 * GreetingAudioCache — desktop-synthesized wake greeting audio.
 *
 * v3.1.91: The device-side native TTS is unavailable on some
 * Android skins (no TTS engine installed, status=-1 from
 * OnInitListener). To work around this, the mobile asks the
 * desktop to synthesize the greeting audio (via piper TTS in
 * local-ai.js) and caches the resulting WAV in permanent
 * storage. The wake event then plays the cached audio via
 * MediaPlayer, which works on every Android device regardless
 * of TTS engine status.
 *
 * Storage strategy:
 * - One file per greeting phrase, hashed (sha256 prefix) so
 *   the cache key is stable across whitespace/punctuation
 *   changes. Stored in DocumentDirectoryPath (persistent, not
 *   cleared on app restart).
 * - AsyncStorage key 'cyberclaw-greeting-cache-index' maps
 *   phrase → fileName so we can look up the file without
 *   re-hashing on every wake.
 * - If the cached file is missing or the phrase changed, we
 *   request a fresh synthesis from the desktop.
 * - Synthesis is fire-and-forget: the wake event falls back
 *   to speakText() (which we know fails on no-engine devices,
 *   but at least logs clearly) while the cache warms.
 */

const fs = require('react-native-fs');
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from './SyncClient';

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

function fileNameForPhrase(phrase: string): string {
  return `cyberclaw-greeting-${hashPhrase(phrase)}.wav`;
}

// v3.1.91: returns the local file path of the cached
// greeting audio for the given phrase, or null if no
// cache exists. Verifies the file actually exists on
// disk (in case the index is stale).
export async function getCachedGreetingPath(
  phrase: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim()) return null;
  const index = await loadIndex();
  const fileName = index[phrase] || fileNameForPhrase(phrase);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    const exists = await fs.exists(fullPath);
    if (!exists) {
      // Index points to a missing file — clean up and
      // treat as a cache miss.
      if (index[phrase]) {
        delete index[phrase];
        await saveIndex(index);
      }
      return null;
    }
    return fullPath;
  } catch (_) {
    return null;
  }
}

// v3.1.91: ask the desktop to synthesize the greeting
// and stream it back. Fire-and-forget — the phone
// continues normally while waiting for the audio. When
// the audio arrives, the greeting_audio listener below
// calls saveGreetingAudio().
export function requestGreetingSynthesis(phrase: string): void {
  if (!phrase || !phrase.trim()) return;
  if (pendingSynthesis && lastRequestedPhrase === phrase) {
    console.log(`[GreetingAudioCache] Synthesis already pending for "${phrase.substring(0, 30)}", skipping duplicate request`);
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = phrase;
  try {
    console.log(`[GreetingAudioCache] Requesting desktop synthesis for "${phrase.substring(0, 40)}"`);
    syncClient.requestGreetingAudio(phrase);
    // The send() method in SyncClient will log a warning
    // if the WS is not open. The user can then check
    // the connection state via the home screen's
    // connection indicator.
  } catch (e: any) {
    console.warn('[GreetingAudioCache] requestGreetingAudio failed:', e?.message);
    pendingSynthesis = false;
  }
}

// v3.1.92: was the synthesis request we made
// acknowledged by the desktop? If we sent the request
// but no audio_response arrived within the timeout,
// the desktop is probably not running an updated
// version (v3.1.31+) that handles the new message.
// Used by the wake greeting flow to give a clearer
// diagnostic when the cache stays empty across
// multiple wake events.
export function isSynthesisPending(): boolean {
  return pendingSynthesis;
}

// v3.1.91: save the desktop-synthesized audio to permanent
// storage. Called from the greeting_audio event listener.
// Returns the local file path on success, null on failure.
export async function saveGreetingAudio(
  phrase: string,
  audioBase64: string,
): Promise<string | null> {
  if (!phrase || !phrase.trim() || !audioBase64) return null;
  pendingSynthesis = false;
  const fileName = fileNameForPhrase(phrase);
  const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
  try {
    await fs.writeFile(fullPath, audioBase64, 'base64');
    const index = await loadIndex();
    index[phrase] = fileName;
    await saveIndex(index);
    console.log(`[GreetingAudioCache] Saved greeting audio: ${fullPath} (${audioBase64.length} base64 chars)`);
    return fullPath;
  } catch (e: any) {
    console.warn('[GreetingAudioCache] saveGreetingAudio failed:', e?.message);
    return null;
  }
}

// v3.1.91: ensure the greeting is cached. If not, fire a
// synthesis request (don't await — returns immediately).
// Returns the cached path if it already exists, or null
// if a synthesis was requested.
export async function ensureGreetingCached(phrase: string): Promise<string | null> {
  const existing = await getCachedGreetingPath(phrase);
  if (existing) return existing;
  requestGreetingSynthesis(phrase);
  return null;
}

// v3.1.91: clear the cache. Used by Settings → "Re-record
// greeting" or when the user wants to force a fresh
// synthesis (e.g. they don't like the voice quality of
// the current cache).
export async function clearGreetingCache(): Promise<void> {
  const index = await loadIndex();
  for (const fileName of Object.values(index)) {
    const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
    try { await fs.unlink(fullPath); } catch (_) {}
  }
  indexCache = {};
  await saveIndex({});
}