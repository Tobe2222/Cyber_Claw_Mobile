/** ActiveEnrollmentPanel — v3.10.62 Lets the user lock their speaker profile in ~30 seconds via a dedicated recording pass, instead of… */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { NativeModules, NativeEventEmitter } from 'react-native';

const { WakeWordModule, NativeBackground } = NativeModules;

// Native side emits `activeEnrollmentStopped` whenever the 30s auto-stop fires (and also on manual stop for consistency).
const enrollmentEvents = WakeWordModule
  ? new NativeEventEmitter(WakeWordModule)
  : null;

function showEnrollmentToast(message: string) {
  // Mirror the pattern HomeScreen uses for wake toasts.
  NativeBackground?.showToast?.(message)?.catch?.(() => {});
}

const DEFAULT_DURATION_MS = 30000;
const POLL_INTERVAL_MS = 500;

// Paragraph the user reads during enrollment.
const ENROLLMENT_PARA = `The quick brown fox jumps over the lazy dog. ` +
  `Pack my box with five dozen liquor jugs. ` +
  `How vexingly quick daft zebras jump. ` +
  `Sphinx of black quartz, judge my vow. ` +
  `My voice is unique and my companion is learning it. ` +
  `Read this naturally at your normal pace and volume.`;

interface EnrollmentStatus {
  samplesTotal: number;
  hasEnrollment: boolean;
  profileLocked: boolean;
  matchScore: number | null;
}

