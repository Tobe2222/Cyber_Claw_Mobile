/**
 * ExitPhraseTrainer — Record user samples for the exit phrase.
 * v3.2.25 (refined in v3.4.9).
 *
 * Records 6 audio samples of the user's chosen exit phrase
 * (e.g. "thanks", "goodbye", "stop"). Each sample is captured
 * as raw PCM16 mono 16kHz WAV via WakeWordModule.startSampleRecord,
 * the WAV header is stripped on the JS side, and audio features
 * are extracted via extractAudioFeatures(). The features are
 * saved to AsyncStorage under the key `cyberclaw-exit-samples-
 * <phrase>`.
 *
 * IMPORTANT (v3.4.9): The runtime DTW detector that was
 * originally promised for v3.2.26 was NEVER wired. The
 * saved samples are NOT read by voice mode at runtime.
 * Exit detection today still uses the text-fallback
 * (ExitPhraseMatcher on the STT transcription).
 *
 * The trainer still has value: the saved features are the
 * foundation for the future runtime DTW work (just needs the
 * chat-recorder to write WAV alongside the existing m4a so
 * JS can decode it at silence-fire time), and recording UX
 * is iterated in isolation here.
 *
 * v3.4.9: Updated the in-trainer status + description strings
 * to reflect the current behavior (no more "v3.2.26 will wire
 * this" promise — that release shipped months ago without
 * the runtime wiring). The text-fallback continues to do the
 * actual exit detection.
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
import { NativeModules } from 'react-native';
import { AudioFeatures, extractAudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';
import {
  getExitSamplesKey,
  saveExitSamples,
  clearExitSamples,
  loadExitSamples,
} from '../services/VoiceSettings';

const { WakeWordModule } = NativeModules;

const REQUIRED_SAMPLES = 6;
const DEFAULT_PHRASE = 'thanks';

type Stage = 'idle' | 'recording' | 'saving' | 'complete' | 'error';

export default function ExitPhraseTrainer({ companionId, presetPhrase, onCancel, onComplete }: {
  // v3.4.0: companionId is REQUIRED for per-companion
  // storage. The trainer writes its samples to
  // cyberclaw-exit-samples-<companionId>-<phrase>
  // and the active phrase to
  // cyberclaw-exit-phrase-<companionId>.
  // v3.3.0: optional preset phrase. When set, the
  // trainer's TextInput initializes with this string
  // instead of the default 'thanks'. Used by the
  // per-row "Retrain" button in the new ExitPhrasePicker
  // to pre-fill the trainer with the existing phrase so
  // the user can re-record samples without accidentally
  // training a different word. If the user changes the
  // phrase text and saves, it becomes a new entry in the
  // pickup list (the old one stays until manually
  // deleted) — which is the same behavior as first-time
  // training.
  companionId: string;
  presetPhrase?: string;
  onCancel: () => void;
  onComplete?: () => void;
}) {
  // v3.3.0: preset phrase overrides the default when
  // present (retrain path). First-time training still
  // starts from 'thanks' for backwards compatibility.
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
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [samples.length, stage, onCancel]);

  // Listen for the native sampleRecordDone event. Emitted when
  // the WAV file has been fully written. We pull the file and
  // advance the training flow.
  useEffect(() => {
    const onSampleDone = (params: { path: string; bytes: number }) => {
      isRecordingRef.current = false;
      setStage('idle');
      setStatusMsg(`Sample ${samples.length + 1}/${REQUIRED_SAMPLES} captured (${(params.bytes / 1024).toFixed(1)} KB).`);
      setSamples(prev => [...prev, params.path]);
    };
    const emitter = WakeWordModule;
    if (!emitter) return;
    const { DeviceEventEmitter } = require('react-native');
    const sub = DeviceEventEmitter.addListener('sampleRecordDone', onSampleDone);
    return () => sub.remove();
  }, [samples.length]);

  const startRecording = useCallback(async () => {
    if (stage === 'recording') return;
    if (samples.length >= REQUIRED_SAMPLES) {
      setStatusMsg(`Already have ${REQUIRED_SAMPLES} samples. Save or clear to record more.`);
      return;
    }
    const trimmed = phrase.trim().toLowerCase();
    if (!trimmed) {
      setStatusMsg('Phrase cannot be empty.');
      return;
    }
    try {
      const samplePath = `${RNFS.TemporaryDirectoryPath}/cyberclaw-exit-sample-${Date.now()}.wav`;
      isRecordingRef.current = true;
      setStage('recording');
      setStatusMsg(`🔴 Recording sample ${samples.length + 1}/${REQUIRED_SAMPLES}... say "${trimmed}"`);
      await WakeWordModule.startSampleRecord(samplePath);
      // Safety: 4-second hard cap in case the user forgets to
      // tap Stop. JS doesn't get notified that the capture
      // stopped — auto-stops here.
      setTimeout(() => {
        if (isRecordingRef.current) {
          WakeWordModule.stopSampleRecord().catch(() => {});
        }
      }, 4000);
    } catch (e: any) {
      isRecordingRef.current = false;
      setStage('error');
      setStatusMsg(`Recording failed: ${e?.message || 'unknown'}`);
    }
  }, [stage, samples.length, phrase]);

  const stopRecording = useCallback(async () => {
    if (stage !== 'recording') return;
    try {
      await WakeWordModule.stopSampleRecord();
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Stop failed: ${e?.message || 'unknown'}`);
    }
  }, [stage]);

  const clearSamples = useCallback(() => {
    setSamples([]);
    setStage('idle');
    setStatusMsg('Samples cleared. Tap "Record sample" to start over.');
  }, []);

  const saveTraining = useCallback(async () => {
    if (samples.length < REQUIRED_SAMPLES) {
      setStatusMsg(`Need ${REQUIRED_SAMPLES} samples; you have ${samples.length}.`);
      return;
    }
    const trimmed = phrase.trim().toLowerCase();
    setStage('saving');
    setStatusMsg('Extracting features...');
    try {
      // Read each WAV, strip header, extract features.
      const featuresList: AudioFeatures[] = [];
      for (let i = 0; i < samples.length; i++) {
        const wavPath = samples[i];
        setStatusMsg(`Extracting features from sample ${i + 1}/${REQUIRED_SAMPLES}...`);
        const base64 = await RNFS.readFile(wavPath, 'base64');
        const pcm = base64ToInt16Array(base64);
        if (pcm.length < 1600) {  // < 100ms at 16kHz
          throw new Error(`Sample ${i + 1} too short: ${pcm.length / 16000}s`);
        }
        const features = extractAudioFeatures(pcm, 16000, 512);
        featuresList.push(features);
        // Best-effort cleanup of the temp WAV.
        RNFS.unlink(wavPath).catch(() => {});
      }
      await saveExitSamples(companionId, trimmed, featuresList);
      setLastSavedAt(Date.now());
      setStage('complete');
      // v3.4.9: was "v3.2.26 will wire this to the runtime
      // detector". That promise was never delivered — the
      // runtime DTW was never implemented. Exit detection
      // today still uses the text-fallback (ExitPhraseMatcher
      // on the STT transcription). Be honest with the user:
      // the saved samples are persisted for the future
      // runtime DTW work, but aren't currently used at
      // runtime.
      setStatusMsg(`✅ Saved ${featuresList.length} samples for "${trimmed}". Saved for the future runtime audio-DTW detector; today's exit detection still uses the text-fallback (matches your STT transcription).`);
      onComplete?.();
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Save failed: ${e?.message || 'unknown'}`);
    }
  }, [samples, phrase, onComplete]);

  const removeTraining = useCallback(async (existingPhrase: string) => {
    Alert.alert('Remove training?', `Clear saved training for "${existingPhrase}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearExitSamples(companionId, existingPhrase);
          setStatusMsg(`Cleared training for "${existingPhrase}".`);
        },
      },
    ]);
  }, []);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Train exit phrase</Text>
        <Text style={styles.subtitle}>
          {/* v3.4.9: was "Once v3.2.26 ships, voice mode will
              detect this phrase on the audio stream and exit
              immediately when it hears it — no need to wait
              for the LLM to transcribe." That release shipped
              months ago without wiring the runtime DTW.
              Current behavior: exit detection still uses the
              text-fallback on the STT transcription. The
              trained samples are saved for the future runtime
              DTW work but aren't read at runtime today. */}
          Say the same short word or phrase 6 times. Today's exit
          detection still uses the text-fallback (matches your STT
          transcription). The samples you record here are saved for
          the future runtime audio-DTW detector.
        </Text>

        <Text style={styles.label}>Phrase</Text>
        <TextInput
          style={styles.input}
          value={phrase}
          onChangeText={setPhrase}
          placeholder="e.g. thanks"
          placeholderTextColor="#555"
          autoCapitalize="none"
          maxLength={40}
          editable={stage !== 'recording'}
        />

        <Text style={styles.label}>Samples ({samples.length}/{REQUIRED_SAMPLES})</Text>
        <View style={styles.sampleRow}>
          {Array.from({ length: REQUIRED_SAMPLES }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.sampleDot,
                i < samples.length && styles.sampleDotFilled,
              ]}
            />
          ))}
        </View>

        <View style={styles.row}>
          {stage !== 'recording' ? (
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={startRecording}
              disabled={samples.length >= REQUIRED_SAMPLES}
            >
              <Text style={styles.btnText}>
                {samples.length >= REQUIRED_SAMPLES ? 'All captured' : '🔴 Record sample'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.btn, styles.btnDanger]}
              onPress={stopRecording}
            >
              <Text style={styles.btnText}>⏹ Stop</Text>
            </TouchableOpacity>
          )}
        </View>

        {samples.length > 0 && stage !== 'complete' && (
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={clearSamples}>
              <Text style={styles.btnText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, samples.length < REQUIRED_SAMPLES && styles.btnDisabled]}
              onPress={saveTraining}
              disabled={samples.length < REQUIRED_SAMPLES}
            >
              <Text style={styles.btnText}>💾 Save</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.statusBox}>
          {stage === 'saving' && <ActivityIndicator color="#f7931a" />}
          <Text style={styles.statusText}>{statusMsg}</Text>
        </View>

        {lastSavedAt && (
          <Text style={styles.savedHint}>
            ✅ Last saved at {new Date(lastSavedAt).toLocaleTimeString()}
          </Text>
        )}

        <View style={styles.divider} />
        <Text style={styles.sectionTitle}>Currently trained</Text>
        <TrainedPhraseList onRemove={removeTraining} />

        <TouchableOpacity style={[styles.btn, styles.btnSecondary, { marginTop: 24 }]} onPress={onCancel}>
          <Text style={styles.btnText}>Close</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

