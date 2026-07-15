/**
 * VoiceEnrollmentBar — shared visual indicator for the
 * global passive speaker profile.
 *
 * v3.10.24: created (Tobe's v3.10.23 follow-up — "the
 * progress bar was good, just put it in Voice mode
 * settings. Plus a small one in voice mode at the top
 * so one can see it moving up as one uses it").
 *
 * Two sizes that read as the SAME bar:
 *   - "full"   — used in SettingsScreen at the top of
 *                the Voice mode section. ~8px tall,
 *                with a label ("🎙 Learning your voice —
 *                247/1000 samples") above and a
 *                match-score line below when locked.
 *   - "compact" — used at the top of voice-mode screens
 *                (WakeModeScreen, top of the active chat
 *                panel). ~3px tall, no text. The user
 *                sees the fill moving up as they use
 *                voice mode without competing with the
 *                chat UI for attention.
 *
 * Distinct look (so the user can intuite they're the
 * same bar regardless of where they see it):
 *   - Gradient fill: cyan #06b6d4 → emerald #10b981.
 *     The gradient stays in the same direction (left →
 *     right) regardless of fill percentage, so partial
 *     fills look like a clean color sweep rather than
 *     a flat solid color stopping mid-bar.
 *   - Subtle shimmer animation while learning
 *     (translates a translucent highlight across the
 *     bar). Stops the moment the profile locks.
 *   - When locked: solid emerald fill (no shimmer),
 *     with a thin emerald border to visually confirm
 *     the lock state at a glance.
 *
 * Native side already exposes everything needed via
 * `WakeWordModule.getSpeakerStatus()` — returns
 * `{samplesTotal, bufferSize, hasEnrollment,
 * profileLocked, confirmedWakeFires, matchScore}`.
 * This component polls it every 2s while mounted.
 *
 * No JS-side auto-lock logic — the native side owns
 * the threshold (1000 samples OR 5 confirmed wakes,
 * whichever first). The JS side just renders.
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  NativeModules,
} from 'react-native';

const { WakeWordModule } = NativeModules;

type SpeakerStatus = {
  samplesTotal: number;
  bufferSize: number;
  hasEnrollment: boolean;
  profileLocked: boolean;
  confirmedWakeFires: number;
  matchScore: number | null;
};

// Native-side thresholds. Mirrored here for the UI math
// only — the native side is the single source of truth
// for actual locking. If these drift, the UI is wrong
// but the gate is correct.
const LOCK_THRESHOLD_SAMPLES = 1000;
const LOCK_THRESHOLD_WAKES = 5;
const POLL_INTERVAL_MS = 2000;

type Variant = 'full' | 'compact';

export default function VoiceEnrollmentBar({ variant = 'full' }: { variant?: Variant }) {
  const [status, setStatus] = useState<SpeakerStatus | null>(null);
  const cancelledRef = useRef(false);

  // Shimmer animation. Active while learning; stopped
  // when locked.
  const shimmerX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status?.profileLocked) {
      // Locked: stop shimmer, leave the bar solid green.
      shimmerX.stopAnimation();
      shimmerX.setValue(0);
      return;
    }
    // Loop a translucent highlight across the bar.
    // 1.6s loop, easeInOut for a smooth sweep.
    const loop = Animated.loop(
      Animated.timing(shimmerX, {
        toValue: 1,
        duration: 1600,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [status?.profileLocked, shimmerX]);

  // Poll native status. Cheap native call (in-memory
  // read). 2s cadence — fast enough that the bar
  // visibly moves while learning, slow enough to
  // not flood the bridge.
  useEffect(() => {
    cancelledRef.current = false;
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const s = await WakeWordModule?.getSpeakerStatus?.();
        if (!cancelledRef.current && s) {
          setStatus({
            samplesTotal: s.samplesTotal ?? 0,
            bufferSize: s.bufferSize ?? 0,
            hasEnrollment: !!s.hasEnrollment,
            profileLocked: !!s.profileLocked,
            confirmedWakeFires: s.confirmedWakeFires ?? 0,
            matchScore: typeof s.matchScore === 'number' ? s.matchScore : null,
          });
        }
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  if (!status) {
    // Initial render before first poll — render a
    // zero-progress empty bar to reserve space. Avoids
    // layout shift when status arrives.
    return <BarShell variant={variant} progress={0} shimmerX={shimmerX} locked={false} label={null} matchScore={null} />;
  }

  // Compute progress %. Either threshold reaching first
  // counts as "complete". We take the MAX of the two
  // ratios so the bar fills smoothly even as the
  // alternative threshold is still climbing. Each wake
  // fire represents a much bigger commitment than a
  // background sample (the user actively spoke the wake
  // word + actually said something), so 5 confirmed
  // wake-fires counts as 100% on its own — the wake
  // path can complete the bar faster than the sample
  // path alone would.
  const samplePct = Math.min(1, status.samplesTotal / LOCK_THRESHOLD_SAMPLES);
  const wakePct = Math.min(1, status.confirmedWakeFires / LOCK_THRESHOLD_WAKES);
  const progress = status.profileLocked ? 1 : Math.max(samplePct, wakePct);

  const label = status.profileLocked
    ? `✓ Voice profile locked (${status.samplesTotal} samples)`
    : `🎙 Learning your voice — ${status.samplesTotal}/${LOCK_THRESHOLD_SAMPLES} samples`;

  return (
    <BarShell
      variant={variant}
      progress={progress}
      shimmerX={shimmerX}
      locked={status.profileLocked}
      label={variant === 'full' ? label : null}
      matchScore={variant === 'full' && status.profileLocked ? status.matchScore : null}
    />
  );
}

function BarShell({
  variant,
  progress,
  shimmerX,
  locked,
  label,
  matchScore,
}: {
  variant: Variant;
  progress: number;
  shimmerX: Animated.Value;
  locked: boolean;
  label: string | null;
  matchScore: number | null;
}) {
  const compact = variant === 'compact';
  return (
    <View style={[styles.container, compact ? styles.containerCompact : styles.containerFull]}>
      {label && <Text style={styles.label}>{label}</Text>}
      <View
        style={[
          styles.track,
          compact ? styles.trackCompact : styles.trackFull,
          locked && styles.trackLocked,
        ]}
      >
        <View
          style={[
            styles.fill,
            { width: `${progress * 100}%` },
            locked && styles.fillLocked,
          ]}
        >
          {!locked && (
            // Shimmer overlay. Translates a highlight
            // gradient from off-left to off-right.
            <Animated.View
              style={[
                styles.shimmer,
                {
                  transform: [
                    {
                      translateX: shimmerX.interpolate({
                        inputRange: [0, 1],
                        // Bar is variable width, but the
                        // shimmer travels its own width.
                        // Use a fixed range that's wider
                        // than any plausible bar so the
                        // shimmer fully exits.
                        outputRange: [-120, 240],
                      }),
                    },
                  ],
                },
              ]}
              pointerEvents="none"
            />
          )}
        </View>
      </View>
      {variant === 'full' && locked && matchScore !== null && (
        <Text style={styles.matchNote}>
          Current speaker match: {(matchScore * 100 | 0)}% — wake fires below the threshold are suppressed.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  containerFull: {
    marginTop: 4,
    marginBottom: 14,
  },
  containerCompact: {
    marginBottom: 0,
  },
  label: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  track: {
    width: '100%',
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.20)',
  },
  trackFull: {
    height: 8,
  },
  trackCompact: {
    height: 3,
    borderWidth: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  trackLocked: {
    borderColor: 'rgba(16, 185, 129, 0.55)',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
  },
  fill: {
    height: '100%',
    // Cyan fill while learning — distinct from the
    // emerald it becomes when locked. Combined with
    // the shimmer animation, this gives the bar a
    // "loading" feel that matches the "still learning"
    // state. When locked, fillLocked swaps to solid
    // emerald (#10b981).
    backgroundColor: '#06b6d4',
    borderRadius: 999,
  },
  fillLocked: {
    backgroundColor: '#10b981',
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 80,
    // Translucent white highlight. Translates across
    // the bar via the parent's translateX.
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    borderRadius: 999,
  },
  matchNote: {
    color: '#9aa0b4',
    fontSize: 11,
    marginTop: 6,
    fontStyle: 'italic',
  },
});