/**
 * WakeWordTester — Test wake word detection with real audio sample matching
 *
 * Flow:
 *  1. Load training features from AsyncStorage (keyed by phrase)
 *  2. Record a test clip via WakeWordModule.startSampleRecord → stopSampleRecord
 *  3. Read the WAV file, extract features (energy + ZCR)
 *  4. Run DTW matching against training features
 *  5. Show real match score and MATCH / NO MATCH result
 */

import React, { useState, useRef, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  NativeModules,
  NativeEventEmitter,
  Alert,
} from 'react-native';
import RNFS from 'react-native-fs';
import {
  extractAudioFeatures,
  matchAgainstTraining,
  AudioFeatures,
} from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';

const { WakeWordModule } = NativeModules;

// Same key as WakeWordTrainerV2
const getWakeSamplesKey = (phrase: string) =>
  `cyberclaw-wake-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;

const MATCH_THRESHOLD = 0.55; // DTW match threshold (0-1)
const MAX_RECORD_MS = 5000;    // auto-stop after 5s

interface Props {
  phrase: string;
  onClose: () => void;
}

type Phase = 'idle' | 'recording' | 'processing' | 'done';

export default function WakeWordTester({ phrase, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [matched, setMatched] = useState<boolean | null>(null);
  const [trainingLoaded, setTrainingLoaded] = useState(false);
  const [trainingInfo, setTrainingInfo] = useState('');

  const trainingFeaturesRef = useRef<AudioFeatures[]>([]);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitterRef = useRef<NativeEventEmitter | null>(null);
  const sampleDoneSubRef = useRef<any>(null);
  const recordPathRef = useRef<string>('');

  const addLog = (msg: string) =>
    setLog(prev => [...prev.slice(-30), msg]);

  // Set up native event listener for sampleRecordDone
  useEffect(() => {
    // NativeEventEmitter requires addListener/removeListeners on native module (now present)
    if (WakeWordModule) {
      const emitter = new NativeEventEmitter(WakeWordModule);
      emitterRef.current = emitter;
    }
    return () => {
      sampleDoneSubRef.current?.remove?.();
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    };
  }, []);

  // Load training data when component mounts
  useEffect(() => {
    loadTraining();
  }, [phrase]);

  const loadTraining = async () => {
    try {
      // Try phrase-specific key first (V2), then legacy key
      let trainingJson =
        (await AsyncStorage.getItem(getWakeSamplesKey(phrase))) ||
        (await AsyncStorage.getItem('cyberclaw-wake-samples'));

      if (!trainingJson) {
        setTrainingInfo('⚠️  No training data — train first in Settings');
        return;
      }
      const training = JSON.parse(trainingJson);
      if (!training.features || !Array.isArray(training.features) || training.features.length === 0) {
        setTrainingInfo('⚠️  Training found but no features — retrain with V2 trainer');
        return;
      }
      trainingFeaturesRef.current = training.features as AudioFeatures[];
      const q = training.overallQuality ? ` • Quality: ${(training.overallQuality * 100).toFixed(0)}%` : '';
      setTrainingInfo(
        `✅ ${training.features.length} samples loaded${q}\n   Phrase: "${training.phrase}"`
      );
      setTrainingLoaded(true);
      addLog(`✅ Training loaded — ${training.features.length} sample(s)${q}`);
    } catch (e: any) {
      setTrainingInfo(`❌ Could not load training: ${e.message}`);
    }
  };

  const startTest = async () => {
    if (phase === 'recording') return;
    if (!trainingLoaded) {
      Alert.alert('No Training Data', 'Please train the wake phrase in Settings first.');
      return;
    }

    setPhase('recording');
    setMatchScore(null);
    setMatched(null);
    setLog([]);
    addLog('🎤 Recording… say your phrase now');

    const outPath = `${RNFS.CachesDirectoryPath}/wake_test_${Date.now()}.wav`;
    recordPathRef.current = outPath;

    // Subscribe to sampleRecordDone before starting
    sampleDoneSubRef.current?.remove?.();
    sampleDoneSubRef.current = emitterRef.current?.addListener(
      'sampleRecordDone',
      (e: { path: string; bytes: number }) => {
        if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
        addLog(`✅ Recording done — ${(e.bytes / 32000).toFixed(1)}s of audio`);
        processRecording(e.path);
      }
    );

    try {
      await WakeWordModule.startSampleRecord(outPath);
    } catch (e: any) {
      setPhase('idle');
      addLog(`❌ Start error: ${e.message}`);
      return;
    }

    // Auto-stop after MAX_RECORD_MS
    autoStopTimerRef.current = setTimeout(() => {
      addLog('⏱️  Auto-stopping after 5s');
      stopRecording();
    }, MAX_RECORD_MS);
  };

  const stopRecording = async () => {
    if (phase !== 'recording') return;
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    try {
      await WakeWordModule.stopSampleRecord();
      // processRecording is called from sampleRecordDone event
    } catch (e: any) {
      addLog(`❌ Stop error: ${e.message}`);
      setPhase('idle');
    }
  };

  const processRecording = async (wavPath: string) => {
    setPhase('processing');
    addLog('🔄 Extracting audio features…');

    try {
      // Read WAV file as base64
      const base64 = await RNFS.readFile(wavPath, 'base64');
      if (!base64 || base64.length < 100) {
        addLog('❌ Recording file empty or too short');
        setPhase('done');
        return;
      }

      // Decode to PCM16
      const pcm16 = base64ToInt16Array(base64);
      const durationSec = pcm16.length / 16000;
      addLog(`   PCM samples: ${pcm16.length} (~${durationSec.toFixed(1)}s)`);

      if (durationSec < 0.1) {
        addLog('❌ Audio too short — speak louder or longer');
        setPhase('done');
        return;
      }

      // Extract features
      const features = extractAudioFeatures(pcm16);
      addLog(`   Energy frames: ${features.energy.length}`);

      // Run DTW matching against all training samples
      addLog(`🔬 Running DTW match against ${trainingFeaturesRef.current.length} training samples…`);
      const result = await matchAgainstTraining(
        features,
        trainingFeaturesRef.current,
        MATCH_THRESHOLD
      );

      const pct = (result.score * 100).toFixed(1);
      setMatchScore(result.score);
      setMatched(result.matched);

      if (result.matched) {
        addLog(`✅ MATCH! Score: ${pct}% (best sample #${result.bestMatchIndex + 1})`);
      } else {
        addLog(`❌ No match. Score: ${pct}% (need >${(MATCH_THRESHOLD * 100).toFixed(0)}%)`);
        addLog('   Tip: speak clearly with same tone as training');
      }

      // Clean up temp file
      try { await RNFS.unlink(wavPath); } catch (_) {}
    } catch (e: any) {
      addLog(`❌ Processing error: ${e.message}`);
    }
    setPhase('done');
  };

  const resetTest = () => {
    setPhase('idle');
    setMatchScore(null);
    setMatched(null);
    setLog([]);
  };

  const isRecording = phase === 'recording';
  const isProcessing = phase === 'processing';
  const busy = isRecording || isProcessing;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>🎤 Wake Word Tester</Text>
        <Text style={styles.phrase}>Testing: "{phrase}"</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 12 }}>
        {/* Training status */}
        <View style={[styles.card, { borderColor: trainingLoaded ? '#10b981' : '#ef4444' }]}>
          <Text style={[styles.cardLabel, { color: trainingLoaded ? '#10b981' : '#ef4444' }]}>
            Training Data
          </Text>
          <Text style={[styles.cardText, { color: trainingLoaded ? '#10b981' : '#ef4444' }]}>
            {trainingInfo || 'Loading…'}
          </Text>
        </View>

        {/* Match result */}
        {matchScore !== null && (
          <View
            style={[
              styles.card,
              styles.resultCard,
              { borderColor: matched ? '#10b981' : '#ef4444' },
            ]}>
            <Text style={[styles.resultVerdict, { color: matched ? '#10b981' : '#ef4444' }]}>
              {matched ? '✅ MATCH!' : '❌ NO MATCH'}
            </Text>
            <Text style={[styles.resultScore, { color: matched ? '#10b981' : '#ef4444' }]}>
              {(matchScore * 100).toFixed(1)}%
            </Text>
            <Text style={[styles.cardText, { color: '#888', marginTop: 4 }]}>
              Threshold: {(MATCH_THRESHOLD * 100).toFixed(0)}%
            </Text>
          </View>
        )}

        {/* Log */}
        {log.length > 0 && (
          <View style={styles.logBox}>
            <Text style={styles.logLabel}>📋 Log</Text>
            {log.map((line, i) => (
              <Text
                key={i}
                style={[
                  styles.logEntry,
                  line.startsWith('✅') && styles.logSuccess,
                  line.startsWith('❌') && styles.logError,
                ]}>
                {line}
              </Text>
            ))}
          </View>
        )}

        {/* Instructions */}
        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>ℹ️  How it works</Text>
          <Text style={styles.infoText}>
            Press Start, speak your phrase once clearly, then press Stop (or wait 5s for auto-stop).
            The app compares your audio directly against your 3 training recordings using Dynamic Time Warping.
            No speech recognition — pure waveform matching.
          </Text>
        </View>
      </ScrollView>

      {/* Controls */}
      <View style={styles.controls}>
        {phase === 'done' ? (
          <TouchableOpacity style={styles.btn} onPress={resetTest}>
            <Text style={styles.btnText}>🔄 Test Again</Text>
          </TouchableOpacity>
        ) : isRecording ? (
          <TouchableOpacity style={[styles.btn, styles.btnStop]} onPress={stopRecording}>
            <Text style={styles.btnText}>⏹ Stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.btn, (!trainingLoaded || busy) && styles.btnDisabled]}
            onPress={startTest}
            disabled={!trainingLoaded || busy}>
            <Text style={styles.btnText}>
              {isProcessing ? '⏳ Processing…' : '▶ Start Test'}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={onClose}
          disabled={busy}>
          <Text style={styles.btnText}>✕ Close</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
    paddingTop: 50,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  header: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#f7931a',
    marginBottom: 4,
  },
  phrase: {
    fontSize: 13,
    color: '#999',
  },
  body: {
    flex: 1,
    marginBottom: 12,
  },
  card: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardText: {
    fontSize: 12,
    color: '#aaa',
    lineHeight: 18,
  },
  resultCard: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  resultVerdict: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  resultScore: {
    fontSize: 48,
    fontWeight: 'bold',
  },
  logBox: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  logLabel: {
    fontSize: 11,
    color: '#888',
    fontWeight: 'bold',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  logEntry: {
    fontSize: 11,
    color: '#666',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  logSuccess: { color: '#51cf66' },
  logError: { color: '#ff6b6b' },
  infoBox: {
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 10,
    backgroundColor: 'rgba(59,130,246,0.08)',
  },
  infoTitle: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  infoText: {
    color: '#3b82f6',
    fontSize: 11,
    lineHeight: 16,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    flex: 1,
    backgroundColor: 'rgba(247,147,26,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.4)',
    borderRadius: 8,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnStop: {
    backgroundColor: 'rgba(239,68,68,0.3)',
    borderColor: '#ef4444',
  },
  btnSecondary: {
    backgroundColor: 'rgba(100,100,100,0.2)',
    borderColor: 'rgba(100,100,100,0.4)',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
  },
});
