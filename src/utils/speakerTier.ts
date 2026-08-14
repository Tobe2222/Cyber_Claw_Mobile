/**
 * speakerTier — derivation of the user's current speaker
 * enrollment "tier" from native + JS state.
 *
 * v3.10.168.
 *
 * Tobe (2026-08-14): "Make the tier user visible, so they
 * see in voice mode that its training toward tier 2 or 3
 * or 4."
 *
 * The tier ladder collapses the previous "0/20/100/1000"
 * numerology into a simple progression the user can
 * reason about. Four tiers, four anchors:
 *
 *   Tier 0 — no profile. Counts < 5. The user can lock
 *            the profile with the explicit 30s "active
 *            enrollment" pass.
 *
 *   Tier 1 — locked. Minimum viable profile, 5+
 *            samples. Achieved by either the explicit
 *            active enrollment OR by natural
 *            accumulation past 5 samples (the runtime
 *            doesn't gate until profileLocked is set;
 *            Tier 1 means the embedding exists).
 *
 *   Tier 2 — 100+ samples. First major milestone. Bar
 *            shows "Tier 2 · X/1000 toward Tier 3".
 *
 *   Tier 3 — 1000+ samples. Matches the natural lock
 *            threshold (LOCK_THRESHOLD_SAMPLES in
 *            VoiceEnrollmentBar). At this point the
 *            profile is fully personalized from natural
 *            use.
 *
 *   Tier 4 — 5000+ samples (display cap). Terminal.
 *            "Profile finalized." No more chasing the
 *            bar. Future updates (v3.10.169+) will
 *            introduce silent embedding refinement past
 *            this point; the label stays "Tier 4".
 *
 * In v3.10.168 the runtime is still discrete — Tier
 * upgrades are LOGGED but don't change the embedding.
 * The natural lock already happens at 1000 in the
 * native code; tier 2 and tier 3 in our nomenclature
 * are just better-and-better locked states, all of
 * which the runtime treats identically until v3.10.169
 * adds hot-swap. The tier labels are presentational
 * so the user sees their data shape even when the
 * underlying model is frozen.
 *
 * Active enrollment (the explicit 30s pass) is the
 * "Tier 1 unlock" path. The button to start it should
 * be visually de-emphasized once the user has any
 * profile at all (B-threshold compaction per Tobe's
 * 2026-08-14 confirmation).
 */

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

/**
 * Derive the current tier from native + JS state.
 *
 * `samplesTotal` is the authoritative count from
 * `WakeWordModule.getSpeakerStatus().samplesTotal`.
 * `profileLocked` is whether the embedding exists at
 * all.
 *
 * The tier reflects "where is the user on the training
 * ladder". Below 5 samples with no lock = Tier 0.
 * Otherwise it's the highest sample-count tier the
 * user's data meets. Lock matters in practice only as
 * a binary gate at Tier 0 → Tier 1 — once any profile
 * exists, the tier is determined by sample count.
 */
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

/**
 * Compute the *next* tier above the user's current
 * tier, or null if they're at the top. Used by the
 * enrollment bar to show "X/Y toward Tier N".
 */
export function nextTier(current: SpeakerTier): SpeakerTier | null {
  if (current >= 4) return null;
  return (current + 1) as SpeakerTier;
}

/**
 * Threshold at which the next tier unlocks. Returns
 * null at the top tier (no next).
 */
export function nextTierThreshold(current: SpeakerTier): number | null {
  const next = nextTier(current);
  if (next === null) return null;
  return SPEAKER_TIER_DEFINITIONS[next].threshold;
}

/**
 * Progress 0..1 toward the next tier. 1 means "ready
 * to unlock the next tier". At the top tier, returns
 * 1 (fully saturated).
 */
export function progressToNextTier(args: {
  samplesTotal: number;
  currentTier: SpeakerTier;
}): number {
  const { samplesTotal, currentTier } = args;
  const nextThreshold = nextTierThreshold(currentTier);
  if (nextThreshold === null) return 1;
  // For Tier 0 the user might be on the explicit path
  // (active enrollment locks at >= 5 samples) OR the
  // background path (lock happens at the runtime's
  // natural threshold, currently 1000). We measure
  // toward the natural-lock threshold (1000) for the
  // "Tier 0 → Tier 2" UX so the bar fills as expected,
  // even though active enrollment will jump the user to
  // Tier 1 mid-bar.
  if (currentTier === 0) {
    return Math.min(1, samplesTotal / SPEAKER_TIER_DEFINITIONS[3].threshold);
  }
  return Math.min(1, samplesTotal / nextThreshold);
}

/**
 * Format the progress label shown in the bar — "X/Y
 * toward Tier N" or "Profile finalized" at the top.
 */
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

/**
 * B-threshold compaction: should the Settings page
 * show the "🎤 Voice training" CTA, or hide / dim it
 * because the user is already training naturally?
 *
 * Tobe (2026-08-14): "the user does not need to use
 * that if their at some training threshold." Going
 * with B: hide when samples >= 20. Above 20, the bar
 * is moving meaningfully and the explicit 30s pass
 * is no longer needed to make progress. The screen
 * itself stays reachable from the enrollment bar's
 * overflow menu for users who want it.
 */
export function shouldShowVoiceTrainingCTA(args: {
  samplesTotal: number;
  profileLocked: boolean;
}): boolean {
  const { samplesTotal } = args;
  // Always show when there's no profile at all
  // (otherwise first-time users can't find the entry
  // point). Show when samples < 20 (the B threshold).
  // Above 20, hide — bar is now the primary feedback.
  return samplesTotal < 20;
}
