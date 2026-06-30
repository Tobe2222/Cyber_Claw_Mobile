/**
 * EXIT PHRASE MATCHER — v3.2.17
 *
 * Pure-JS, offline. Decides whether a transcribed user
 * utterance contains one of the user-configured exit phrases
 * (e.g. "thanks", "goodbye", "that's all").
 *
 * Matching is intentionally fuzzy-but-bounded:
 *
 *   1. Normalize both sides: lowercase, collapse whitespace,
 *      strip trailing punctuation (.!?,), strip leading
 *      filler ("um", "uh", "okay so", "ok").
 *   2. For each exit phrase:
 *        - If the phrase is a single word → check
 *          word-substring containment in the transcribed
 *          text. "thanks" matches "thanks!", "Thanks.", and
 *          "thanks for that" (substring on whole words).
 *        - If the phrase is multi-word → require a contiguous
 *          substring in the normalized text. "that's all"
 *          matches "that's all", "Oh, that's all I wanted."
 *          but not "all that that's". The phrase must appear
 *          with at most one non-letter character between its
 *          words (so "thank you" matches "thank-you" too).
 *
 * Returns the matched phrase (so the UI can log which one
 * fired) or null when no phrase matched.
 *
 * No LLM, no API, no native dep. ~50 lines.
 */

const FILLER_PREFIXES = /^(um|uh|okay so|ok so|ok|so|well|hey|hi)\s+/i;

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/['']/g, "'") // unify curly apostrophes
    .replace(/\s+/g, ' ')
    .trim()
    .replace(FILLER_PREFIXES, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function multiWordMatches(phrase: string, text: string): boolean {
  const words = phrase.split(/\s+/);
  if (words.length < 2) return false;
  // Build a regex that allows 0-1 non-letter between words,
  // so "thank you" matches "thank-you" and "thank you," but
  // not "thank  you" (collapsed already) or "thankxyzou".
  const parts = words.map(escapeRe);
  const re = new RegExp(parts.join('[^a-z0-9]?'), 'i');
  return re.test(text);
}

function singleWordMatches(phrase: string, text: string): boolean {
  // Word-boundary substring on the phrase.
  const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i');
  return re.test(text);
}

export function matchExitPhrase(transcribed: string, phrases: string[]): string | null {
  if (!transcribed || !phrases || phrases.length === 0) return null;
  const norm = normalize(transcribed);
  if (!norm) return null;
  for (const raw of phrases) {
    const phrase = normalize(raw);
    if (!phrase) continue;
    const matched = phrase.includes(' ')
      ? multiWordMatches(phrase, norm)
      : singleWordMatches(phrase, norm);
    if (matched) return phrase;
  }
  return null;
}