/** Inline list of currently-trained exit phrases. */
function TrainedPhraseList({ onRemove }: { onRemove: (p: string) => void }) {
  const [phrases, setPhrases] = useState<string[]>([]);
  const reload = useCallback(async () => {
    try {
      const keys = await RNFS.getAllKeys();
      const exitKeys = keys.filter(k => k.startsWith('cyberclaw-exit-samples-'));
      setPhrases(exitKeys.map(k => k.replace('cyberclaw-exit-samples-', '')));
    } catch (_) {}
  }, []);
  useEffect(() => { reload(); }, [reload]);
  if (phrases.length === 0) {
    return <Text style={styles.emptyHint}>No trained phrases yet.</Text>;
  }
  return (
    <View>
      {phrases.map((p) => (
        <View key={p} style={styles.trainedRow}>
          <Text style={styles.trainedPhrase}>{p}</Text>
          <TouchableOpacity onPress={() => onRemove(p)}>
            <Text style={styles.removeBtn}>Remove</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0c10' },
  scroll: { padding: 20, paddingBottom: 80 },
  title: {
    color: '#f7931a',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    color: '#aaa',
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 18,
  },
  label: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#1a1a22',
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    borderColor: '#333',
    borderWidth: 1,
  },
  sampleRow: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 8,
  },
  sampleDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#222',
    borderColor: '#444',
    borderWidth: 1,
  },
  sampleDotFilled: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignItems: 'center',
    flex: 1,
  },
  btnPrimary: {
    backgroundColor: '#f7931a',
  },
  btnSecondary: {
    backgroundColor: '#333',
  },
  btnDanger: {
    backgroundColor: '#dc2626',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '600',
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    padding: 12,
    backgroundColor: '#1a1a22',
    borderRadius: 6,
  },
  statusText: {
    color: '#ccc',
    fontSize: 13,
    flex: 1,
  },
  savedHint: {
    color: '#10b981',
    fontSize: 12,
    marginTop: 8,
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginVertical: 20,
  },
  sectionTitle: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyHint: {
    color: '#666',
    fontSize: 13,
    fontStyle: 'italic',
  },
  trainedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#1a1a22',
    borderRadius: 4,
    marginBottom: 6,
  },
  trainedPhrase: {
    color: '#fff',
    fontSize: 14,
  },
  removeBtn: {
    color: '#dc2626',
    fontSize: 13,
    fontWeight: '600',
  },
});