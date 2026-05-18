/**
 * WakeWordTester — Test wake word detection in real-time
 * 
 * Shows live partial results from Vosk to debug what's being heard
 * Helps identify why wake word isn't being detected
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
import { extractAudioFeatures, matchAgainstTraining, AudioFeatures } from '../services/AudioSampleMatcher';

const { WakeWordModule } = NativeModules;

interface Props {
  phrase: string;
  onClose: () => void;
}

export default function WakeWordTester({ phrase, onClose }: Props) {
  const [isListening, setIsListening] = useState(false);
  const [partialResults, setPartialResults] = useState<string[]>([]);
  const [lastDetected, setLastDetected] = useState<string>('');
  const [testLog, setTestLog] = useState<string[]>([]);
  const emitterRef = useRef<any>(null);
  const subscriptionsRef = useRef<any[]>([]);

  useEffect(() => {
    // Set up listeners
    if (WakeWordModule) {
      try {
        const emitter = new NativeEventEmitter(WakeWordModule);
        emitterRef.current = emitter;

        const debugSub = emitter.addListener('wakeWordDebug', (e: any) => {
          const msg = `${e.state}${e.text ? `: "${e.text}"` : ''}`;
          setTestLog(prev => [...prev.slice(-20), msg]); // Keep last 20 messages
          
          if (e.state === 'partial') {
            setPartialResults(prev => [...prev.slice(-5), e.text || '']);
          } else if (e.state === 'detected') {
            setLastDetected(e.text || '');
            Alert.alert('✅ Wake Word Detected!', `Heard: "${e.text}"\nTarget: "${phrase}"`);
          } else if (e.state === 'error') {
            setTestLog(prev => [...prev, `ERROR: ${e.text}`]);
          }
        });

        subscriptionsRef.current.push(debugSub);
      } catch (e: any) {
        Alert.alert('Error', `Failed to set up listeners: ${e.message}`);
      }
    }

    return () => {
      subscriptionsRef.current.forEach(sub => sub?.remove?.());
      subscriptionsRef.current = [];
    };
  }, [phrase]);

  const startTest = async () => {
    if (isListening) return;

    try {
      setIsListening(true);
      setPartialResults([]);
      setTestLog(['Initializing...']);
      setLastDetected('');

      // Load training data to confirm it exists
      try {
        const trainingJson = await AsyncStorage.getItem('cyberclaw-wake-samples');
        if (trainingJson) {
          const training = JSON.parse(trainingJson);
          const trainDate = new Date(training.trainedAt);
          const dateStr = trainDate.toLocaleString();
          setTestLog(prev => [...prev, `✅ Training loaded`]);
          setTestLog(prev => [...prev, `   Phrase: "${training.phrase}"`]);
          setTestLog(prev => [...prev, `   Samples: ${training.samplePaths?.length || 0}`]);
          setTestLog(prev => [...prev, `   Trained: ${dateStr}`]);
        } else {
          setTestLog(prev => [...prev, `⚠️  No training data found`]);
          setTestLog(prev => [...prev, `   Train phrase first in Settings`]);
        }
      } catch (trainErr: any) {
        setTestLog(prev => [...prev, `⚠️  Could not load training: ${trainErr.message}`]);
      }

      setTestLog(prev => [...prev, '']);
      setTestLog(prev => [...prev, `Matching against: "${phrase}"`]);
      setTestLog(prev => [...prev, 'Starting audio sample matching...']);

      if (WakeWordModule) {
        try {
          await WakeWordModule.start(phrase);
          setTestLog(prev => [...prev, '✅ Audio matcher started']);
          setTestLog(prev => [...prev, '🎤 Listening for match - speak now']);
        } catch (startErr: any) {
          const errMsg = startErr?.message || String(startErr);
          setTestLog(prev => [...prev, `❌ Start error: ${errMsg}`]);
          throw startErr;
        }
      } else {
        setTestLog(prev => [...prev, '❌ WakeWordModule not available']);
      }
    } catch (e: any) {
      Alert.alert('Error', `Failed to start listening: ${e.message}`);
      setIsListening(false);
    }
  };

  const stopTest = async () => {
    if (!isListening) return;

    try {
      setIsListening(false);
      if (WakeWordModule) {
        await WakeWordModule.stop();
        setTestLog(prev => [...prev, 'Stopped listening']);
      }
    } catch (e: any) {
      Alert.alert('Error', `Failed to stop: ${e.message}`);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>🎤 Wake Word Tester</Text>
        <Text style={styles.phrase}>Testing: "{phrase}"</Text>
      </View>

      <ScrollView style={styles.logContainer}>
        {/* Last Detected */}
        {lastDetected ? (
          <View style={styles.detectedBox}>
            <Text style={styles.detectedLabel}>✅ Last Detected:</Text>
            <Text style={styles.detectedText}>"{lastDetected}"</Text>
          </View>
        ) : null}

        {/* Recent Partial Results */}
        {partialResults.length > 0 ? (
          <View style={styles.partialBox}>
            <Text style={styles.partialLabel}>📊 Hearing (Real-time):</Text>
            {partialResults.map((result, i) => (
              <Text key={i} style={styles.partialText}>
                {result}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Test Log */}
        <View style={styles.logBox}>
          <Text style={styles.logLabel}>📋 Log:</Text>
          {testLog.map((log, i) => (
            <Text
              key={i}
              style={[
                styles.logEntry,
                log.includes('ERROR') && styles.logError,
                log.includes('Detected') && styles.logSuccess,
              ]}
            >
              {log}
            </Text>
          ))}
        </View>
      </ScrollView>

      {/* Note about audio sample matching */}
      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>🎯 Audio Sample Matching</Text>
        <Text style={styles.noteText}>
          Compares your incoming audio directly against the 3 training samples you recorded. Uses audio fingerprinting (energy + zero-crossing patterns) with Dynamic Time Warping for robust matching.
        </Text>
        <Text style={[styles.noteText, { marginTop: 8, fontSize: 10 }]}>
          ⚠️ Currently in development - integration not yet active
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.button, isListening && styles.buttonActive]}
          onPress={isListening ? stopTest : startTest}
        >
          <Text style={styles.buttonText}>
            {isListening ? '⏹ Stop' : '▶ Start Test'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={onClose}>
          <Text style={styles.buttonText}>✕ Close</Text>
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
  logContainer: {
    flex: 1,
    marginBottom: 12,
  },
  detectedBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  detectedLabel: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  detectedText: {
    color: '#10b981',
    fontSize: 14,
    fontWeight: '600',
  },
  partialBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  partialLabel: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  partialText: {
    color: '#3b82f6',
    fontSize: 13,
    marginBottom: 2,
  },
  logBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 12,
  },
  logLabel: {
    color: '#888',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  logEntry: {
    color: '#666',
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  logError: {
    color: '#ff6b6b',
  },
  logSuccess: {
    color: '#51cf66',
  },
  noteBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  noteTitle: {
    color: '#3b82f6',
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  noteText: {
    color: '#3b82f6',
    fontSize: 11,
    lineHeight: 16,
  },
  controls: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
    backgroundColor: 'rgba(247, 147, 26, 0.2)',
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.4)',
    borderRadius: 8,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.3)',
    borderColor: '#ef4444',
  },
  buttonSecondary: {
    backgroundColor: 'rgba(100, 100, 100, 0.2)',
    borderColor: 'rgba(100, 100, 100, 0.4)',
  },
  buttonText: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
  },
});
