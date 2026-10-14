/** EXIT PHRASE MATCHER — v3.2.17 Pure-JS, offline. */

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