export default function ActiveEnrollmentPanel() {
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [lastResult, setLastResult] = useState<{ locked: boolean; matchScore: number | null } | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial status fetch + post-action refresh
  const refreshStatus = useCallback(async () => {
    try {
      const s = await WakeWordModule?.getSpeakerStatus?.();
      if (s) setStatus(s);
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Pulse animation while recording
  useEffect(() => {
    if (!running) {
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [running, pulseAnim]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (tickTimer.current) clearInterval(tickTimer.current);
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      // Best-effort: stop enrollment if leaving the panel v3.10.167: optional-chain .catch() too — the previous form crashed with `Cannot read…
      WakeWordModule?.stopActiveEnrollment?.()?.catch?.(() => {});
    };
  }, []);

  // React to native-side `activeEnrollmentStopped` event.
  const stoppedRef = useRef(false);
  useEffect(() => {
    if (!enrollmentEvents) return;
    const sub = enrollmentEvents.addListener(
      'activeEnrollmentStopped',
      (event: { reason?: string } | null) => {
        const reason = event?.reason || 'manual';
        if (tickTimer.current) {
          clearInterval(tickTimer.current);
          tickTimer.current = null;
        }
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
        if (watchdogRef.current) {
          clearTimeout(watchdogRef.current);
          watchdogRef.current = null;
        }
        // Only flip if we still think we're running —
        // otherwise a stale event after unmount could
        // double-fire the toast.
        if (!stoppedRef.current) {
          stoppedRef.current = true;
          // Reset on the next tick so a manual
          // stopEnrollment() that lands in the same
          // microtask doesn't see running=true.
          setTimeout(() => {
            stoppedRef.current = false;
          }, 0);
          if (reason === 'auto') {
            showEnrollmentToast(
              '✅ Listening complete — review and lock profile',
            );
          } else {
            showEnrollmentToast('⏹ Stopped');
          }
          setRunning(false);
          refreshStatus();
        }
      },
    );
    return () => sub.remove();
  }, [refreshStatus]);

  const startEnrollment = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setElapsedMs(0);
    setLastResult(null);
    const start = Date.now();
    // JS-side watchdog.
    const watchdog = setTimeout(() => {
      if (running) {
        try {
          // v3.10.167: optional-chain .catch() — see line 130
          // for the Stop-crash context.
          WakeWordModule?.stopActiveEnrollment?.()?.catch?.(() => {});
        } catch (_) {}
      }
    }, DEFAULT_DURATION_MS + 3000);
    try {
      await WakeWordModule?.startActiveEnrollment?.(DEFAULT_DURATION_MS);
    } catch (e: any) {
      Alert.alert('Could not start', e?.message || 'Failed to start active enrollment');
      clearTimeout(watchdog);
      setRunning(false);
      return;
    }
    // Tick for the elapsed-time display
    tickTimer.current = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, POLL_INTERVAL_MS);
    // Poll speaker status to show live sample count
    pollTimer.current = setInterval(() => {
      refreshStatus();
    }, POLL_INTERVAL_MS * 2);
    // Save the watchdog so stopEnrollment can clear it.
    watchdogRef.current = watchdog;
  }, [running, refreshStatus]);

  const stopEnrollment = useCallback(async () => {
    if (!running) return;
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    try {
      await WakeWordModule?.stopActiveEnrollment?.();
    } catch (_) {}
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (pollTimer.current) clearInterval(pollTimer.current);
    setRunning(false);
    await refreshStatus();
  }, [running, refreshStatus]);

  const lockProfile = useCallback(async () => {
    try {
      const ok = await WakeWordModule?.forceLockSpeakerProfile?.();
      if (ok) {
        setLastResult({ locked: true, matchScore: null });
        await refreshStatus();
        const s = await WakeWordModule?.getSpeakerStatus?.();
        if (s) setLastResult({ locked: true, matchScore: s.matchScore });
      } else {
        Alert.alert('Lock failed', 'Profile could not be locked');
      }
    } catch (e: any) {
      // Surface the actual error message — usually
      // TOO_FEW_SAMPLES (need to speak more) or the
      // detector failed to initialize.
      Alert.alert('Could not lock profile', e?.message || 'Unknown error');
    }
  }, [refreshStatus]);

  const clearProfile = useCallback(async () => {
    Alert.alert(
      'Clear speaker profile?',
      'This removes your enrolled voice. The speaker gate will go inactive until enough voice activity accumulates again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await WakeWordModule?.clearSpeakerEnrollment?.();
              await refreshStatus();
            } catch (_) {}
          },
        },
      ],
    );
  }, [refreshStatus]);

  const elapsedSec = Math.floor(elapsedMs / 1000);
  const totalSec = Math.floor(DEFAULT_DURATION_MS / 1000);
  const remainingSec = Math.max(0, totalSec - elapsedSec);
  const progress = Math.min(1, elapsedMs / DEFAULT_DURATION_MS);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🎙️ Voice enrollment</Text>
      <Text style={styles.subtitle}>
        Train the app to recognize your voice. After this, the wake word only fires for you.
      </Text>

      {/* Status panel — always visible */}
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Profile:</Text>
        <Text style={[
          styles.statusValue,
          status?.profileLocked ? styles.statusValueGood : null,
        ]}>
          {status?.profileLocked ? '🔒 locked' : status?.hasEnrollment ? '🔓 unlocked' : '— none yet'}
        </Text>
      </View>
      {status?.samplesTotal !== undefined && !status?.profileLocked && (
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Voice-active samples:</Text>
          <Text style={styles.statusValue}>{status.samplesTotal}</Text>
        </View>
      )}
      {status?.matchScore !== null && status?.matchScore !== undefined && (
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Match score:</Text>
          <Text style={[
            styles.statusValue,
            status.matchScore >= 0.5 ? styles.statusValueGood : styles.statusValueBad,
          ]}>
            {(status.matchScore * 100).toFixed(0)}%
            {status.matchScore >= 0.5 ? ' ✓' : ' ⚠️'}
          </Text>
        </View>
      )}

      {/* Recording UI */}
      {!running && !status?.profileLocked && (
        <>
          <Animated.View style={[styles.recordBtn, { transform: [{ scale: pulseAnim }] }]}>
            <TouchableOpacity
              style={styles.recordInner}
              onPress={startEnrollment}
              activeOpacity={0.7}
              disabled={running}
            >
              <Text style={styles.recordIcon}>🎤</Text>
              <Text style={styles.recordHint}>
                {status?.hasEnrollment ? 'Re-train voice (30s)' : 'Train voice (30s)'}
              </Text>
            </TouchableOpacity>
          </Animated.View>
          <Text style={styles.paraHint}>
            Read this naturally at your normal pace:
          </Text>
          <ScrollView style={styles.paraBox} contentContainerStyle={styles.paraContent}>
            <Text style={styles.paraText}>{ENROLLMENT_PARA}</Text>
          </ScrollView>
        </>
      )}

      {running && (
        <>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={styles.progressLabel}>
            🔴 Listening… {elapsedSec}s / {totalSec}s (auto-stop at {totalSec}s)
          </Text>
          <Text style={styles.paraHint}>Read the paragraph aloud:</Text>
          <ScrollView style={styles.paraBox} contentContainerStyle={styles.paraContent}>
            <Text style={styles.paraText}>{ENROLLMENT_PARA}</Text>
          </ScrollView>
          <TouchableOpacity style={styles.stopBtn} onPress={stopEnrollment} activeOpacity={0.7}>
            <Text style={styles.stopBtnText}>⏹ Stop early</Text>
          </TouchableOpacity>
        </>
      )}

      {/* After recording, show lock button */}
      {!running && status && status.samplesTotal >= 50 && !status.profileLocked && (
        <TouchableOpacity style={styles.lockBtn} onPress={lockProfile} activeOpacity={0.7}>
          <Text style={styles.lockBtnText}>
            ✓ Lock profile ({status.samplesTotal} samples)
          </Text>
        </TouchableOpacity>
      )}

      {/* Result feedback */}
      {lastResult && (
        <View style={lastResult.locked ? styles.resultGood : styles.resultBad}>
          <Text style={styles.resultText}>
            {lastResult.locked
              ? `✓ Profile locked! Match score: ${
                  lastResult.matchScore !== null
                    ? `${(lastResult.matchScore * 100).toFixed(0)}%`
                    : 'measuring…'
                }`
              : 'Lock failed. Try again in a quieter room.'}
          </Text>
        </View>
      )}

      {/* Locked state — show clear option */}
      {status?.profileLocked && !running && (
        <View style={styles.lockedRow}>
          <Text style={styles.lockedHint}>
            ✓ Speaker gate active. The wake word only fires for you.
          </Text>
          <TouchableOpacity style={styles.clearBtn} onPress={clearProfile} activeOpacity={0.7}>
            <Text style={styles.clearBtnText}>Clear profile</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Already-locked + want to retrain */}
      {status?.profileLocked && !running && (
        <TouchableOpacity
          style={styles.retrainBtn}
          onPress={startEnrollment}
          activeOpacity={0.7}
        >
          <Text style={styles.retrainBtnText}>🎤 Re-train voice</Text>
        </TouchableOpacity>
      )}

      {/* Strict mode toggle — visible always (not just
          when locked). Strict mode drops Vosk once the
          profile is locked, saving battery. The toggle
          is informational even before lock. */}
      <StrictModeToggle locked={status?.profileLocked ?? false} />
    </View>
  );
}

