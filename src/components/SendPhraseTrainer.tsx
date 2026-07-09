/**
 * SendPhraseTrainer — Record user samples + train a send-word model.
 * v3.8.3.
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
 *
 * v3.8.3: rewrote the trainer body to match the wake-word
 * trainer's step-by-step UX. The previous version had a flat
 * "Tap to record / Status text" layout with no progress
 * indicator, no stage label, no logging card, and no
 * elapsed-time / last-event / event-log display. If the
 * desktop hung mid-training (e.g. it never received the
 * request because the case was missing), the user just saw
 * "Uploading samples to desktop…" spin indefinitely with no
 * indication of where the run actually was. The new layout
 * mirrors `OpenWakeWordTrainer.tsx` so the user can tell
 * at a glance whether the desktop is actively progressing
 * or stuck.
 *
 * Also bumped the top padding from 20 to 60 + SafeAreaView
 * so the title clears the system status bar — Tobe reported
 * "Train Send Word" being clipped on his phone.
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
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import RNFS from 'react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  generating_synthetic: '🗣️ Generating send-word samples with AI voice (this is the slow part)...',
  augmenting: '🔊 Augmenting + computing features...',
  training: '🧠 Training neural network (1-10 min on the desktop GPU)...',
  converting: '📦 Converting model to phone format...',
  downloading: '⬇️ Downloading trained model...',
  activating: '✅ Activating on this device...',
  complete: '🎉 Done!',
  error: '❌ Error',
};

// v3.8.3: time-formatting helpers for the logging panel.
// Mirror of `OpenWakeWordTrainer.tsx` so the two trainers
// read identically.
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function formatClock(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function SendPhraseTrainer({ presetPhrase, onCancel, onComplete }: {
  presetPhrase?: string;
  onCancel: () => void;
  onComplete?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [phrase, setPhrase] = useState(presetPhrase ?? DEFAULT_PHRASE);
  const [samples, setSamples] = useState<string[]>([]);  // WAV file paths
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  // v3.8.3: logging state. Same shape as `OpenWakeWordTrainer.tsx`
  // so the user can tell at a glance whether the desktop is
  // actively progressing or stuck. `eventLog` is a rolling 50-entry
  // timeline surfaced in the logging card; `lastEventAt` powers
  // the color-coded "Ns ago" indicator.
  const [lastEventAt, setLastEventAt] = useState<number>(0);
  const [trainingStartedAt, setTrainingStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const [eventLog, setEventLog] = useState<Array<{ ts: number; msg: string }>>([]);
  const [isRecording, setIsRecording] = useState(false);

  // Animation pulse for the record button.
  const pulse = useRef(new Animated.Value(0)).current;

  // Internal flag so the JS side and the native side agree on
  // whether a recording is in progress.
  const isRecordingRef = useRef(false);

  // Back button: confirm exit if there are unsaved samples.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const terminalStages: Stage[] = ['idle', 'complete', 'error'];
      if (terminalStages.includes(stage)) {
        onCancel();
        return true;
      }
      if (stage === 'recording') return true;
      if (samples.length > 0 && !terminalStages.includes(stage)) {
        Alert.alert('Cancel training?', 'The training is in progress. Cancel and lose progress?', [
          { text: 'Stay', style: 'cancel' },
          { text: 'Cancel training', style: 'destructive', onPress: () => onCancel() },
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

  // v3.8.3: 1-second tick while training is active. Mirrors
  // the same effect in `OpenWakeWordTrainer.tsx` — without it,
  // the "Ns ago" indicator in the logging card never updates.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const activeStages: Stage[] = ['uploading', 'generating_synthetic', 'augmenting', 'training', 'converting', 'downloading'];
    if (activeStages.includes(stage)) {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    } else {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [stage]);

  // v3.8.3: v3.8.2 watchdog pattern from the wake trainer —
  // when we mount in idle, ask the desktop if it has a cached
  // recent send result. Covers the case where the WebSocket
  // died mid-training and the desktop finished the run while
  // we were offline.
  useEffect(() => {
    const sync = syncClient;
    const queryLatest = () => {
      if (sync?.connected) {
        sync.requestLatestSendTrainingResult();
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
  }, [stage]);

  // v3.8.3: watchdog poll every 20s while training is active.
  // Same pattern as the wake trainer.
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
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(() => {
      const s = syncClient;
      console.log(`[SendTrainer] watchdog poll (stage=${stage} connected=${s?.connected})`);
      if (s?.connected) {
        s.requestLatestSendTrainingResult();
      }
    }, 20000);
    const onAuth = () => {
      const s = syncClient;
      if (s?.connected) {
        s.requestLatestSendTrainingResult();
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
  }, [stage]);

  // Listen for the native 'sampleRecordDone' event. The native
  // side fires this when stopSampleRecord() flips
  // isRawRecording = false and the WAV has been fully written.
  useEffect(() => {
    const { DeviceEventEmitter } = require('react-native');
    const onSampleDone = (params: { path: string; bytes: number }) => {
      isRecordingRef.current = false;
      setIsRecording(false);
      setStage('idle');
      setSamples(prev => [...prev, params.path]);
      const nextCount = samples.length + 1;
      if (nextCount >= REQUIRED_SAMPLES) {
        setStatusMsg(`Sample ${nextCount}/${REQUIRED_SAMPLES} captured (${(params.bytes / 1024).toFixed(1)} KB). All samples captured. Tap "Train model" to continue.`);
      } else {
        setStatusMsg(`Sample ${nextCount}/${REQUIRED_SAMPLES} captured (${(params.bytes / 1024).toFixed(1)} KB).`);
      }
      stopPulse();
    };
    const sub = DeviceEventEmitter.addListener('sampleRecordDone', onSampleDone);
    return () => sub.remove();
  }, [samples.length, stopPulse]);

  // v3.8.3: attach the training listeners ONCE on mount and
  // never remove. Same v3.2.12 fix from the wake trainer —
  // attach-then-remove-inside-startTraining was attaching for
  // ~10ms before the next React render removed them, dropping
  // every progress event on the floor.
  const _onProgress = useRef((msg: any) => {
    console.log(`[SendTrainer] _onProgress: stage=${msg?.stage} pct=${msg?.percent}`);
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
      const t = Date.now();
      setLastEventAt(t);
      setNow(t);
      const logMsg = msg.message
        ? `${Math.round(msg.percent || 0)}% — ${msg.message}`
        : `${Math.round(msg.percent || 0)}% — ${msg.stage}`;
      setEventLog((prev) => {
        const next = [...prev, { ts: t, msg: logMsg }];
        return next.slice(-50);
      });
    }
  }).current;

  const _onResult = useRef(async (msg: any) => {
    // v3.8.3: any send_training_result from the desktop counts
    // as activity — bump lastEventAt so the "Ns ago" indicator
    // resets.
    if (!msg?.noResult) {
      const t = Date.now();
      setLastEventAt(t);
      setNow(t);
      setEventLog((prev) => [
        ...prev,
        {
          ts: t,
          msg: msg?.ok
            ? `Result: ok — model at ${msg.tflitePath?.split('/').pop()}`
            : `Result: error — ${msg?.error || 'unknown'}`,
        },
      ].slice(-50));
    }
    if (msg?.noResult) {
      // No cached result on the desktop — user hasn't trained yet
      // (or the cache expired). Stay on the idle screen.
      return;
    }
    if (!msg?.ok) {
      setStage('error');
      setStatusMsg(msg?.error || 'Training failed on the desktop.');
      return;
    }
    setStage('downloading');
    setProgress(95);
    setStatusMsg('Downloading trained send model...');
    const sync = syncClient;
    if (!sync) {
      setStage('error');
      setStatusMsg('Lost connection to desktop.');
      return;
    }
    sync.readSendModel(msg.tflitePath);
  }).current;

  const _onModel = useRef(async (msg: any) => {
    if (!msg?.ok || !msg?.base64) {
      setStage('error');
      setStatusMsg(msg?.error || 'Could not fetch the trained send model.');
      return;
    }
    setStage('activating');
    setProgress(98);
    setStatusMsg('Activating on this device...');
    try {
      const savedPath: string = await WakeWordModule.setSendModelFromBase64(
        phrase.trim(),
        msg.base64,
      );
      setStage('complete');
      setProgress(100);
      setStatusMsg(`Send word ready. Saved to ${savedPath.split('/').pop()}.`);
      try {
        await AsyncStorage.setItem(
          getSendSamplesKey(phrase.trim()),
          JSON.stringify({ trainedAt: Date.now(), modelPath: savedPath.split('/').pop() }),
        );
      } catch (_) {}
      // Clean up the sample WAVs from cache
      for (const wav of samples) RNFS.unlink(wav).catch(() => {});
      setSamples([]);
      onComplete?.();
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Activation failed: ${e?.message ?? e}`);
    }
  }).current;

  useEffect(() => {
    const s = syncClient;
    s?.on?.('send_training_progress', _onProgress);
    s?.on?.('send_training_result', _onResult);
    s?.on?.('send_model_data', _onModel);
    return () => {
      s?.off?.('send_training_progress', _onProgress);
      s?.off?.('send_training_result', _onResult);
      s?.off?.('send_model_data', _onModel);
    };
  }, [_onProgress, _onResult, _onModel]);

  const recordSample = useCallback(async () => {
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    setStage('recording');
    setStatusMsg('🔴 Recording… say the word');
    startPulse();

    const wavPath = `${RNFS.TemporaryDirectoryPath}/send-sample-${Date.now()}.wav`;
    try {
      await WakeWordModule.startSampleRecord(wavPath);
      // Safety cap: if the user forgets to tap Stop, force-stop after 4 s.
      setTimeout(() => {
        if (isRecordingRef.current) {
          WakeWordModule.stopSampleRecord().catch(() => {});
        }
      }, 4000);
    } catch (e: any) {
      isRecordingRef.current = false;
      setIsRecording(false);
      setStage('error');
      setStatusMsg(`Recording failed: ${e?.message ?? e}`);
      stopPulse();
    }
  }, [startPulse, stopPulse]);

  const stopRecording = useCallback(async () => {
    if (stage !== 'recording') return;
    try {
      await WakeWordModule.stopSampleRecord();
    } catch (e: any) {
      setStage('error');
      setStatusMsg(`Stop failed: ${e?.message ?? e}`);
    }
  }, [stage]);

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

    setStage('uploading');
    setProgress(5);
    setStatusMsg('Sending samples to desktop...');
    setEventLog([{ ts: Date.now(), msg: 'Started — sending samples to desktop...' }]);
    setLastEventAt(Date.now());
    setTrainingStartedAt(Date.now());
    setNow(Date.now());

    // Encode WAVs as base64 for the sync payload.
    const wavPaths = [...samples];
    const encoded: Array<{ name: string; data: string }> = [];
    for (let i = 0; i < wavPaths.length; i++) {
      const p = wavPaths[i];
      try {
        const b64 = await RNFS.readFile(p, 'base64');
        encoded.push({ name: p.split('/').pop() ?? 'sample.wav', data: b64 });
        setProgress(5 + Math.round(((i + 1) / wavPaths.length) * 25));
      } catch (_) {}
    }

    // v3.8.3: poll for the cached result 10s after we fire
    // the request — covers the case where the WebSocket
    // dies during the readFile loop.
    const earlyPoll = setTimeout(() => {
      if (syncClient?.connected) {
        syncClient.requestLatestSendTrainingResult();
      }
    }, 10000);

    try {
      await sync.requestSendTraining(trimmed, encoded);
    } catch (e: any) {
      clearTimeout(earlyPoll);
      setStage('error');
      setStatusMsg(`Could not send training request: ${e?.message ?? e}`);
    }
  }, [phrase, samples]);

  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] });

  const isTrainingInProgress = !['idle', 'complete', 'error', 'recording'].includes(stage);
  const isFinished = stage === 'complete' || stage === 'error';

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: Math.max(insets.top + 12, 60) },
        ]}
      >
        <Text style={styles.title}>Train Send Word</Text>

        <Text style={styles.subtitle}>
          Record the word you'll say to commit a turn (e.g. "send", "go", "done").
          The model runs on-device so it works even in noisy rooms where silence
          detection can't tell your voice from background talk.
        </Text>

        {!isTrainingInProgress && !isFinished && (
          <View style={styles.phraseRow}>
            <Text style={styles.label}>Send word</Text>
            <TextInput
              value={phrase}
              onChangeText={setPhrase}
              editable={true}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={40}
              placeholder="send"
              placeholderTextColor="#666"
            />
          </View>
        )}

        {/* Recording UI */}
        {!isTrainingInProgress && !isFinished && (
          <View style={styles.recordCard}>
            <Text style={styles.label}>
              Samples recorded: {samples.length} / {REQUIRED_SAMPLES}
            </Text>
            <Animated.View style={{ transform: [{ scale: stage === 'recording' ? pulseScale : 1 }] }}>
              <TouchableOpacity
                onPress={stage === 'recording' ? stopRecording : recordSample}
                disabled={(samples.length >= REQUIRED_SAMPLES)}
                style={[styles.recordBtn, stage === 'recording' ? styles.recordBtnRecording : null]}
              >
                <Text style={styles.recordIcon}>
                  {stage === 'recording' ? '🔴' : '🎤'}
                </Text>
                <Text style={styles.recordHint}>
                  {samples.length >= REQUIRED_SAMPLES
                    ? 'All samples captured — ready to train'
                    : stage === 'recording'
                    ? 'Listening… tap to stop'
                    : 'Tap to record one sample'}
                </Text>
              </TouchableOpacity>
            </Animated.View>
            {samples.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  for (const p of samples) RNFS.unlink(p).catch(() => {});
                  setSamples([]);
                }}
                style={styles.clearBtn}
              >
                <Text style={styles.clearBtnText}>Clear all samples</Text>
              </TouchableOpacity>
            )}
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

            <View style={styles.loggingCard}>
              <Text style={styles.loggingLine}>
                <Text style={styles.loggingLabel}>Elapsed: </Text>
                <Text style={styles.loggingValue}>
                  {formatElapsed(now - trainingStartedAt)}
                </Text>
                <Text style={styles.loggingLabel}>   ·   Last event: </Text>
                <Text style={[
                  styles.loggingValue,
                  lastEventAt === 0 ? null :
                  now - lastEventAt < 15 ? styles.loggingFresh :
                  now - lastEventAt < 60 ? styles.loggingAging :
                  styles.loggingStale
                ]}>
                  {lastEventAt === 0 ? '—' : `${Math.round((now - lastEventAt) / 1000)}s ago`}
                </Text>
              </Text>
              <Text style={styles.loggingLabel}>
                Recent events (latest at top):
              </Text>
              <ScrollView style={styles.eventLog} contentContainerStyle={styles.eventLogContent}>
                {[...eventLog].reverse().slice(0, 8).map((e, i) => (
                  <Text key={`${e.ts}-${i}`} style={styles.eventLogEntry}>
                    <Text style={styles.eventLogTs}>
                      [{formatClock(new Date(e.ts))}]
                    </Text>{' '}
                    {e.msg}
                  </Text>
                ))}
              </ScrollView>
            </View>

            {stage === 'generating_synthetic' || stage === 'training' ? (
              <Text style={styles.hint}>
                This can take 2-10 minutes depending on your desktop GPU. You can
                close the app and the desktop will keep going — the model will
                activate next time you open voice mode.
              </Text>
            ) : null}
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
              onPress={() => onComplete?.(stage === 'complete')}
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
            onPress={trainModel}
            disabled={samples.length < REQUIRED_SAMPLES}
          >
            <Text style={styles.primaryBtnText}>
              {samples.length < REQUIRED_SAMPLES
                ? `Train (need ${REQUIRED_SAMPLES - samples.length} more)`
                : `Train "${phrase.trim()}" →`}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { paddingHorizontal: 20, paddingBottom: 120 },
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
  recordBtn: {
    backgroundColor: '#1f1f1f',
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#3b82f6',
    marginVertical: 16,
  },
  recordBtnRecording: { borderColor: '#ef4444' },
  recordIcon: { fontSize: 48 },
  recordHint: { color: '#9ca3af', fontSize: 12, marginTop: 6, textAlign: 'center' },
  clearBtn: { marginTop: 12, padding: 8 },
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
  loggingCard: {
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  loggingLine: { color: '#d1d5db', fontSize: 12, marginBottom: 6, fontFamily: 'monospace' },
  loggingLabel: { color: '#9ca3af', fontSize: 11, fontFamily: 'monospace' },
  loggingValue: { color: '#fff', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },
  loggingFresh: { color: '#10b981' },
  loggingAging: { color: '#fbbf24' },
  loggingStale: { color: '#ef4444' },
  eventLog: { maxHeight: 140, marginTop: 4 },
  eventLogContent: { paddingBottom: 4 },
  eventLogEntry: { color: '#9ca3af', fontSize: 11, fontFamily: 'monospace', marginBottom: 2 },
  eventLogTs: { color: '#6b7280' },
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
