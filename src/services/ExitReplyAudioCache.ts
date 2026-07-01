/**
 * ExitReplyAudioCache — desktop-synthesized exit reply audio.
 *
 * v3.2.29: Mirror of GreetingAudioCache for the exit reply
 * phrase. The companion says the reply on voice-mode close
 * (silence timeout, exit phrase match, trainer-cancel). Same
 * desktop-piper-TTS-then-cache-on-mobile pipeline as the
 * greeting, but for a different phrase + a different
 * storage key namespace so the two caches don't collide.
 *
 * Storage strategy:
 * - One file per exit reply phrase, hashed (sha256 prefix)
 *   so the cache key is stable across whitespace/punctuation
 *   changes. Stored in DocumentDirectoryPath (persistent, not
 *   cleared on app restart).
 * - AsyncStorage key 'cyberclaw-exit-reply-cache-index' maps
 *   phrase → fileName.
 * - If the cached file is missing or the phrase changed, we
 *   request a fresh synthesis from the desktop.
 * - Synthesis is fire-and-forget: voice-mode close falls back
 *   to speakText() while the cache warms.
 *
 * Why a sibling module instead of extending GreetingAudioCache:
 * - Different cache index key (so clearing greeting doesn't
 *   nuke exit-reply and vice versa).
 * - Different requestId on the wire ('exit_reply' vs
 *   'greeting') so the desktop can route the response to the
 *   right cache.
 * - Different file name prefix (cyberclaw-exit-reply-*
 *   vs cyberclaw-greeting-*) so the two caches are visually
 *   distinct in DocumentDirectory.
 * - Allows future divergence: e.g. different TTS voice for
 *   exit, per-companion replies, etc.
 */

const fs = require('react-native-fs');
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from './SyncClient';

const CACHE_INDEX_KEY = 'cyberclaw-exit-reply-cache-index';

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

// v3.2.29: cheap deterministic hash for the cache key.
// Not cryptographic — we just need a stable filename.
// Mirrors the greeting cache's hashPhrase so the two
// caches use the same hash function (avoids surprises
// when one is wiped and the other isn't).
function hashPhrase(phrase: string): string {
  let h = 5381;
  for (let i = 0; i < phrase.length; i++) {
    h = ((h << 5) + h) + phrase.charCodeAt(i);
    h = h | 0; // int32
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fileNameForPhrase(phrase: string): string {
  return `cyberclaw-exit-reply-${hashPhrase(phrase)}.wav`;
}

// v3.2.29: returns the local file path of the cached
// exit reply audio for the given phrase, or null if no
// cache exists. Verifies the file actually exists on
// disk (in case the index is stale).
export async function getCachedExitReplyPath(
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

// v3.2.29: ask the desktop to synthesize the exit reply
// and stream it back. Fire-and-forget — voice-mode close
// doesn't wait for the audio. When the audio arrives, the
// exit_reply_audio listener calls saveExitReplyAudio().
// On a typical cold start the cache is empty so the first
// close fires a synthesis and falls back to speakText();
// subsequent closes use the warmed cache.
export function requestExitReplySynthesis(phrase: string): void {
  if (!phrase || !phrase.trim()) return;
  if (pendingSynthesis && lastRequestedPhrase === phrase) {
    console.log(`[ExitReplyAudioCache] Synthesis already pending for "${phrase.substring(0, 30)}", skipping duplicate request`);
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = phrase;
  try {
    console.log(`[ExitReplyAudioCache] Requesting desktop synthesis for "${phrase.substring(0, 40)}"`);
    syncClient.requestExitReplyAudio(phrase);
  } catch (e: any) {
    console.warn('[ExitReplyAudioCache] requestExitReplyAudio failed:', e?.message);
    pendingSynthesis = false;
  }
}

// v3.2.29: save the desktop-synthesized audio to permanent
// storage. Called from the exit_reply_audio event listener.
// Returns the local file path on success, null on failure.
export async function saveExitReplyAudio(
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
    console.log(`[ExitReplyAudioCache] Saved exit reply audio: ${fullPath} (${audioBase64.length} base64 chars)`);
    return fullPath;
  } catch (e: any) {
    console.warn('[ExitReplyAudioCache] saveExitReplyAudio failed:', e?.message);
    return null;
  }
}

// v3.2.29: ensure the exit reply is cached. If not, fire a
// synthesis request (don't await — returns immediately).
// Returns the cached path if it already exists, or null
// if a synthesis was requested.
export async function ensureExitReplyCached(phrase: string): Promise<string | null> {
  const existing = await getCachedExitReplyPath(phrase);
  if (existing) return existing;
  requestExitReplySynthesis(phrase);
  return null;
}

// v3.2.29: clear the cache. Used by Settings when the user
// wants to force a fresh synthesis (e.g. they don't like
// the voice quality of the current cache).
export async function clearExitReplyCache(): Promise<void> {
  const index = await loadIndex();
  for (const fileName of Object.values(index)) {
    const fullPath = `${fs.DocumentDirectoryPath}/${fileName}`;
    try { await fs.unlink(fullPath); } catch (_) {}
  }
  indexCache = {};
  await saveIndex({});
}
