/**
 * SendPhraseTrainer — Record user samples + train a send-word model.
 * v3.6.0.
 *
 * Mirror of ExitPhraseTrainer for the explicit end-of-utterance
 * send word (e.g. "send", "go", "done"). The send word is the
 * safety valve for noisy environments where silence detection
 * can't reliably tell "user paused" from "ambient table talk" —
 * saying the send word commits the current turn immediately.
 *
 * Records 6 audio samples of the user's chosen send word. Each
 * sample is captured as raw PCM16 mono 16kHz WAV via
 * WakeWordModule.startSampleRecord. Samples ship to the desktop
 * for openWakeWord training, the trained .tflite comes back,
 * and we hot-swap it into the running send classifier via
 * WakeWordModule.setSendModelFromBase64.
 *
 * The result: "send" spoken during a recording turn instantly
 * commits the turn, even when STT transcription hasn't fired
 * yet. Works alongside (not instead of) the silence timer and
 * the gibberish gate.
 *
 * Differs from ExitPhraseTrainer in three ways:
 *   - Hot-swaps into sendInterpreter, not exitInterpreter
 *     (WakeWordModule.setSendModelFromBase64)
 *   - Storage is global, not per-companion (one send word
 *     across all companions, like the wake word itself)
 *   - SyncClient sends to the send_* message channel
 *     (request_send_training / send_training_result /
 *     send_model_data)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  ActivityIndicator,
} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import syncClient from '../services/SyncClient';
import {
  getSendSamplesKey,
  clearSendSamples,
} from '../services/VoiceSettings';

const { WakeWordModule } = NativeModules;

const REQUIRED_SAMPLES = 6;
const DEFAULT_PHRASE = 'send';

type Stage =
  | 'idle'
  | 'recording'
  | 'saving'        // kept for compat with existing UI references
  | 'uploading'     // samples -> desktop
  | 'training'      // desktop is running OWW
  | 'downloading'   // receiving the .tflite
  | 'activating'    // hot-swap into the send classifier
  | 'complete'
  | 'error';

export default function SendPhraseTrainer({ presetPhrase, onCancel, onComplete }: {
  presetPhrase?: string;
  onCancel: () => void;
  onComplete?: () => void;
}) {
  const [phrase, setPhrase] = useState(presetPhrase ?? DEFAULT_PHRASE);
  const [samples, setSamples] = useState<string[]>([]);  // WAV file paths
  const [stage, setStage] = useState<Stage>('idle');
  const [statusMsg, setStatusMsg] = useState('Tap "Record sample" to start. Record the same word 6 times.');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  // Animation pulse for the record button.
  const pulse = useRef(new Animated.Value(0)).current;

  // Internal flag so the JS side and the native side agree on
  // whether a recording is in progress.
  const isRecordingRef = useRef(false);

  // Back button: confirm exit if there are unsaved samples.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stage === 'recording') return true;
      if (samples.length > 0 && stage !== 'complete') {
        Alert.alert('Discard training?', 'You have unsaved samples. Discard?', [
          { text: 'Keep training', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => onCancel() },
        ]);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stage, samples.length, onCancel]);

  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulse]);

  const stopPulse = useCallback(() => {
    pulse.stopAnimation();
    pulse.setValue(0);
  }, [pulse]);

  const recordSample = useCallback(async () => {
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    setStage('recording');
    setStatusMsg('Recording… say the word');
    startPulse();

    const wavPath = `${RNFS.TemporaryDirectoryPath}/send-sample-${Date.now()}.wav`;
    try {
      await WakeWordModule.startSampleRecord(wavPath, 2000);  // 2s max per sample
      // startSampleRecord stops automatically after the
      // duration elapses; we just wait it out. The native
      // side fires 'sampleRecordDone' on completion but
      // this function returns the same promise when done.
      await new Promise<void>((resolve) => setTimeout(resolve, 2100));
      setSamples(prev => [...prev, wavPath]);
      setStatusMsg(`Sample ${samples.length + 1}/${REQUIRED_SAMPLES} captured.`);
      if (samples.length + 1 >= REQUIRED_SAMPLES) {
        setStage('idle');
        setStatusMsg('All samples captured. Tap "Train model" to continue.');
      } else {
        setStage('idle');
      }
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Recording failed: ${e?.message ?? e}`);
    } finally {
      isRecordingRef.current = false;
      stopPulse();
    }
  }, [samples.length, startPulse, stopPulse]);

  const trainModel = useCallback(async () => {
    const trimmed = phrase.trim().toLowerCase();
    if (!trimmed) {
      setStage('error');
      setStatusMsg('Phrase cannot be empty.');
      return;
    }
    if (samples.length < REQUIRED_SAMPLES) {
      setStage('error');
      setStatusMsg(`Need ${REQUIRED_SAMPLES} samples, have ${samples.length}.`);
      return;
    }
    const sync = syncClient;
    if (!sync?.connected) {
      setStage('error');
      setStatusMsg('Not connected to the desktop. Connect first, then train.');
      return;
    }

    const wavPaths = [...samples];
    const _onProgress = (msg: any) => {
      if (!msg) return;
      if (msg.stage) setStage(msg.stage as Stage);
      const pct = typeof msg.percent === 'number' ? Math.round(msg.percent) : null;
      if (msg.message) setStatusMsg(msg.message);
      else if (pct != null) setStatusMsg(`Training… ${pct}%`);
    };
    const _onResult = (msg: any) => {
      if (msg?.noResult) return;
      if (!msg?.ok || !msg?.tflitePath) {
        setStage('error');
        setStatusMsg(msg?.error || 'Training failed on the desktop.');
        return;
      }
      setStage('downloading');
      setStatusMsg('Downloading trained send model…');
      sync.readSendModel(msg.tflitePath);
    };
    const _onModel = async (msg: any) => {
      if (!msg?.ok || !msg?.base64) {
        setStage('error');
        setStatusMsg(msg?.error || 'Could not fetch the trained send model.');
        return;
      }
      setStage('activating');
      setStatusMsg('Activating on this device…');
      try {
        const savedPath: string = await WakeWordModule.setSendModelFromBase64(
          trimmed,
          msg.base64,
        );
        try {
          await AsyncStorage.setItem(
            getSendSamplesKey(trimmed),
            JSON.stringify({ trainedAt: Date.now(), modelPath: savedPath.split('/').pop() }),
          );
        } catch (_) {}
        setStage('complete');
        setLastSavedAt(Date.now());
        setStatusMsg(`✅ Send word ready. Model saved to ${savedPath.split('/').pop()}. Try saying "${trimmed}" in voice mode.`);
        for (const wav of wavPaths) RNFS.unlink(wav).catch(() => {});
        setSamples([]);
        onComplete?.();
      } catch (e: any) {
        setStage('error');
        setStatusMsg(`Activation failed: ${e?.message ?? e}`);
      }
    };

    setStage('uploading');
    setStatusMsg('Uploading samples to desktop…');

    // Encode WAVs as base64 for the sync payload.
    const encoded: Array<{ name: string; data: string }> = [];
    for (const p of wavPaths) {
      try {
        const b64 = await RNFS.readFile(p, 'base64');
        encoded.push({ name: p.split('/').pop() ?? 'sample.wav', data: b64 });
      } catch (_) {}
    }

    sync.on('send_training_progress', _onProgress);
    sync.on('send_training_result', _onResult);
    sync.on('send_model_data', _onModel);

    try {
      await sync.requestSendTraining(trimmed, encoded);
    } catch (e: any) {
      sync.off?.('send_training_progress', _onProgress);
      sync.off?.('send_training_result', _onResult);
      sync.off?.('send_model_data', _onModel);
      setStage('error');
      setStatusMsg(`Could not send training request: ${e?.message ?? e}`);
    }
  }, [phrase, samples, onComplete]);

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] });

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Train Send Word</Text>
      <Text style={styles.subtitle}>
        Record the word you'll say to commit a turn (e.g. "send", "go", "done").
        The model runs on-device so it works even in noisy rooms where silence
        detection can't tell your voice from background talk.
      </Text>

      <Text style={styles.label}>Send word</Text>
      <TextInput
        value={phrase}
        onChangeText={setPhrase}
        editable={stage !== 'training' && stage !== 'uploading' && stage !== 'downloading' && stage !== 'activating'}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={40}
        placeholder="send"
        placeholderTextColor="#666"
      />

      <Text style={styles.label}>Samples ({samples.length}/{REQUIRED_SAMPLES})</Text>
      <Animated.View style={{ transform: [{ scale: stage === 'recording' ? pulseScale : 1 }] }}>
        <TouchableOpacity
          onPress={recordSample}
          disabled={stage === 'recording' || stage === 'training' || stage === 'uploading' || stage === 'downloading' || stage === 'activating' || samples.length >= REQUIRED_SAMPLES}
          style={[styles.button, (stage === 'recording' ? styles.buttonRecording : null)]}
        >
          <Text style={styles.buttonText}>
            {samples.length >= REQUIRED_SAMPLES ? 'All samples captured' : 'Record sample'}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {samples.length >= REQUIRED_SAMPLES && stage !== 'complete' && (
        <TouchableOpacity
          onPress={trainModel}
          disabled={stage === 'training' || stage === 'uploading' || stage === 'downloading' || stage === 'activating'}
          style={[styles.button, styles.trainButton]}
        >
          <Text style={styles.buttonText}>Train model on desktop</Text>
        </TouchableOpacity>
      )}

      <View style={styles.statusBox}>
        {(stage === 'training' || stage === 'uploading' || stage === 'downloading' || stage === 'activating') && (
          <ActivityIndicator size="small" color="#1f8eed" />
        )}
        <Text style={styles.statusText}>{statusMsg}</Text>
        {lastSavedAt && (
          <Text style={styles.timestamp}>Last trained: {new Date(lastSavedAt).toLocaleString()}</Text>
        )}
      </View>

      <TouchableOpacity onPress={onCancel} style={styles.cancelButton}>
        <Text style={styles.cancelText}>Close</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 60 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#fff', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#aaa', marginBottom: 20, lineHeight: 20 },
  label: { fontSize: 14, color: '#ccc', marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: '#222',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#1f8eed',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonRecording: { backgroundColor: '#d33' },
  trainButton: { backgroundColor: '#2a9d3f', marginTop: 16 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  statusBox: {
    marginTop: 20,
    padding: 14,
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
  },
  statusText: { color: '#ddd', fontSize: 14, marginTop: 6, lineHeight: 20 },
  timestamp: { color: '#888', fontSize: 12, marginTop: 8 },
  cancelButton: { marginTop: 24, alignItems: 'center' },
  cancelText: { color: '#888', fontSize: 14 },
});
