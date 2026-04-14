/**
 * WakeWordTrainer — Record 3 samples of the wake phrase for recognition training.
 * 
 * Flow:
 *   1. User types or confirms the wake phrase text
 *   2. Records 3 samples (tap to start, tap to stop)
 *   3. Each sample is validated (duration, volume)
 *   4. Checkmark when good, error icon if too short/quiet
 *   5. All 3 good → saves samples for wake word matching
 */

import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const WAKE_SAMPLES_KEY = 'cyberclaw-wake-samples';

const REQUIRED_SAMPLES = 3;
const MIN_DURATION_MS = 500;   // At least 0.5s
const MAX_DURATION_MS = 5000;  // Max 5s

type SampleStatus = 'pending' | 'recording' | 'good' | 'error';

interface SampleState {
  status: SampleStatus;
  path: string | null;
  duration: number;
  error: string | null;
}

interface Props {
  wakePhrase: string;
  onComplete: (samplePaths: string[]) => void;
}

export default function WakeWordTrainer({ wakePhrase, onComplete }: Props) {
  const [samples, setSamples] = useState<SampleState[]>(
    Array(REQUIRED_SAMPLES).fill(null).map(() => ({
      status: 'pending' as SampleStatus,
      path: null,
      duration: 0,
      error: null,
    }))
  );
  const [currentSample, setCurrentSample] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const recordStartRef = useRef<number>(0);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  // Start pulse animation when recording
  const startPulse = () => {
    pulseRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    pulseRef.current.start();
  };

  const stopPulse = () => {
    if (pulseRef.current) pulseRef.current.stop();
    pulseAnim.setValue(1);
  };

  const startRecording = useCallback(async () => {
    if (isRecording) return;

    setIsRecording(true);
    recordStartRef.current = Date.now();
    startPulse();

    // Update sample status
    setSamples(prev => {
      const next = [...prev];
      next[currentSample] = { ...next[currentSample], status: 'recording', error: null };
      return next;
    });

    // Note: Actual audio recording will use react-native-audio-recorder-player
    // or expo-av. For now we track the timing and simulate the flow.
    // The native recording module will be integrated in the next step.
  }, [isRecording, currentSample]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;

    stopPulse();
    setIsRecording(false);

    const duration = Date.now() - recordStartRef.current;
    const samplePath = `wake_sample_${currentSample}.wav`;  // Placeholder path until RNFS integrated

    // Validate duration
    let status: SampleStatus = 'good';
    let error: string | null = null;

    if (duration < MIN_DURATION_MS) {
      status = 'error';
      error = 'Too short — hold for at least 0.5 seconds';
    } else if (duration > MAX_DURATION_MS) {
      status = 'error';
      error = 'Too long — keep it under 5 seconds';
    }

    // TODO: Volume validation will be added with actual audio recording
    // Check RMS level of the recording to ensure it's not silence

    setSamples(prev => {
      const next = [...prev];
      next[currentSample] = { status, path: status === 'good' ? samplePath : null, duration, error };
      return next;
    });

    if (status === 'good') {
      const nextSample = currentSample + 1;
      if (nextSample >= REQUIRED_SAMPLES) {
        // All samples collected!
        const paths = samples.map((s, i) => 
          i < currentSample ? s.path! : samplePath
        ).filter(Boolean) as string[];
        
        // Save sample info
        await AsyncStorage.setItem(WAKE_SAMPLES_KEY, JSON.stringify({
          phrase: wakePhrase,
          samplePaths: [...paths],
          trainedAt: new Date().toISOString(),
        }));

        setTimeout(() => onComplete([...paths]), 500);
      } else {
        setCurrentSample(nextSample);
      }
    }
  }, [isRecording, currentSample, samples, wakePhrase, onComplete]);

  const retryCurrentSample = () => {
    setSamples(prev => {
      const next = [...prev];
      next[currentSample] = { status: 'pending', path: null, duration: 0, error: null };
      return next;
    });
  };

  const resetAll = () => {
    setCurrentSample(0);
    setSamples(
      Array(REQUIRED_SAMPLES).fill(null).map(() => ({
        status: 'pending' as SampleStatus,
        path: null,
        duration: 0,
        error: null,
      }))
    );
  };

  const allGood = samples.every(s => s.status === 'good');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🎤 Train Wake Phrase</Text>
      <Text style={styles.phrase}>"{wakePhrase}"</Text>
      <Text style={styles.instructions}>
        Say the phrase {REQUIRED_SAMPLES} times. Tap the button to start and stop each recording.
      </Text>

      {/* Sample indicators */}
      <View style={styles.samplesRow}>
        {samples.map((sample, idx) => (
          <View key={idx} style={styles.sampleItem}>
            <View style={[
              styles.sampleCircle,
              sample.status === 'good' && styles.sampleGood,
              sample.status === 'error' && styles.sampleError,
              sample.status === 'recording' && styles.sampleRecording,
              idx === currentSample && sample.status === 'pending' && styles.sampleActive,
            ]}>
              {sample.status === 'good' && <Text style={styles.sampleIcon}>✓</Text>}
              {sample.status === 'error' && <Text style={styles.sampleIcon}>✕</Text>}
              {sample.status === 'recording' && <Text style={styles.sampleIcon}>●</Text>}
              {sample.status === 'pending' && <Text style={styles.sampleNumber}>{idx + 1}</Text>}
            </View>
            {sample.error && (
              <Text style={styles.sampleErrorText} numberOfLines={2}>{sample.error}</Text>
            )}
            {sample.status === 'good' && (
              <Text style={styles.sampleDuration}>{(sample.duration / 1000).toFixed(1)}s</Text>
            )}
          </View>
        ))}
      </View>

      {/* Record button */}
      {!allGood && (
        <View style={styles.recordSection}>
          <Animated.View style={[styles.recordBtnOuter, { transform: [{ scale: pulseAnim }] }]}>
            <TouchableOpacity
              style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
              onPress={isRecording ? stopRecording : startRecording}
              activeOpacity={0.7}
            >
              {isRecording ? (
                <View style={styles.stopSquare} />
              ) : (
                <View style={styles.recordDot} />
              )}
            </TouchableOpacity>
          </Animated.View>
          <Text style={styles.recordLabel}>
            {isRecording ? 'Tap to stop' : `Record sample ${currentSample + 1} of ${REQUIRED_SAMPLES}`}
          </Text>
        </View>
      )}

      {/* Retry / Reset buttons */}
      {samples[currentSample]?.status === 'error' && (
        <TouchableOpacity style={styles.retryBtn} onPress={retryCurrentSample}>
          <Text style={styles.retryText}>🔄 Try again</Text>
        </TouchableOpacity>
      )}

      {allGood && (
        <View style={styles.successSection}>
          <Text style={styles.successIcon}>✅</Text>
          <Text style={styles.successText}>
            Wake phrase trained! Your companion will listen for "{wakePhrase}".
          </Text>
        </View>
      )}

      {(currentSample > 0 || samples.some(s => s.status !== 'pending')) && !allGood && (
        <TouchableOpacity style={styles.resetBtn} onPress={resetAll}>
          <Text style={styles.resetText}>Start over</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  title: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  phrase: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginVertical: 12,
    fontStyle: 'italic',
  },
  instructions: {
    color: '#888',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 18,
  },
  samplesRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginBottom: 20,
  },
  sampleItem: {
    alignItems: 'center',
    width: 70,
  },
  sampleCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#222',
    borderWidth: 2,
    borderColor: '#444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sampleActive: {
    borderColor: '#f7931a',
  },
  sampleGood: {
    backgroundColor: 'rgba(34,197,94,0.2)',
    borderColor: '#22c55e',
  },
  sampleError: {
    backgroundColor: 'rgba(239,68,68,0.2)',
    borderColor: '#ef4444',
  },
  sampleRecording: {
    backgroundColor: 'rgba(239,68,68,0.3)',
    borderColor: '#ef4444',
  },
  sampleIcon: {
    fontSize: 22,
    color: '#fff',
    fontWeight: 'bold',
  },
  sampleNumber: {
    color: '#666',
    fontSize: 18,
    fontWeight: 'bold',
  },
  sampleErrorText: {
    color: '#ef4444',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 4,
  },
  sampleDuration: {
    color: '#4ade80',
    fontSize: 11,
    marginTop: 4,
  },
  recordSection: {
    alignItems: 'center',
    marginBottom: 12,
  },
  recordBtnOuter: {
    marginBottom: 8,
  },
  recordBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#222',
    borderWidth: 3,
    borderColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordBtnActive: {
    backgroundColor: 'rgba(239,68,68,0.2)',
  },
  recordDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ef4444',
  },
  stopSquare: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
  recordLabel: {
    color: '#888',
    fontSize: 13,
  },
  retryBtn: {
    alignSelf: 'center',
    padding: 10,
    marginTop: 4,
  },
  retryText: {
    color: '#f7931a',
    fontSize: 14,
  },
  successSection: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  successIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  successText: {
    color: '#4ade80',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  resetBtn: {
    alignSelf: 'center',
    padding: 8,
    marginTop: 8,
  },
  resetText: {
    color: '#666',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
