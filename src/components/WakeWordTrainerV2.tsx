/**
 * WakeWordTrainerV2 — Train wake word with instant quality feedback
 * 
 * Flow:
 * 1. Enter wake phrase text
 * 2. Record 3 samples
 * 3. Extract audio features for each
 * 4. Show quality score (how similar samples are)
 * 5. If consistent → good training data
 * 6. Save samples + features for later matching
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Alert,
  TextInput,
  ScrollView,
  BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { extractAudioFeatures, compareAudioFeatures, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array, validateAudio } from '../services/AudioUtils';
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import { NativeModules } from 'react-native';

const { WakeWordModule } = NativeModules;
import TrainingSummary from './TrainingSummary';
import RNFS from 'react-native-fs';

// v3.1.67: per-companion storage key. Each companion has
// its own wake word stored under its agent ID (e.g.
// "cyberclaw-wake-samples-clawsuu"). Tobe: "we should
// rather train other wake words for other companions."
const getWakeSamplesKey = (id: string) => `cyberclaw-wake-samples-${id}`;
const REQUIRED_SAMPLES = 3;

interface TrainedSample {
  path: string;
  features: AudioFeatures;
  duration: number;
  quality: number; // 0-1, similarity to other samples
}

interface Props {
  // v3.1.67: companion to train for. The wake word is
  // specific to this companion. Each companion has its own
  // wake word (e.g. "hey clawsuu" for clawsuu, "yo
  // lamasuu" for lamasuu). Tobe: "we should rather train
  // other wake words for other companions. So, in the
  // settings for wake training the user should select which
  // companion to train for."
  companionId: string;
  companionName: string;
  availableCompanions?: Array<{ id: string; name: string }>;  // for the selector UI
  onSelectCompanion?: (id: string) => void;
  onComplete: (success: boolean) => void;
  onCancel: () => void;
}

export default function WakeWordTrainerV2({ companionId, companionName, availableCompanions, onSelectCompanion, onComplete, onCancel }: Props) {
  // v3.1.67: default wake phrase is "hey {companionName}".
  // The user can edit it but it's pre-filled so the common
  // case is just "train this companion's wake word".
  const [wakePhrase, setWakePhrase] = useState(`hey ${companionName}`);
  const [started, setStarted] = useState(true); // Start recording immediately
  const [currentSample, setCurrentSample] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [samples, setSamples] = useState<TrainedSample[]>([]);
  const [qualityScores, setQualityScores] = useState<number[]>([]);
  const [overallQuality, setOverallQuality] = useState(0);
  const [message, setMessage] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

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

    try {
      setIsRecording(true);
      setMessage('🎤 Recording... speak clearly');
      startPulse();

      const recorder = getSimpleAudioRecorder();
      const path = `${RNFS.CachesDirectoryPath}/wake_sample_${currentSample}_temp.m4a`;
      // v3.1.66: stop the wake word listener while training so
      // the user's own voice saying the wake phrase doesn't
      // trigger wake mode mid-training. Tobe: "when training
      // more wake samples the wake word triggered. That should
      // be disabled during that." Without this, every "hey
      // clawsuu" the user says during training would route to
      // WakeModeScreen, killing the training session.
      try { await WakeWordModule?.stopSampleListening?.(); } catch (_) {}

      // v3.1.66: shorter silence timeout (1500ms) and listen
      // for the recorder's 'silence' event so short wake
      // words are captured quickly. Previously used a hard
      // 4s setTimeout — the trainer waited 4 seconds no
      // matter what, which is way too long for a 1-word
      // phrase. Tobe: "the wake trainer wanted the recording
      // to be longer in duration, making my attempts invalid.
      // The minimum Length should be very short. Less than
      // half of what it is now. Perhaps people want very
      // short wake words."
      const SILENCE_TIMEOUT_MS = 1500;
      const MAX_DURATION_MS = 3000;
      await recorder.start(path, SILENCE_TIMEOUT_MS);

      let stopped = false;
      const stopRecording = async () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(maxTimer);
        try { unsubSilence(); } catch (_) {}
        try {
          stopPulse();
          setIsRecording(false);
          const finalPath = await recorder.stop();
          
          // Read and process audio
          const base64 = await RNFS.readFile(finalPath, 'base64');
          
          // Convert to audio data and extract features
          try {
            const pcm16 = base64ToInt16Array(base64);
            
            // Validate audio
            const validation = validateAudio(pcm16);
            if (!validation.valid) {
              setMessage(`❌ ${validation.reason || 'Invalid audio'}`);
              setIsRecording(false);
              return;
            }
            
            // Extract features
            const features = extractAudioFeatures(pcm16);
            setMessage(`✅ Extracted features from ${(features.duration / 16000).toFixed(1)}s audio`);

            // Calculate quality by comparing to previous samples
            let quality = 1.0;
            if (samples.length > 0) {
              // Compare features to previous samples
              const similarities = samples.map(s => compareAudioFeatures(features, s.features));
              const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
              quality = avgSimilarity; // Quality = how similar to other samples
            }

            setSamples(prev => [...prev, {
              path: finalPath,
              features,
              duration: 1.0,
              quality,
            }]);

            setQualityScores(prev => [...prev, quality]);

            if (samples.length < REQUIRED_SAMPLES - 1) {
              setMessage(`✅ Sample ${currentSample + 1} good! (${(quality * 100).toFixed(0)}%)`);
              setTimeout(() => {
                setCurrentSample(prev => prev + 1);
                setMessage('Ready for next sample...');
              }, 1500);
            } else {
              // Calculate overall quality
              const overall = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
              setOverallQuality(overall);
              setShowSummary(true);
              
              if (overall > 0.7) {
                setMessage(`✅ Excellent training data!`);
              } else if (overall > 0.5) {
                setMessage(`⚠️ Fair training data.`);
              } else {
                setMessage(`❌ Poor quality.`);
              }
            }
          } catch (e: any) {
            setMessage(`❌ Feature extraction error: ${e.message}`);
            setIsRecording(false);
          }
        } catch (e: any) {
          setMessage(`❌ Recording error: ${e.message}`);
          setIsRecording(false);
        }
      };

      // Listen for the recorder's 'silence' event to stop the
      // recording as soon as the user finishes speaking. The
      // native module fires this after SILENCE_TIMEOUT_MS of
      // silence.
      const unsubSilence = recorder.once('silence', () => {
        addLogEntry?.('🎤 Silence detected, stopping', 'debug');
        stopRecording();
      });

      // Max-duration fallback in case the user keeps talking
      // (or never talks).
      const maxTimer = setTimeout(() => {
        stopRecording();
      }, MAX_DURATION_MS);
    } catch (e: any) {
      setMessage(`❌ Failed to start recording: ${e.message}`);
      setIsRecording(false);
    }
  }, [isRecording, currentSample, samples, qualityScores]);

  const saveSamples = useCallback(async () => {
    try {
      // v3.1.67: storage key is per-companion, not per-phrase.
      // Each companion has its own wake word stored under its
      // agent ID. The phrase is saved as metadata.
      const key = getWakeSamplesKey(companionId);
      // v3.1.67: read existing samples and append the new
      // ones, instead of overwriting. Tobe: "i tried to add
      // more samples to train wake word better but it replaced
      // my old ones. Could we not just add even more for
      // better accuracy?" The trainer previously overwrote
      // the storage entry on save, losing previous samples.
      // Now we read the existing entry, append the new
      // features, and write back. Caps at MAX_SAMPLES (12)
      // to prevent unbounded growth.
      const MAX_SAMPLES = 12;
      let existingFeatures = [];
      try {
        const existing = await AsyncStorage.getItem(key);
        if (existing) {
          const parsed = JSON.parse(existing);
          if (parsed?.features?.length) existingFeatures = parsed.features;
        }
      } catch (_) {}
      const mergedFeatures = [...existingFeatures, ...samples.map(s => s.features)].slice(-MAX_SAMPLES);
      const mergedQualityScores = [...qualityScores];  // current session's quality scores

      await AsyncStorage.setItem(
        key,
        JSON.stringify({
          phrase: wakePhrase,
          sampleCount: mergedFeatures.length,
          qualityScores: mergedQualityScores,
          overallQuality,
          trainedAt: new Date().toISOString(),
          features: mergedFeatures,
        })
      );
      
      setMessage(`✅ Saved! Now have ${mergedFeatures.length} samples total.`);
      setTimeout(() => onComplete(true), 1500);
    } catch (e: any) {
      setMessage(`Error saving: ${e.message}`);
    }
  }, [samples, qualityScores, overallQuality, companionId, wakePhrase, onComplete]);

  const resetTraining = () => {
    setCurrentSample(0);
    setSamples([]);
    setQualityScores([]);
    setMessage('');
    setOverallQuality(0);
  };

  // Auto-start recording when component mounts
  useEffect(() => {
    const autoStart = async () => {
      await new Promise(resolve => setTimeout(resolve, 300)); // Small delay for UI to render
      startRecording();
    };
    autoStart();
  }, []);

  // v3.1.66: re-enable the wake word listener when the trainer
  // unmounts. The listener is stopped in startRecording() so
  // the user's voice during training doesn't trigger wake mode.
  // On unmount, restart it so wake mode works again after
  // training. Without this, the user would have to restart
  // the app to use wake mode.
  useEffect(() => {
    return () => {
      try { WakeWordModule?.startSampleListening?.(); } catch (_) {}
    };
  }, []);

  // Handle back button during training - only add if BackHandler is available
  useEffect(() => {
    if (!BackHandler) return; // Skip if not available
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      onCancel();
      return true;
    });
    return () => backHandler.remove();
  }, [onCancel]);

  if (!started) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>🎤 Train Wake Phrase</Text>
        <Text style={styles.subtitle}>Create a new wake phrase for detection</Text>

        <Text style={styles.label}>Wake Phrase</Text>
        <TextInput
          style={styles.input}
          value={wakePhrase}
          onChangeText={setWakePhrase}
          placeholder="e.g., hey clawsuu"
          placeholderTextColor="#555"
        />

        <Text style={styles.hint}>
          Say this phrase {REQUIRED_SAMPLES} times, clearly and naturally. We'll analyze the audio to ensure good quality training data.
        </Text>

        <TouchableOpacity
          style={styles.startBtn}
          onPress={() => {
            setStarted(true);
            setMessage('Ready to begin. Press the button to start recording.');
          }}
        >
          <Text style={styles.startBtnText}>Begin Training</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.recordingContent}>
        <Text style={styles.title}>🎤 Training: "{wakePhrase}"</Text>

        {/* Progress */}
        <View style={styles.progressBar}>
          {Array(REQUIRED_SAMPLES)
            .fill(0)
            .map((_, i) => (
              <View
                key={i}
                style={[
                  styles.progressDot,
                  i < currentSample && styles.progressDotComplete,
                  i === currentSample && styles.progressDotActive,
                ]}
              />
            ))}
        </View>

        <Text style={styles.progressText}>
          Sample {currentSample + 1} of {REQUIRED_SAMPLES}
        </Text>

        {/* Existing Samples (before recording starts) */}
        {!showSummary && currentSample === 0 && qualityScores.length === 0 && samples.length > 0 && (
          <View style={styles.qualityBox}>
            <Text style={styles.qualityTitle}>📊 Your Existing Samples</Text>
            <Text style={styles.qualitySubtext}>Delete any to retrain</Text>
            {samples.map((sample, i) => (
              <View key={i} style={styles.qualityRow}>
                <View style={styles.qualityInfo}>
                  <Text style={styles.qualityLabel}>Sample {i + 1}</Text>
                  <Text style={styles.qualitySubtext}>
                    {sample.quality ? `Quality: ${(sample.quality * 100).toFixed(0)}%` : 'Previously trained'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => {
                    setSamples(prev => prev.filter((_, idx) => idx !== i));
                  }}
                >
                  <Text style={styles.deleteBtnText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Training Summary */}
        {showSummary && (
          <TrainingSummary samples={samples} overallQuality={overallQuality} />
        )}

        {/* Quality Scores */}
        {qualityScores.length > 0 && (
          <View style={styles.qualityBox}>
            <Text style={styles.qualityTitle}>📊 Training Samples</Text>
            {qualityScores.length === 0 ? (
              <Text style={styles.qualityLabel}>No samples recorded yet</Text>
            ) : (
              qualityScores.map((score, i) => (
                <View key={i} style={styles.qualityRow}>
                  <View style={styles.qualityInfo}>
                    <Text style={styles.qualityLabel}>Sample {i + 1}</Text>
                    <Text style={styles.qualitySubtext}>
                      Quality: {(score * 100).toFixed(0)}% {score > 0.7 ? '✅ Good' : score > 0.5 ? '⚠️ Fair' : '❌ Poor'}
                    </Text>
                  </View>
                  <View style={styles.qualityBar}>
                    <View
                      style={[
                        styles.qualityFill,
                        {
                          width: `${score * 100}%`,
                          backgroundColor: score > 0.7 ? '#10b981' : score > 0.5 ? '#f59e0b' : '#ef4444',
                        },
                      ]}
                    />
                  </View>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => {
                      setSamples(prev => prev.filter((_, idx) => idx !== i));
                      setQualityScores(prev => prev.filter((_, idx) => idx !== i));
                    }}
                  >
                    <Text style={styles.deleteBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}

        {/* Message */}
        <Text style={styles.message}>{message}</Text>

        {/* Recording Button */}
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[styles.recordBtn, isRecording && styles.recordBtnActive]}
            onPress={startRecording}
            disabled={isRecording}
          >
            <Text style={styles.recordBtnText}>
              {isRecording ? '🔴 Recording...' : '🎤 Record'}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </ScrollView>

      {/* Bottom Buttons */}
      <View style={styles.controls}>
        {showSummary ? (
          <>
            <TouchableOpacity style={styles.saveBtn} onPress={() => { saveSamples(); setShowSummary(false); }}>
              <Text style={styles.saveBtnText}>✅ Save Training</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.resetBtn} onPress={() => { resetTraining(); setShowSummary(false); }}>
              <Text style={styles.resetBtnText}>↻ Retrain</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {samples.length === REQUIRED_SAMPLES && (
              <TouchableOpacity style={styles.saveBtn} onPress={saveSamples}>
                <Text style={styles.saveBtnText}>✅ Save Training</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.resetBtn} onPress={resetTraining}>
              <Text style={styles.resetBtnText}>↻ Restart</Text>
            </TouchableOpacity>
          </>
        )}
        {!showSummary && (
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
            <Text style={styles.cancelBtnText}>✕ Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
  },
  content: {
    paddingTop: 80,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  recordingContent: {
    paddingTop: 140,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#f7931a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#999',
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ccc',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 10,
    color: '#fff',
    marginBottom: 12,
    fontSize: 14,
  },
  hint: {
    fontSize: 12,
    color: '#666',
    marginBottom: 16,
    lineHeight: 18,
  },
  startBtn: {
    backgroundColor: '#f7931a',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  startBtnText: {
    color: '#000',
    fontWeight: 'bold',
    fontSize: 14,
  },
  cancelBtn: {
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  cancelBtnText: {
    color: '#999',
    fontSize: 13,
  },
  progressBar: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  progressDot: {
    flex: 1,
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
  },
  progressDotComplete: {
    backgroundColor: '#10b981',
  },
  progressDotActive: {
    backgroundColor: '#f7931a',
  },
  progressText: {
    color: '#999',
    fontSize: 12,
    marginBottom: 12,
  },
  qualityBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
  },
  qualityTitle: {
    color: '#3b82f6',
    fontWeight: 'bold',
    fontSize: 12,
    marginBottom: 8,
  },
  qualityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  qualityLabel: {
    color: '#999',
    fontSize: 11,
    width: 70,
  },
  qualityBar: {
    flex: 1,
    height: 6,
    backgroundColor: '#222',
    borderRadius: 3,
    overflow: 'hidden',
  },
  qualityFill: {
    height: '100%',
  },
  qualityPercent: {
    color: '#999',
    fontSize: 11,
    width: 40,
    textAlign: 'right',
  },
  qualityInfo: {
    flex: 1,
  },
  qualitySubtext: {
    color: '#666',
    fontSize: 10,
    marginTop: 2,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  message: {
    color: '#f7931a',
    fontSize: 13,
    marginBottom: 16,
    textAlign: 'center',
    minHeight: 20,
  },
  recordBtn: {
    backgroundColor: 'rgba(247, 147, 26, 0.2)',
    borderWidth: 2,
    borderColor: '#f7931a',
    borderRadius: 100,
    width: 120,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 20,
  },
  recordBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.3)',
    borderColor: '#ef4444',
  },
  recordBtnText: {
    color: '#f7931a',
    fontSize: 14,
    fontWeight: 'bold',
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  saveBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  resetBtn: {
    flex: 1,
    backgroundColor: 'rgba(100, 100, 100, 0.2)',
    borderWidth: 1,
    borderColor: '#666',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  resetBtnText: {
    color: '#999',
    fontWeight: 'bold',
    fontSize: 13,
  },
});