/** Strict mode toggle. */
function StrictModeToggle({ locked }: { locked: boolean }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // Optional-chain the .then().catch() chain too.
    const p = WakeWordModule?.getBgStrictMode?.();
    p?.then?.((v: boolean) => setEnabled(!!v))?.catch?.(() => {});
  }, []);

  const toggle = useCallback(async () => {
    const next = !enabled;
    try {
      await WakeWordModule?.setBgStrictMode?.(next);
      setEnabled(next);
    } catch (_) {}
  }, [enabled]);

  return (
    <View style={styles.strictRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.strictTitle}>Strict mode</Text>
        <Text style={styles.strictHint}>
          {locked
            ? 'Drop Vosk once your profile is locked. Saves battery.'
            : 'Available once your profile is locked.'}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.toggle, enabled && styles.toggleOn, !locked && styles.toggleDisabled]}
        onPress={toggle}
        disabled={!locked}
        activeOpacity={0.7}
      >
        <View style={[styles.toggleKnob, enabled && styles.toggleKnobOn]} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  title: {
    color: '#eee',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  subtitle: {
    color: '#888',
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  statusLabel: {
    color: '#888',
    fontSize: 12,
  },
  statusValue: {
    color: '#ddd',
    fontSize: 13,
    fontWeight: '500',
  },
  statusValueGood: {
    color: '#27ae60',
  },
  statusValueBad: {
    color: '#e67e22',
  },
  recordBtn: {
    marginTop: 12,
    marginBottom: 12,
    alignSelf: 'center',
  },
  recordInner: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: '#1f1f1f',
    borderWidth: 2,
    borderColor: '#e67e22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordIcon: {
    fontSize: 40,
  },
  recordHint: {
    color: '#ccc',
    fontSize: 11,
    marginTop: 4,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: '#1f1f1f',
    borderRadius: 3,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#e67e22',
  },
  progressLabel: {
    color: '#ddd',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  paraHint: {
    color: '#888',
    fontSize: 11,
    marginTop: 4,
    marginBottom: 4,
    fontStyle: 'italic',
  },
  paraBox: {
    maxHeight: 100,
    backgroundColor: '#0a0a0a',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  paraContent: {
    paddingBottom: 4,
  },
  paraText: {
    color: '#aaa',
    fontSize: 12,
    lineHeight: 18,
  },
  stopBtn: {
    backgroundColor: '#c0392b',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  stopBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  lockBtn: {
    backgroundColor: '#27ae60',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  lockBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resultGood: {
    backgroundColor: '#1e3a26',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#27ae60',
  },
  resultBad: {
    backgroundColor: '#3a1e1e',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#c0392b',
  },
  resultText: {
    color: '#fff',
    fontSize: 13,
    textAlign: 'center',
  },
  lockedRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1f1f1f',
  },
  lockedHint: {
    color: '#27ae60',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  clearBtn: {
    backgroundColor: 'transparent',
    borderRadius: 6,
    padding: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  clearBtnText: {
    color: '#888',
    fontSize: 11,
  },
  retrainBtn: {
    backgroundColor: '#1f1f1f',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  retrainBtnText: {
    color: '#ccc',
    fontSize: 13,
    fontWeight: '500',
  },
  // v3.10.64: strict mode toggle styles.
  strictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1f1f1f',
  },
  strictTitle: {
    color: '#eee',
    fontSize: 13,
    fontWeight: '500',
  },
  strictHint: {
    color: '#888',
    fontSize: 11,
    marginTop: 2,
  },
  toggle: {
    width: 44,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#333',
    padding: 2,
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: '#27ae60',
  },
  toggleDisabled: {
    opacity: 0.4,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#888',
  },
  toggleKnobOn: {
    backgroundColor: '#fff',
    transform: [{ translateX: 20 }],
  },
});