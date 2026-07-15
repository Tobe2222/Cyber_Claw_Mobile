/**
 * VoiceEnrollmentBar — shared visual indicator for the
 * global passive speaker profile.
 *
 * v3.10.24: created (Tobe's v3.10.23 follow-up — "the
 * progress bar was good, just put it in Voice mode
 * settings. Plus a small one in voice mode at the top
 * so one can see it moving up as one uses it").
 *
 * v3.10.29: redesigned. Tobe's feedback: "I don't see
 * the learning bar. Actually it's in the top. But we
 * need to style it differently, it looks more like a
 * bug now. Add a small text also for voice mode."
 *
 * The v3.10.24 compact variant was a thin 3px bar with
 * no label. In voice mode that read as a UI bug
 * (especially at 0% fill — looked like an empty track).
 * The settings variant was a bar with a label above but
 * the empty/loading state also looked unfinished.
 *
 * v3.10.29 design:
 *   - compact (voice mode): small PILL at the top
 *     with a mic icon + tiny text label ("🎙 247/1000"
 *     or "🎙 Locked"). The progress is a thin bar
 *     inside the pill, not the pill itself. A subtle
 *     pulse animation (gentle opacity oscillation)
 *     while learning so the user can see it's alive.
 *   - full (settings): keeps the labeled bar layout
 *     but adds a clear "calibrating..." placeholder
 *     while status is loading (instead of an empty
 *     bar that looks like a 0% state).
 *   - locked state: pill becomes solid emerald with
 *     a check icon, no pulse, no shimmer.
 *
 * Same color/animation language so the two variants
 * read as the same indicator: cyan for learning,
 * emerald for locked.
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
  // when locked. Used in the fill bar (both variants).
  const shimmerX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status?.profileLocked) {
      shimmerX.stopAnimation();
      shimmerX.setValue(0);
      return;
    }
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

  // Pulse animation (compact variant only). A gentle
  // opacity oscillation on the chip itself so the user
  // can see the indicator is alive even when progress
  // is at 0%. Disabled when locked.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status?.profileLocked) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status?.profileLocked, pulse]);

  // Poll native status.
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

  // Initial load placeholder: render a "calibrating…"
  // state instead of an empty bar (which looks like a
  // 0% state and confuses the user).
  if (!status) {
    return (
      <BarShell
        variant={variant}
        progress={0}
        shimmerX={shimmerX}
        pulse={pulse}
        locked={false}
        loading={true}
        label={variant === 'full' ? '🎙 Calibrating…' : null}
        matchScore={null}
      />
    );
  }

  // Compute progress % as the max of the two
  // thresholds' ratios.
  const samplePct = Math.min(1, status.samplesTotal / LOCK_THRESHOLD_SAMPLES);
  const wakePct = Math.min(1, status.confirmedWakeFires / LOCK_THRESHOLD_WAKES);
  const progress = status.profileLocked ? 1 : Math.max(samplePct, wakePct);

  // Label is the same content for both variants; the
  // COMPACT pill is a shorter version (just count
  // + threshold, no "Learning your voice" prefix).
  const fullLabel = status.profileLocked
    ? `✓ Voice profile locked (${status.samplesTotal} samples)`
    : `🎙 Learning your voice — ${status.samplesTotal}/${LOCK_THRESHOLD_SAMPLES} samples`;
  const compactLabel = status.profileLocked
    ? `Voice locked`
    : `Learning ${status.samplesTotal}/${LOCK_THRESHOLD_SAMPLES}`;

  return (
    <BarShell
      variant={variant}
      progress={progress}
      shimmerX={shimmerX}
      pulse={pulse}
      locked={status.profileLocked}
      loading={false}
      label={variant === 'full' ? fullLabel : compactLabel}
      matchScore={status.profileLocked ? status.matchScore : null}
    />
  );
}

function BarShell({
  variant,
  progress,
  shimmerX,
  pulse,
  locked,
  loading,
  label,
  matchScore,
}: {
  variant: Variant;
  progress: number;
  shimmerX: Animated.Value;
  pulse: Animated.Value;
  locked: boolean;
  loading: boolean;
  label: string | null;
  matchScore: number | null;
}) {
  const compact = variant === 'compact';

  if (compact) {
    // v3.10.29: small pill with mic icon + label +
    // thin progress bar inside. Pinned to the top of
    // voice-mode screens. The pill itself is the
    // visible surface; the progress bar is INSIDE.
    // Opacity pulses while learning (gentle, 0.85
    // ↔ 1.0 — barely noticeable, just enough to
    // signal "alive" without being distracting).
    return (
      <Animated.View
        style={[
          styles.pill,
          locked && styles.pillLocked,
          !locked && {
            // Pulse: gentle opacity oscillation.
            opacity: pulse.interpolate({
              inputRange: [0, 1],
              outputRange: [0.82, 1.0],
            }),
          },
        ]}
        pointerEvents="none"
      >
        <Text style={[styles.pillIcon, locked && styles.pillIconLocked]}>
          {locked ? '✓' : '🎙'}
        </Text>
        <View style={styles.pillTextWrap}>
          <Text style={[styles.pillLabel, locked && styles.pillLabelLocked]}>
            {label ?? (loading ? 'Calibrating…' : '…')}
          </Text>
          {/* Inner thin progress bar — only show while
              learning (when locked, the pill is the
              indicator). */}
          {!locked && !loading && (
            <View style={styles.pillTrack}>
              <View
                style={[
                  styles.pillTrackFill,
                  { width: `${progress * 100}%` },
                ]}
              />
            </View>
          )}
        </View>
      </Animated.View>
    );
  }

  // Full variant: keep the existing labeled-bar layout
  // but with a clear "calibrating" placeholder for the
  // loading state (instead of an empty bar that looks
  // like 0% fill).
  return (
    <View style={[styles.container, styles.containerFull]}>
      {label && (
        <Text style={[styles.label, loading && styles.labelLoading]}>
          {label}
        </Text>
      )}
      <View
        style={[
          styles.track,
          styles.trackFull,
          locked && styles.trackLocked,
          loading && styles.trackLoading,
        ]}
      >
        {loading ? (
          // Loading state: a flat dim track with a
          // small "calibrating" shimmer. No fill
          // (we don't have a number yet). The
          // shimmer is in the same place the fill
          // would be so the visual is consistent.
          <Animated.View
            style={[
              styles.shimmer,
              {
                transform: [
                  {
                    translateX: shimmerX.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-80, 200],
                    }),
                  },
                ],
              },
            ]}
            pointerEvents="none"
          />
        ) : (
          <View
            style={[
              styles.fill,
              { width: `${progress * 100}%` },
              locked && styles.fillLocked,
            ]}
          >
            {!locked && (
              <Animated.View
                style={[
                  styles.shimmer,
                  {
                    transform: [
                      {
                        translateX: shimmerX.interpolate({
                          inputRange: [0, 1],
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
        )}
      </View>
      {locked && matchScore !== null && (
        <Text style={styles.matchNote}>
          Current speaker match: {(matchScore * 100 | 0)}% — wake fires below the threshold are suppressed.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Full variant styles ──────────────────────────────────
  container: {
    width: '100%',
  },
  containerFull: {
    marginTop: 4,
    marginBottom: 14,
  },
  label: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  labelLoading: {
    color: '#9aa0b4',
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
  trackLocked: {
    borderColor: 'rgba(16, 185, 129, 0.55)',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
  },
  trackLoading: {
    // Loading state: visible dim track with a subtle
    // border so it doesn't look like a 0% empty bar.
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  fill: {
    height: '100%',
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
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    borderRadius: 999,
  },
  matchNote: {
    color: '#9aa0b4',
    fontSize: 11,
    marginTop: 6,
    fontStyle: 'italic',
  },

  // ── Compact (voice mode) pill styles ─────────────────────
  // v3.10.29: a small floating pill, not a full-width
  // bar. The pill is the surface; the progress is
  // a thin strip inside.
  // v3.10.31: larger pill. Tobe's v3.10.30 feedback:
  // "the bar can be longer and slightly bigger for
  // both voice mode and in the settings." Bumped
  // padding 10/5 → 16/8, font 10 → 12, track width
  // 60 → 140, track height 2 → 3. Same color/pulse
  // language, just bigger and more readable.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.45)',
  },
  pillLocked: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: 'rgba(16, 185, 129, 0.55)',
  },
  pillIcon: {
    fontSize: 14,
    color: '#67e8f9',
    marginRight: 8,
  },
  pillIconLocked: {
    color: '#6ee7b7',
  },
  pillTextWrap: {
    flexDirection: 'column',
    minWidth: 140,
  },
  pillLabel: {
    color: '#a5f3fc',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  pillLabelLocked: {
    color: '#a7f3d0',
  },
  pillTrack: {
    marginTop: 4,
    height: 3,
    width: 140,
    backgroundColor: 'rgba(6, 182, 212, 0.20)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  pillTrackFill: {
    height: '100%',
    backgroundColor: '#22d3ee',
    borderRadius: 2,
  },
});