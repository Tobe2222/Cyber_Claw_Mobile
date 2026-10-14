/** VoiceEnrollmentBar — shared visual indicator for the global passive speaker profile. */

import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  NativeModules,
  TouchableOpacity,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SpeakerTier,
  deriveSpeakerTier,
  progressToNextTier,
  tierProgressLabel,
} from '../utils/speakerTier';

const { WakeWordModule } = NativeModules;

type SpeakerStatus = {
  samplesTotal: number;
  activeContributions: number;
  bufferSize: number;
  hasEnrollment: boolean;
  profileLocked: boolean;
  confirmedWakeFires: number;
  matchScore: number | null;
};

const ACTIVE_CONTRIBUTIONS_KEY = 'cyberclaw-voice-enrollment-active';
const ACTIVE_CONTRIBUTION_PER_TURN = 1;  // v3.10.38: was 50, now 1 per turn (Tobe: 'should count 1 by 1')

// Native-side thresholds.
const LOCK_THRESHOLD_SAMPLES = 1000;
const LOCK_THRESHOLD_WAKES = 5;
const POLL_INTERVAL_MS = 2000;

// Active-only threshold for compact bar in voice mode.
const ACTIVE_LOCK_THRESHOLD = 100;

type Variant = 'full' | 'compact';
type Mode = 'combined' | 'active-only';

export default function VoiceEnrollmentBar({
  variant = 'full',
  mode = 'combined',
  onPress,
}: {
  variant?: Variant;
  mode?: Mode;
  // Optional tap handler.
  onPress?: () => void;
}) {
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

  // Pulse animation (compact variant only).
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

  // Poll native status + the JS-side active-contributions counter (v3.10.35).
  useEffect(() => {
    cancelledRef.current = false;
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const [nativeResult, activeRaw] = await Promise.all([
          WakeWordModule?.getSpeakerStatus?.(),
          AsyncStorage.getItem(ACTIVE_CONTRIBUTIONS_KEY).catch(() => null),
        ]);
        const activeCount = activeRaw ? parseInt(activeRaw, 10) : 0;
        if (!cancelledRef.current && nativeResult) {
          setStatus({
            samplesTotal: nativeResult.samplesTotal ?? 0,
            activeContributions: !isNaN(activeCount) ? activeCount : 0,
            bufferSize: nativeResult.bufferSize ?? 0,
            hasEnrollment: !!nativeResult.hasEnrollment,
            profileLocked: !!nativeResult.profileLocked,
            confirmedWakeFires: nativeResult.confirmedWakeFires ?? 0,
            matchScore: typeof nativeResult.matchScore === 'number' ? nativeResult.matchScore : null,
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

  // Compute progress % as the max of the two thresholds' ratios.
  const samplePct = Math.min(1, status.samplesTotal / LOCK_THRESHOLD_SAMPLES);
  const wakePct = Math.min(1, status.confirmedWakeFires / LOCK_THRESHOLD_WAKES);
  const activePct = Math.min(1, status.activeContributions / LOCK_THRESHOLD_SAMPLES);
  const combinedPct = Math.min(1, (status.samplesTotal + status.activeContributions) / LOCK_THRESHOLD_SAMPLES);
  const activeOnlyPct = Math.min(1, status.activeContributions / ACTIVE_LOCK_THRESHOLD);
  const displayProgress = mode === 'active-only'
    ? activeOnlyPct
    : Math.max(samplePct, wakePct, activePct, combinedPct);
  // Kept around in case a future caller wants the legacy "max-of-buckets" display (e.g.
  const _legacyProgress = status.profileLocked ? 1 : displayProgress;

  // Combined display per Tobe's report: "the learning bar says 0+50/1000 ...
  const combinedCount = status.samplesTotal + status.activeContributions;
  const showActive = status.activeContributions > 0;
  // Label is the same content for both variants; the COMPACT pill is a shorter version (just count + threshold, no "Learning your voice"…
  const activeCapped = Math.min(status.activeContributions, ACTIVE_LOCK_THRESHOLD);
  const combinedCapped = Math.min(combinedCount, LOCK_THRESHOLD_SAMPLES);
  const samplesCapped = Math.min(status.samplesTotal, LOCK_THRESHOLD_SAMPLES);
  // Tier labels replace the old "Learning X/Y" / "Voice profile locked" numerology.
  const tier: SpeakerTier = deriveSpeakerTier({
    samplesTotal: status.samplesTotal,
    profileLocked: status.profileLocked,
  });
  // Per-variant label strings.
  const tierDisplay = `🎯 Tier ${tier}`;
  const tierProgress = tierProgressLabel({
    samplesTotal: status.samplesTotal,
    currentTier: tier,
  });
  const fullLabel = status.profileLocked
    ? `✓ ${tierDisplay} · ${tierProgress}`
    : tier === 0
      ? `🎙 ${tierDisplay} — start training to lock`
      : mode === 'active-only'
        ? `🎙 ${tierDisplay} · Learning — ${activeCapped}/${ACTIVE_LOCK_THRESHOLD}`
        : showActive
          ? `${tierDisplay} · ${tierProgress}   🎤 ${status.activeContributions} chats`
          : `${tierDisplay} · ${tierProgress}`;
  const compactLabel = status.profileLocked
    ? `${tierDisplay} · locked`
    : tier === 0
      ? `${tierDisplay} · Start →`
      : mode === 'active-only'
        ? `${tierDisplay} · ${activeCapped}/${ACTIVE_LOCK_THRESHOLD}`
        : `${tierDisplay} · ${tierProgress}`;

  return (
    <BarShell
      variant={variant}
      progress={progressToNextTier({
        samplesTotal: status.samplesTotal,
        currentTier: tier,
      })}
      shimmerX={shimmerX}
      pulse={pulse}
      locked={status.profileLocked}
      loading={false}
      label={variant === 'full' ? fullLabel : compactLabel}
      matchScore={status.profileLocked ? status.matchScore : null}
      onPress={onPress}
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
  onPress,
}: {
  variant: Variant;
  progress: number;
  shimmerX: Animated.Value;
  pulse: Animated.Value;
  locked: boolean;
  loading: boolean;
  label: string | null;
  matchScore: number | null;
  onPress?: () => void;
}) {
  const compact = variant === 'compact';

  if (compact) {
    // Small pill with mic icon + label + thin progress bar inside.
    const pillInner = (
      <Animated.View
        style={[
          styles.pill,
          locked && styles.pillLocked,
          !locked && !onPress && {
            // Pulse: gentle opacity oscillation.
            // Disabled when pressable so the touch
            // surface feels stable.
            opacity: pulse.interpolate({
              inputRange: [0, 1],
              outputRange: [0.82, 1.0],
            }),
          },
        ]}
        pointerEvents={onPress ? 'auto' : 'none'}
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
    if (onPress) {
      return (
        <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
          {pillInner}
        </TouchableOpacity>
      );
    }
    return pillInner;
  }

  // Full variant: keep the existing labeled-bar layout but with a clear "calibrating" placeholder for the loading state (instead of an empty…
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
          // Loading state: a flat dim track with a small "calibrating" shimmer.
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

  // ── Compact (voice mode) pill styles ───────────────────── v3.10.29: a small floating pill, not a full-width bar.
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