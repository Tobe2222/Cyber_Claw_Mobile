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
import { getCurrentVoiceIdForCache } from './VoiceSettings';

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

// v3.10.166: cache key includes voice so a voice change
// in the picker produces a fresh synthesis on the next
// exit instead of playing the previous-voice WAV. Was
// just hashPhrase(phrase) before — voice change had no
// effect until the cache was manually cleared (which
// the picker didn't do — clearExitReplyCache() had no
// callers in the codebase).
function cacheKey(phrase: string, voice: string): string {
  return `${voice}::${phrase}`;
}

function fileNameForPhrase(phrase: string, voice: string): string {
  return `cyberclaw-exit-reply-${hashPhrase(cacheKey(phrase, voice))}.wav`;
}

// v3.2.29: returns the local file path of the cached
// exit reply audio for the given phrase, or null if no
// cache exists. Verifies the file actually exists on
// disk (in case the index is stale).
//
// v3.10.166: takes a voice parameter so the cache is
// per-(phrase, voice). A voice change in the picker
// misses the cache, which forces a fresh synthesis
// against the new desktop piper voice. Voice is
// resolved internally (per-companion override → global
// default → 'lessac') when not provided.
export async function getCachedExitReplyPath(
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

// v3.2.29: ask the desktop to synthesize the exit reply
// and stream it back. Fire-and-forget — voice-mode close
// doesn't wait for the audio. When the audio arrives, the
// exit_reply_audio listener calls saveExitReplyAudio().
// On a typical cold start the cache is empty so the first
// close fires a synthesis and falls back to speakText();
// subsequent closes use the warmed cache.
//
// v3.10.166: takes a voice parameter that's sent with
// the request so the desktop can pick the right piper
// voice. The mobile-side cache key is keyed by
// (phrase, voice), so a voice change forces a fresh
// synthesis. Voice is resolved internally when not
// provided.
export async function requestExitReplySynthesis(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<void> {
  if (!phrase || !phrase.trim()) return;
  const resolvedVoice = voice ?? await getCurrentVoiceIdForCache(companionId);
  if (pendingSynthesis && lastRequestedPhrase === phrase) {
    console.log(`[ExitReplyAudioCache] Synthesis already pending for "${phrase.substring(0, 30)}", skipping duplicate request`);
    return;
  }
  pendingSynthesis = true;
  lastRequestedPhrase = phrase;
  try {
    console.log(`[ExitReplyAudioCache] Requesting desktop synthesis for "${phrase.substring(0, 40)}" (voice=${resolvedVoice})`);
    syncClient.requestExitReplyAudio(phrase, resolvedVoice);
  } catch (e: any) {
    console.warn('[ExitReplyAudioCache] requestExitReplyAudio failed:', e?.message);
    pendingSynthesis = false;
  }
}

// v3.2.29: save the desktop-synthesized audio to permanent
// storage. Called from the exit_reply_audio event listener.
// Returns the local file path on success, null on failure.
//
// v3.10.166: takes a voice parameter so the saved file
// is keyed by (phrase, voice). Voice is resolved
// internally when not provided. The audio_response
// handler in HomeScreen.tsx forwards msg.voice from the
// desktop if present, so the cache write uses the same
// key the desktop synthesized against.
export async function saveExitReplyAudio(
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
    console.log(`[ExitReplyAudioCache] Saved exit reply audio: ${fullPath} (voice=${resolvedVoice}, ${audioBase64.length} base64 chars)`);
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
//
// v3.10.166: takes a voice parameter so the cache check
// is per-(phrase, voice). See getCachedExitReplyPath().
// Voice is resolved internally when not provided.
export async function ensureExitReplyCached(
  phrase: string,
  voice?: string,
  companionId?: string,
): Promise<string | null> {
  const existing = await getCachedExitReplyPath(phrase, voice, companionId);
  if (existing) return existing;
  await requestExitReplySynthesis(phrase, voice, companionId);
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
