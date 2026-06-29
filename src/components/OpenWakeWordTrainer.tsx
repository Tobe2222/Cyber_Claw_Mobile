/**
 * OpenWakeWordTrainer — Record user samples + ship them to the
 * desktop for openWakeWord training. v3.2.0.
 *
 * Replaces the old DTW-based WakeWordTrainerV2 with a flow that
 * drives the real openWakeWord training pipeline (Piper TTS
 * synthesis → melspec → DNN training → TFLite export) running
 * on the desktop's GPU.
 *
 * Flow:
 *  1. User types the wake phrase (e.g. "hey clawsuu")
 *  2. User records 6 samples of the phrase on the phone
 *  3. Samples are sent to the desktop via sync-server WS
 *  4. Desktop spawns scripts/train_wake_phrase.py, streams
 *     progress back as 'wake_training_progress' messages
 *  5. On completion, desktop sends 'wake_training_result'
 *     with the .tflite path
 *  6. Phone fetches the .tflite bytes via 'read_wake_model'
 *  7. Phone hot-swaps it into the running OpenWakeWordDetector
 *     via WakeWordModule.setWakeModelFromBase64
 *  8. Model is persisted across app restarts (the Kotlin
 *     side saves the file to filesDir/wake_models/)
 *
 * The user sees a step-by-step progress UI driven by the
 * 'stage' field in each progress message:
 *   - setup
 *   - generating_synthetic (Piper TTS doing the heavy lifting)
 *   - augmenting
 *   - training (DNN, takes 1-10 minutes)
 *   - converting (TFLite export)
 *   - complete
 *
 * Why the desktop does the training: it has the GPU, the
 * 17GB ACAV100M feature file, the Piper voice models, and the
 * 200MB trained TFLite is small enough to ship back over the
 * WS in <1s.
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
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import syncClient from '../services/SyncClient';

const { WakeWordModule } = NativeModules;

const REQUIRED_SAMPLES = 6;  // 6 is a sweet spot for the synthetic-amplified pipeline
                              // (openWakeWord's docs say "as few as 5" works with
                              // the 10K synthetic positives the desktop generates)

interface Props {
  companionId: string;
  companionName: string;
  onComplete: (ok: boolean) => void;
  onCancel: () => void;
}

type Stage =
  | 'idle'
  | 'recording'
  | 'uploading'
  | 'generating_synthetic'
  | 'augmenting'
  | 'training'
  | 'converting'
  | 'downloading'
  | 'activating'
  | 'complete'
  | 'error';

const STAGE_LABEL: Record<Stage, string> = {
  idle: 'Ready to record',
  recording: '🎤 Recording...',
  uploading: '📤 Sending samples to desktop...',
  generating_synthetic: '🗣️ Generating wake samples with AI voice (this is the slow part)...',
  augmenting: '🔊 Augmenting + computing features...',
  training: '🧠 Training neural network (1-10 min on the desktop GPU)...',
  converting: '📦 Converting model to phone format...',
  downloading: '⬇️ Downloading trained model...',
  activating: '✅ Activating on this device...',
  complete: '🎉 Done!',
  error: '❌ Error',
};

export default function OpenWakeWordTrainer({ companionId, companionName, onComplete, onCancel }: Props) {
  const [wakePhrase, setWakePhrase] = useState(`hey ${companionName}`);
  const [samples, setSamples] = useState<string[]>([]);  // absolute paths
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  // Cleanup on unmount: stop any in-flight recorder and stop listening
  // for progress events from the sync server.
  useEffect(() => {
    // v3.2.6: on mount, ask the desktop if there's a recent wake
    // training result for this companion. The user may have lost
    // their socket mid-training (Android killed the WebSocket, brief
    // network blip, app was backgrounded) and the desktop finished
    // the run while we were offline. The desktop caches the last
    // result per agent for 15 minutes — if it's there, we can pick
    // up where the training left off without re-recording samples.
    // Only do this when the trainer is in the idle state, so we
    // don't conflate a fresh training with a cached previous one.
    const sync = syncClient;
    const queryLatest = () => {
      if (sync?.connected) {
        sync.requestLatestWakeTrainingResult(companionId);
      }
    };
    if (stage === 'idle') {
      if (sync?.connected) {
        queryLatest();
      } else {
        const onAuth = () => {
          sync?.off?.('authenticated', onAuth);
          queryLatest();
        };
        sync?.on?.('authenticated', onAuth);
      }
    }

    return () => {
      try { getSimpleAudioRecorder().stop(); } catch (_) {}
      try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
      const s = syncClient;
      s?.off?.('wake_training_progress', _onProgress);
      s?.off?.('wake_training_result', _onResult);
      s?.off?.('wake_model_data', _onModel);
    };
  }, [companionId, stage]);

  // v3.2.7: training-result watchdog. While the trainer is in any
  // non-terminal stage (uploading / generating_synthetic / augmenting
  // / training / converting), poll the desktop every 20s for the
  // cached result. This is belt + suspenders to the v3.2.6 mount-time
  // poll — that one only fires when the user navigates into the
  // trainer screen; this one fires even if the user just stares at
  // the stuck progress bar.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const terminalStages: Stage[] = ['idle', 'complete', 'error', 'recording'];
    if (terminalStages.includes(stage)) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }
    // We're in a training-active stage. Poll every 20s.
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => {
      const s = syncClient;
      if (s?.connected) {
        s.requestLatestWakeTrainingResult(companionId);
      }
    }, 20000);
    // Also re-poll immediately on every (re)authentication. If the
    // WebSocket dropped mid-training, the re-auth is the first
    // chance we have to ask the desktop "did you finish?".
    const onAuth = () => {
      const s = syncClient;
      if (s?.connected) {
        s.requestLatestWakeTrainingResult(companionId);
      }
    };
    syncClient?.on?.('authenticated', onAuth);
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      syncClient?.off?.('authenticated', onAuth);
    };
  }, [stage, companionId]);

  // Android back button: confirm if mid-training
  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stage === 'idle' || stage === 'complete' || stage === 'error') {
        onCancel();
        return true;
      }
      Alert.alert('Cancel training?', 'The training is in progress. Cancel and lose progress?', [
        { text: 'Stay', style: 'cancel' },
        { text: 'Cancel training', style: 'destructive', onPress: () => onCancel() },
      ]);
      return true;
    });
    return () => handler.remove();
  }, [stage, onCancel]);

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

  // ----- recording -----
  // Hard max duration for a single sample. The native side's silence
  // detection is normally what stops us, but we cap as a safety net so a
  // runaway mic can't hold the user hostage.
  const MAX_SAMPLE_MS = 4000;

  const recordOne = useCallback(async (): Promise<string | null> => {
    if (isRecording) return null;
    setIsRecording(true);
    startPulse();
    try {
      // v3.1.66: stop the wake listener so the user's own voice
      // saying the wake phrase doesn't trigger WakeMode mid-training
      try { await WakeWordModule?.stopSampleListening?.(); } catch (_) {}

      const recorder = getSimpleAudioRecorder();
      const filename = `wake_sample_${Date.now()}.m4a`;
      const path = `${RNFS.CachesDirectoryPath}/${filename}`;
      // Start with a short silence timeout so single-word phrases stop
      // quickly once the user is done speaking. The actual stop happens
      // via the 'silence' event below — never immediately after start.
      await recorder.start(path, 1500);

      // v3.2.4: WAIT for the silence event before stopping. The previous
      // code called stop() right after start(), which made
      // MediaRecorder.stop() throw "stop failed" because no frames had
      // been written yet. Race the silence event against a hard cap so
      // a quiet room (or a stuck mic) can't hang us forever.
      const stopped: { v: boolean } = { v: false };
      const doStop = async (): Promise<string | null> => {
        if (stopped.v) return null;
        stopped.v = true;
        try {
          return await recorder.stop();
        } catch (e: any) {
          // MediaRecorder.stop() throws "stop failed" if the recorder
          // was in a bad state. Try once more after a short reset
          // window; if it still fails, surface the error.
          await new Promise((r) => setTimeout(r, 150));
          try {
            return await recorder.stop();
          } catch (_) {
            throw e;
          }
        }
      };

      const finalPath: string | null = await new Promise((resolve) => {
        const offSilence = recorder.once('silence', () => {
          doStop().then(resolve).catch(() => resolve(null));
        });
        setTimeout(() => {
          offSilence();
          doStop().then(resolve).catch(() => resolve(null));
        }, MAX_SAMPLE_MS);
      });

      return finalPath || path;
    } catch (e: any) {
      Alert.alert('Recording failed', e?.message || 'Unknown error');
      return null;
    } finally {
      stopPulse();
      setIsRecording(false);
    }
  }, [isRecording]);

  const onTapToRecord = useCallback(async () => {
    if (samples.length >= REQUIRED_SAMPLES) return;
    if (!wakePhrase.trim()) {
      Alert.alert('Pick a phrase', 'Type what you want the wake word to be.');
      return;
    }
    const path = await recordOne();
    if (path) {
      setSamples((s) => [...s, path]);
    }
  }, [samples.length, wakePhrase, recordOne]);

  const clearSamples = useCallback(() => {
    setSamples((prev) => {
      // Best-effort delete of the temp files
      for (const p of prev) {
        RNFS.unlink(p).catch(() => {});
      }
      return [];
    });
  }, []);

  // ----- progress event handlers (refs so the cleanup useEffect can reach them) -----
  const _onProgress = useRef((msg: any) => {
    if (msg?.stage) {
      const stageMap: Record<string, Stage> = {
        setup: 'uploading',
        generating_synthetic: 'generating_synthetic',
        augmenting: 'augmenting',
        training: 'training',
        converting: 'converting',
        complete: 'downloading',
      };
      const newStage = stageMap[msg.stage] || 'training';
      setStage(newStage);
      setProgress(msg.percent || 0);
      if (msg.message) setStatusMsg(msg.message);
    }
  }).current;

  const _onResult = useRef(async (msg: any) => {
    if (msg?.noResult) {
      // v3.2.6: the desktop has no cached result for this agent.
      // The user hasn't trained yet (or the result expired). Just
      // stay on the idle screen and let them record fresh samples.
      return;
    }
    if (!msg?.ok) {
      setStage('error');
      setStatusMsg(msg?.error || 'Training failed on the desktop.');
      return;
    }
    // Got a successful training result; fetch the .tflite bytes.
    setStage('downloading');
    setProgress(95);
    setStatusMsg('Downloading trained model...');
    const sync = syncClient;
    if (!sync) {
      setStage('error');
      setStatusMsg('Lost connection to desktop.');
      return;
    }
    sync.readWakeModel(msg.tflitePath);
  }).current;

  const _onModel = useRef(async (msg: any) => {
    if (!msg?.ok || !msg?.base64) {
      setStage('error');
      setStatusMsg(msg?.error || 'Could not fetch the trained model.');
      return;
    }
    // Hot-swap into the running wake detector.
    setStage('activating');
    setProgress(98);
    setStatusMsg('Activating on this device...');
    try {
      const savedPath: string = await WakeWordModule.setWakeModelFromBase64(
        companionId,
        msg.base64,
        wakePhrase,
      );
      setStage('complete');
      setProgress(100);
      setStatusMsg(`Wake word ready. Saved to ${savedPath}`);
      // Clean up the sample WAVs from cache
      clearSamples();
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Activation failed: ${e?.message || 'unknown'}`);
    }
  }).current;

  // ----- start training -----
  const startTraining = useCallback(async () => {
    if (samples.length < REQUIRED_SAMPLES) {
      Alert.alert('Need more samples', `Please record ${REQUIRED_SAMPLES} samples. You have ${samples.length}.`);
      return;
    }
    const sync = syncClient;
    if (!sync?.connected) {
      Alert.alert('Not connected', 'Connect to the desktop before training.');
      return;
    }
    // Subscribe to progress events for this training job
    sync.on('wake_training_progress', _onProgress);
    sync.on('wake_training_result', _onResult);
    sync.on('wake_model_data', _onModel);

    setStage('uploading');
    setProgress(5);
    setStatusMsg('Sending samples to desktop...');

    // v3.2.7: poll for the cached result 10s after we fire the
    // request. If our WebSocket dies during the readFile loop or
    // during the first second of training, this catches it without
    // making the user wait the full 20s watchdog interval.
    const earlyPoll = setTimeout(() => {
      if (syncClient?.connected) {
        syncClient.requestLatestWakeTrainingResult(companionId);
      }
    }, 10000);

    try {
      // v3.2.5: ship the audio bytes themselves, not the on-phone
      // file paths. The desktop can't reach the phone's filesystem
      // (`/data/user/0/com.cyberclawmobile/cache/...`) so it always
      // reported "sample not found". Read each .m4a as base64 and
      // let the desktop decode and write it to its training dir.
      const encoded: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        const name = p.split('/').pop() || `sample_${i}.m4a`;
        // readFile with 'base64' returns the raw base64 string.
        const data = await RNFS.readFile(p, 'base64');
        encoded.push({ name, data });
        setProgress(5 + Math.round(((i + 1) / samples.length) * 25));
      }
      sync.requestWakeTraining(companionId, wakePhrase.trim(), encoded);
    } catch (e: any) {
      clearTimeout(earlyPoll);
      setStage('error');
      setStatusMsg(`Failed to start: ${e?.message || 'unknown'}`);
    }
  }, [samples, companionId, wakePhrase, _onProgress, _onResult, _onModel, clearSamples]);

  // ----- render -----
  const isTrainingInProgress = !['idle', 'complete', 'error'].includes(stage);
  const isFinished = stage === 'complete' || stage === 'error';

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Train wake word for {companionName}</Text>
        <Text style={styles.subtitle}>
          Say the phrase {REQUIRED_SAMPLES} times. The desktop uses these as a seed
          to generate thousands of variants, then trains a tiny neural network that
          recognizes the phrase on this device.
        </Text>

        {!isTrainingInProgress && !isFinished && (
          <View style={styles.phraseRow}>
            <Text style={styles.label}>Wake phrase</Text>
            <TextInput
              style={styles.input}
              value={wakePhrase}
              onChangeText={setWakePhrase}
              placeholder="hey clawsuu"
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={40}
            />
          </View>
        )}

        {/* Progress UI during training */}
        {isTrainingInProgress && (
          <View style={styles.progressCard}>
            <Text style={styles.stageLabel}>{STAGE_LABEL[stage]}</Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.max(2, progress)}%` }]} />
            </View>
            <Text style={styles.progressPct}>{Math.round(progress)}%</Text>
            {statusMsg ? <Text style={styles.statusMsg}>{statusMsg}</Text> : null}
            {stage === 'generating_synthetic' || stage === 'training' ? (
              <Text style={styles.hint}>
                This can take 2-10 minutes depending on your desktop GPU. You can
                close the app and the desktop will keep going — the model will
                activate next time you open this companion.
              </Text>
            ) : null}
          </View>
        )}

        {/* Recording UI */}
        {!isTrainingInProgress && !isFinished && (
          <View style={styles.recordCard}>
            <Text style={styles.label}>Samples recorded: {samples.length} / {REQUIRED_SAMPLES}</Text>
            <Animated.View style={[styles.recordBtn, { transform: [{ scale: pulseAnim }] }]}>
              <TouchableOpacity
                style={styles.recordInner}
                onPress={onTapToRecord}
                disabled={isRecording || samples.length >= REQUIRED_SAMPLES}
                activeOpacity={0.7}
              >
                <Text style={styles.recordIcon}>
                  {isRecording ? '🔴' : '🎤'}
                </Text>
                <Text style={styles.recordHint}>
                  {samples.length >= REQUIRED_SAMPLES
                    ? 'All samples recorded — ready to train'
                    : isRecording
                    ? 'Listening…'
                    : 'Tap to record one sample'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
            {samples.length > 0 && (
              <TouchableOpacity onPress={clearSamples} style={styles.clearBtn}>
                <Text style={styles.clearBtnText}>Clear all samples</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Done / Error state */}
        {isFinished && (
          <View style={styles.doneCard}>
            <Text style={[styles.stageLabel, { color: stage === 'complete' ? '#10b981' : '#ef4444' }]}>
              {STAGE_LABEL[stage]}
            </Text>
            {statusMsg ? <Text style={styles.statusMsg}>{statusMsg}</Text> : null}
            <TouchableOpacity
              style={styles.doneBtn}
              onPress={() => onComplete(stage === 'complete')}
            >
              <Text style={styles.doneBtnText}>
                {stage === 'complete' ? '✓ Done' : 'Close'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Bottom bar — context-sensitive action */}
      {!isTrainingInProgress && !isFinished && (
        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              samples.length < REQUIRED_SAMPLES && { opacity: 0.4 },
            ]}
            onPress={startTraining}
            disabled={samples.length < REQUIRED_SAMPLES}
          >
            <Text style={styles.primaryBtnText}>
              {samples.length < REQUIRED_SAMPLES
                ? `Train (need ${REQUIRED_SAMPLES - samples.length} more)`
                : `Train "${wakePhrase}" →`}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 100 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  subtitle: { color: '#9ca3af', fontSize: 14, lineHeight: 20, marginBottom: 24 },
  phraseRow: { marginBottom: 24 },
  label: { color: '#9ca3af', fontSize: 13, marginBottom: 8, fontWeight: '600' },
  input: {
    backgroundColor: '#1f1f1f',
    color: '#fff',
    padding: 14,
    borderRadius: 10,
    fontSize: 18,
    borderWidth: 1,
    borderColor: '#333',
  },
  recordCard: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  recordBtn: { marginVertical: 16 },
  recordInner: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#1f1f1f',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  recordIcon: { fontSize: 48 },
  recordHint: { color: '#9ca3af', fontSize: 12, marginTop: 4, textAlign: 'center' },
  clearBtn: { marginTop: 8, padding: 8 },
  clearBtnText: { color: '#ef4444', fontSize: 13 },
  progressCard: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  stageLabel: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 12 },
  progressBar: {
    height: 10,
    backgroundColor: '#1f1f1f',
    borderRadius: 5,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#3b82f6' },
  progressPct: { color: '#9ca3af', fontSize: 12, textAlign: 'right', marginTop: 6 },
  statusMsg: { color: '#6b7280', fontSize: 12, marginTop: 8, fontStyle: 'italic' },
  hint: { color: '#6b7280', fontSize: 12, marginTop: 12, lineHeight: 18 },
  doneCard: {
    backgroundColor: '#141414',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  doneBtn: {
    marginTop: 20,
    backgroundColor: '#3b82f6',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#1f1f1f',
    flexDirection: 'row',
    gap: 12,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#3b82f6',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#1f1f1f',
    alignItems: 'center',
  },
  cancelBtnText: { color: '#9ca3af', fontSize: 14 },
});