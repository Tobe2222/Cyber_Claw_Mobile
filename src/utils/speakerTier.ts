/** SpeakerTier — derivation of the user's current speaker enrollment "tier" from native + JS state. */

export type SpeakerTier = 0 | 1 | 2 | 3 | 4;

export const SPEAKER_TIER_DEFINITIONS: {
  tier: SpeakerTier;
  threshold: number;
  label: string;
  shortLabel: string;
  description: string;
}[] = [
  {
    tier: 0,
    threshold: 0,
    label: 'Tier 0',
    shortLabel: 'No profile',
    description: "No voice profile yet. The wake word isn't gated to your voice.",
  },
  {
    tier: 1,
    threshold: 5,
    label: 'Tier 1',
    shortLabel: 'Locked',
    description: 'Voice profile locked. The wake word only fires for your voice. Minimum viable.',
  },
  {
    tier: 2,
    threshold: 100,
    label: 'Tier 2',
    shortLabel: 'Better matched',
    description: '100+ samples. The profile has enough data to discriminate you from close voices.',
  },
  {
    tier: 3,
    threshold: 1000,
    label: 'Tier 3',
    shortLabel: 'Fully personal',
    description: '1000+ samples. The natural lock threshold — fully personalized from use.',
  },
  {
    tier: 4,
    threshold: 5000,
    label: 'Tier 4',
    shortLabel: 'Finalized',
    description: '5000+ samples. Profile finalized. No further refinement.',
  },
];

/** Derive the current tier from native + JS state. */
export function deriveSpeakerTier(args: {
  samplesTotal: number;
  profileLocked: boolean;
}): SpeakerTier {
  const { samplesTotal, profileLocked } = args;
  if (!profileLocked && samplesTotal < 5) return 0;
  if (samplesTotal >= SPEAKER_TIER_DEFINITIONS[4].threshold) return 4;
  if (samplesTotal >= SPEAKER_TIER_DEFINITIONS[3].threshold) return 3;
  if (samplesTotal >= SPEAKER_TIER_DEFINITIONS[2].threshold) return 2;
  return 1;
}

/** Compute the *next* tier above the user's current tier, or null if they're at the top. */
export function nextTier(current: SpeakerTier): SpeakerTier | null {
  if (current >= 4) return null;
  return (current + 1) as SpeakerTier;
}

/** Threshold at which the next tier unlocks. */
export function nextTierThreshold(current: SpeakerTier): number | null {
  const next = nextTier(current);
  if (next === null) return null;
  return SPEAKER_TIER_DEFINITIONS[next].threshold;
}

/** Progress 0..1 toward the next tier. */
export function progressToNextTier(args: {
  samplesTotal: number;
  currentTier: SpeakerTier;
}): number {
  const { samplesTotal, currentTier } = args;
  const nextThreshold = nextTierThreshold(currentTier);
  if (nextThreshold === null) return 1;
  // For Tier 0 the user might be on the explicit path (active enrollment locks at >= 5 samples) OR the background path (lock happens at the…
  if (currentTier === 0) {
    return Math.min(1, samplesTotal / SPEAKER_TIER_DEFINITIONS[3].threshold);
  }
  return Math.min(1, samplesTotal / nextThreshold);
}

/** Format the progress label shown in the bar — "X/Y toward Tier N" or "Profile finalized" at the top. */
export function tierProgressLabel(args: {
  samplesTotal: number;
  currentTier: SpeakerTier;
}): string {
  const { samplesTotal, currentTier } = args;
  const next = nextTier(currentTier);
  if (next === null) {
    return 'Profile finalized';
  }
  const nextThreshold = nextTierThreshold(currentTier)!;
  const capped = Math.min(samplesTotal, nextThreshold);
  const nextDef = SPEAKER_TIER_DEFINITIONS[next];
  return `${capped.toLocaleString()}/${nextThreshold.toLocaleString()} toward ${nextDef.label}`;
}

/** B-threshold compaction: should the Settings page show the "🎤 Voice training" CTA, or hide / dim it because the user is already training… */
export function shouldShowVoiceTrainingCTA(args: {
  samplesTotal: number;
  profileLocked: boolean;
}): boolean {
  const { samplesTotal } = args;
  // Always show when there's no profile at all (otherwise first-time users can't find the entry point).
  return samplesTotal < 20;
}
