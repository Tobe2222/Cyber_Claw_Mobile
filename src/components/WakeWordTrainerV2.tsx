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
import TrainingSummary from './TrainingSummary';
import RNFS from 'react-native-fs';

const getWakeSamplesKey = (phrase: string) => `cyberclaw-wake-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;
const REQUIRED_SAMPLES = 3;

interface TrainedSample {
  path: string;
  features: AudioFeatures;
  duration: number;
  quality: number; // 0-1, similarity to other samples
}

interface Props {
  wakePhrase?: string;
  onComplete: (success: boolean) => void;
  onCancel: () => void;
}

export default function WakeWordTrainerV2({ wakePhrase: initialPhrase = 'hey clawsuu', onComplete, onCancel }: Props) {
  const [wakePhrase, setWakePhrase] = useState(initialPhrase);
  const [started, setStarted] = useState(false);
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
      await recorder.start(path, 5000);  // Record for up to 5 seconds

      setTimeout(async () => {
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
      }, 4000);
    } catch (e: any) {
      setMessage(`❌ Failed to start recording: ${e.message}`);
      setIsRecording(false);
    }
  }, [isRecording, currentSample, samples, qualityScores]);

  const saveSamples = useCallback(async () => {
    try {
      await AsyncStorage.setItem(
        getWakeSamplesKey(wakePhrase),
        JSON.stringify({
          phrase: wakePhrase,
          sampleCount: samples.length,
          qualityScores,
          overallQuality,
          trainedAt: new Date().toISOString(),
          features: samples.map(s => s.features),
        })
      );
      
      setMessage('✅ Training saved! Ready to use.');
      setTimeout(() => onComplete(true), 1000);
    } catch (e: any) {
      setMessage(`Error saving: ${e.message}`);
    }
  }, [samples, qualityScores, overallQuality, wakePhrase, onComplete]);

  const resetTraining = () => {
    setCurrentSample(0);
    setSamples([]);
    setQualityScores([]);
    setMessage('');
    setOverallQuality(0);
  };

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
        <Text style={styles.title}>🎤 Train Wake Word</Text>
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
      <ScrollView contentContainerStyle={started ? styles.recordingContent : styles.content}>
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
