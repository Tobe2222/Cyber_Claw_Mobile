/** OpenWakeWordTrainer — Record user samples + ship them to the desktop for openWakeWord training. */

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
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  BackHandler,
  ActivityIndicator,
} from 'react-native';
import RNFS from 'react-native-fs';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import syncClient from '../services/SyncClient';
import { base64ToInt16Array } from '../services/AudioUtils';

const { WakeWordModule, BackgroundService } = NativeModules;

const REQUIRED_SAMPLES = 12;  // v3.10.59: bumped from 6 → 12. The desktop's
                              // synthetic-amplified pipeline can work with 6
                              // samples, but 12 gives a stronger acoustic
                              // foundation for the TFLite to learn from —
                              // especially across varied volumes, paces, and
                              // mic positions. Tobe's 6-sample training
                              // (2026-07-19) produced a model that scored 0%
                              // against his voice in production while the
                              // wake still fired reliably via Vosk text
                              // matching. More samples = more reliable TFLite
                              // output = better OWW primary detection.
                              // The training pipeline can still finish in
                              // under 5 minutes with 12 samples — the desktop
                              // GPU does the heavy lifting.
// v3.8.2: optional near-miss recording. Recommended 3
// (the script does an 80/20 train/test split so 2-3
// near-misses is enough to test that the model rejects
// them in validation). Optional — the user can skip
// and training proceeds with only TTS adversarial
// negatives.
const REQUIRED_NEAR_MISS_SAMPLES = 3;

// Generate suggested near-miss phrases from the wake phrase.
function suggestNearMisses(phrase: string, n: number = 3): string[] {
  const trimmed = phrase.trim();
  if (!trimmed) return [];
  const suggestions = new Set<string>();
  const words = trimmed.split(/\s+/);
  const first = words[0] || '';
  const last = words[words.length - 1] || '';

  // Drop trailing vowel from the last word
  if (last.length > 3) {
    suggestions.add(words.slice(0, -1).concat([last.replace(/[aeiou]$/, '')]).join(' '));
  }
  // Swap first word
  for (const alt of ['hi', 'ok', 'hey']) {
    if (alt !== first.toLowerCase()) {
      suggestions.add([alt, ...words.slice(1)].join(' '));
    }
  }
  // Change the last word slightly
  if (last.length >= 3) {
    const flipped = last.split('').reverse().join('');
    if (flipped !== last) suggestions.add(words.slice(0, -1).concat([flipped]).join(' '));
  }
  // Common phonetic confusion pairs
  for (const swap of [['s', 't'], ['k', 'g'], ['m', 'n'], ['p', 'b']]) {
    if (last.toLowerCase().includes(swap[0])) {
      const replaced = last.toLowerCase().replace(swap[0], swap[1]);
      if (replaced !== last) suggestions.add(words.slice(0, -1).concat([replaced]).join(' '));
    }
  }

  return Array.from(suggestions).slice(0, n);
}
                              // (openWakeWord's docs say "as few as 5" works with
                              // the 10K synthetic positives the desktop generates)

interface Props {
  companionId: string;
  companionName: string;
  // Optional preset phrase.
  presetPhrase?: string;
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

// v3.2.9: time-formatting helpers for the logging panel.
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

export default function OpenWakeWordTrainer({ companionId, companionName, presetPhrase, onComplete, onCancel }: Props) {
  // If presetPhrase is provided (retrain path from the WakePhrasePicker), use it as the initial value.
  const [wakePhrase, setWakePhrase] = useState(presetPhrase ?? `hey ${companionName}`);
  // WakePhraseRef is kept in sync with the wakePhrase state on every render, so async callbacks registered via useRef (like _onModel below)…
  const wakePhraseRef = useRef(wakePhrase);
  wakePhraseRef.current = wakePhrase;
  const [samples, setSamples] = useState<string[]>([]);  // absolute paths
  // v3.10.59: per-sample RMS values, computed after
  // recording. Used by the per-sample volume hint and
  // the cross-sample consistency check. Index-aligned
  // with `samples`.
  const [sampleRms, setSampleRms] = useState<number[]>([]);
  // Optional user-recorded near-miss clips.
  const [nearMissSamples, setNearMissSamples] = useState<Array<{ path: string; phrase: string }>>([]);
  // Per-slot draft phrases for empty near-miss rows.
  const [nearMissDrafts, setNearMissDrafts] = useState<string[]>(['', '', '']);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  // Explicit logging of desktop activity on the mobile side.
  const [lastEventAt, setLastEventAt] = useState<number>(0);
  const [trainingStartedAt, setTrainingStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const [eventLog, setEventLog] = useState<Array<{ ts: number; msg: string }>>([]);
  // The wake phrase currently active on the device for this companion, if any.
  const [currentTrainedPhrase, setCurrentTrainedPhrase] = useState<string | null>(null);
  const [trainedModelPath, setTrainedModelPath] = useState<string | null>(null);
  // Snapshot of the trained phrase at the moment the trainer mounted, used by the cleanup useEffect to re-init the OWW listener with the right…
  const [currentTrainedPhraseOnMount, setCurrentTrainedPhraseOnMount] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  // On mount, fetch the currently-active trained model for this companion (if any).
  useEffect(() => {
    let cancelled = false;
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (cancelled || !models) return;
        const entry = models[companionId];
        if (entry?.phrase) {
          setCurrentTrainedPhrase(entry.phrase);
          setTrainedModelPath(entry.path || null);
          // Snapshot the trained phrase on mount so the cleanup useEffect knows what wake word to re-init the OWW listener with.
          setCurrentTrainedPhraseOnMount((prev) =>
            prev === null ? entry.phrase : prev
          );
        } else {
          setCurrentTrainedPhrase(null);
          setTrainedModelPath(null);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [companionId]);

  // After a successful training, refresh the trained-phrase state so the badge updates to show what was just installed.
  useEffect(() => {
    if (stage !== 'complete') return;
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (!models) return;
        const entry = models[companionId];
        if (entry?.phrase) {
          setCurrentTrainedPhrase(entry.phrase);
          setTrainedModelPath(entry.path || null);
        }
      })
      .catch(() => {});
  }, [stage, companionId]);

  // Cleanup on unmount: stop any in-flight recorder and stop listening
  // for progress events from the sync server.
  useEffect(() => {
    // On mount, ask the desktop if there's a recent wake training result for this companion.
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

    // Stop the bundled pre-trained wake listener while the trainer is mounted.
    WakeWordModule?.stopOwwListening?.().catch(() => {});

    return () => {
      try { getSimpleAudioRecorder().stop(); } catch (_) {}
      try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
      // Re-init the OWW wake listener with the right wake phrase before starting it.
      const phraseToReactivate = currentTrainedPhrase || currentTrainedPhraseOnMount;
      if (phraseToReactivate) {
        // Bumped default wake threshold from 0.5 to 0.55 to suppress bucket-A false wakes (TV/radio blips whose melspec peaks above threshold…
        WakeWordModule?.initOww?.(phraseToReactivate, 0.55)
          .catch(() => {})
          .then(() => WakeWordModule?.startOwwListening?.())
          .catch(() => {});
      } else {
        // No model for this companion — fall back to the bundled pre-trained wake word so Voice Mode at least listens for SOMETHING.
        WakeWordModule?.initOww?.('hey_jarvis', 0.55)
          .catch(() => {})
          .then(() => WakeWordModule?.startOwwListening?.())
          .catch(() => {});
      }
    };
  }, [companionId, stage]);

  // Attach the wake-training event listeners ONCE on mount and never re-run.
  useEffect(() => {
    const s = syncClient;
    s?.on?.('wake_training_progress', _onProgress);
    s?.on?.('wake_training_result', _onResult);
    s?.on?.('wake_model_data', _onModel);
    // No cleanup — we want the listeners to stay attached for
    // the entire lifetime of the trainer component. If we ever
    // get a stale 'complete' result from a previous run, the
    // stage guard inside _onResult handles it (returns early
    // when stage is already 'complete').
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Training-result watchdog.
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
      console.log(`[Trainer] watchdog poll (stage=${stage} connected=${s?.connected})`);
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

  // ----- recording ----- Hard max duration for a single sample.
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
      const filename = `wake_sample_${Date.now()}.wav`;
      const path = `${RNFS.CachesDirectoryPath}/${filename}`;
      // Start with a short silence timeout so single-word phrases stop
      // quickly once the user is done speaking. The actual stop happens
      // via the 'silence' event below — never immediately after start.
      await recorder.start(path, 1500);

      // WAIT for the silence event before stopping.
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
      // Compute RMS from the WAV file so we can give the user volume-consistency feedback.
      try {
        const b64 = await RNFS.readFile(path, 'base64');
        const pcm = base64ToInt16Array(b64);
        if (pcm.length > 0) {
          let sumSq = 0;
          for (let i = 0; i < pcm.length; i++) {
            const s = pcm[i] / 32768;
            sumSq += s * s;
          }
          const rms = Math.sqrt(sumSq / pcm.length);
          setSampleRms((r) => [...r, rms]);
        } else {
          setSampleRms((r) => [...r, NaN]);
        }
      } catch (_) {
        setSampleRms((r) => [...r, NaN]);
      }
    }
  }, [samples.length, wakePhrase, recordOne]);

  // Near-miss recording.
  const onTapToRecordNearMiss = useCallback(async (phrase: string) => {
    if (nearMissSamples.length >= REQUIRED_NEAR_MISS_SAMPLES) return;
    if (!phrase.trim()) {
      Alert.alert('Pick a phrase', 'Type what you want the near-miss to be.');
      return;
    }
    const path = await recordOne();
    if (path) {
      setNearMissSamples((prev) => [...prev, { path, phrase: phrase.trim() }]);
      // v3.8.4: clear the draft for this slot so it doesn't
      // ghost through if the user later deletes the recording.
      // Index = current length since we just appended.
      setNearMissDrafts((prev) => {
        const next = [...prev];
        const idx = nearMissSamples.length; // length before the append above
        next[idx] = '';
        return next;
      });
    }
  }, [nearMissSamples.length, recordOne]);

  const clearSamples = useCallback(() => {
    setSamples((prev) => {
      // Best-effort delete of the temp files
      for (const p of prev) {
        RNFS.unlink(p).catch(() => {});
      }
      return [];
    });
    setSampleRms([]);
  }, []);

  // ----- progress event handlers (refs so the cleanup useEffect can reach them) ----- v3.2.9: 1-second tick while training is active.
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

  const _onProgress = useRef((msg: any) => {
    console.log(`[Trainer] _onProgress: stage=${msg?.stage} pct=${msg?.percent}`);
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
      const prevStage = (msg as any).__prevStage;
      setStage(newStage);
      setProgress(msg.percent || 0);
      if (msg.message) setStatusMsg(msg.message);
      // Log every progress event with a timestamp so the user can see at a glance whether the desktop is actively working or stuck.
      const now = Date.now();
      setLastEventAt(now);
      setNow(now);
      const logMsg = msg.message
        ? `${Math.round(msg.percent)}% — ${msg.message}`
        : `${Math.round(msg.percent)}% — ${msg.stage}`;
      setEventLog((prev) => {
        const next = [...prev, { ts: now, msg: logMsg }];
        return next.slice(-50);
      });
    }
  }).current;

  const _onResult = useRef(async (msg: any) => {
    // v3.2.9: any wake_training_result from the desktop counts
    // as activity — bump lastEventAt so the "Ns ago" indicator
    // resets and doesn't show a misleadingly large number.
    if (!msg?.noResult) {
      const now = Date.now();
      setLastEventAt(now);
      setNow(now);
      setEventLog((prev) => [
        ...prev,
        {
          ts: now,
          msg: msg?.ok
            ? `Result: ok — model at ${msg.tflitePath?.split('/').pop()}`
            : `Result: error — ${msg?.error || 'unknown'}`,
        },
      ].slice(-50));
    }
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
      // Read wakePhrase from wakePhraseRef, NOT the captured-in-closure wakePhrase variable.
      const savedPath: string = await WakeWordModule.setWakeModelFromBase64(
        companionId,
        msg.base64,
        wakePhraseRef.current,
      );
      setStage('complete');
      setProgress(100);
      setStatusMsg(`Wake word ready. Saved to ${savedPath}`);
      // Clean up the sample WAVs from cache
      clearSamples();
      // Push the new wake phrase to the background-listening service.
      try {
        const [settingsRaw, bgRaw] = await Promise.all([
          AsyncStorage.getItem('cyberclaw-audio-settings'),
          AsyncStorage.getItem('cyberclaw-bg-listening'),
        ]);
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        settings.wakeWord = wakePhrase;
        const writes = [
          AsyncStorage.setItem('cyberclaw-audio-settings', JSON.stringify(settings)),
          AsyncStorage.setItem('cyberclaw-active-wake-companion', companionId),
        ];
        await Promise.all(writes);
        if (bgRaw === 'true' && BackgroundService?.stop && BackgroundService?.start) {
          // BG listening is on.
          try { await BackgroundService.stop(); } catch (_) {}
          try { await BackgroundService.start(wakePhraseRef.current); } catch (_) {}
        }
      } catch (_) {
        // best-effort. The training itself succeeded;
        // the BG service will pick up the new phrase
        // the next time the app restarts / toggles.
      }
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
    // Reset the logging state for a fresh run.
    setEventLog([{ ts: Date.now(), msg: 'Started — sending samples to desktop...' }]);
    setLastEventAt(Date.now());
    setTrainingStartedAt(Date.now());
    setNow(Date.now());

    // Poll for the cached result 10s after we fire the request.
    const earlyPoll = setTimeout(() => {
      if (syncClient?.connected) {
        syncClient.requestLatestWakeTrainingResult(companionId);
      }
    }, 10000);

    try {
      // Ship the audio bytes themselves, not the on-phone file paths.
      const encoded: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        const name = p.split('/').pop() || `sample_${i}.wav`;
        // readFile with 'base64' returns the raw base64 string.
        const data = await RNFS.readFile(p, 'base64');
        encoded.push({ name, data });
        setProgress(5 + Math.round(((i + 1) / samples.length) * 25));
      }
      // Encode the user-recorded near-miss clips the same way and ship them with the training request.
      const nearMissEncoded: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < nearMissSamples.length; i++) {
        const nm = nearMissSamples[i];
        // Use the phrase (sanitized) as the filename prefix so the desktop can see what each near-miss is.
        const safeName = nm.phrase.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 20) || `near_miss_${i}`;
        const name = `${safeName}_${i}.wav`;
        const data = await RNFS.readFile(nm.path, 'base64');
        nearMissEncoded.push({ name, data });
      }
      console.log(`[Trainer] sending requestWakeTraining agentId=${companionId} samples=${encoded.length} nearMisses=${nearMissEncoded.length}`);
      sync.requestWakeTraining(companionId, wakePhrase.trim(), encoded, nearMissEncoded);
    } catch (e: any) {
      clearTimeout(earlyPoll);
      setStage('error');
      setStatusMsg(`Failed to start: ${e?.message || 'unknown'}`);
    }
  }, [samples, nearMissSamples, companionId, wakePhrase, _onProgress, _onResult, _onModel, clearSamples]);

  // ----- render -----
  const isTrainingInProgress = !['idle', 'complete', 'error'].includes(stage);
  const isFinished = stage === 'complete' || stage === 'error';

  return (
    <View style={styles.root}>
      {/* v3.9.8 — keyboard UX fix. The wake-phrase
          TextInput at the top, plus the per-row
          near-miss TextInputs, were getting covered by
          the soft keyboard when tapped. Fix:
          1. KeyboardAvoidingView pushes content above
             the keyboard (behavior="padding" on
             Android is enough; "height" doesn't work
             reliably with ScrollView).
          2. ScrollView gets keyboardShouldPersistTaps
             so tapping the mic/record button while the
             keyboard is up doesn't first dismiss the
             keyboard then re-tap on the next
             interaction.
          3. ScrollView gets keyboardDismissMode
             so swiping down dismisses the keyboard
             (standard iOS pattern; harmless on
             Android).
          Without these, Tobe had to manually scroll to
          reach the "Tap to record one sample" button
          after tapping the wake-phrase field. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
      >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={styles.title}>Train wake word for {companionName}</Text>

        {/* v3.2.8: trained-model status badge. Shown above the
            subtitle so the user immediately sees whether a model
            is currently active, and which phrase it's listening
            for. If there's no model, the badge says so explicitly
            so the user doesn't wonder if "0 / 6 samples" means
            "no model yet" or "no samples yet". */}
        {currentTrainedPhrase ? (
          <View style={styles.trainedBadge}>
            <Text style={styles.trainedBadgeIcon}>✓</Text>
            <View style={styles.trainedBadgeTextWrap}>
              <Text style={styles.trainedBadgeText}>
                Listening for "{currentTrainedPhrase}"
              </Text>
              {trainedModelPath ? (
                <Text style={styles.trainedBadgeMeta} numberOfLines={1}>
                  Training will overwrite this model.
                </Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.untrainedBadge}>
            <Text style={styles.untrainedBadgeText}>
              No trained model yet — record 6 samples and hit Train.
            </Text>
          </View>
        )}

        <Text style={styles.subtitle}>
          Say the phrase {REQUIRED_SAMPLES} times. The desktop uses these as a seed
          to generate thousands of variants, then trains a tiny neural network that
          recognizes the phrase on this device.
        </Text>

        {/* v3.10.53: volume diversity hint. The trainer's openWakeWord
            pipeline now uses a symmetric ±18dB Gain augmentation range
            (desktop v3.2.13+), so trained models can be volume-invariant
            — but they need positives at varied volumes to learn from.
            Suggesting "whisper / normal / shout" prompts the user to
            produce human-curated diversity rather than relying solely
            on the augmentation to cover the volume space. Especially
            helps with: whispering late at night, calling to the phone
            from across the room, shouting over background noise. */}
        {!isTrainingInProgress && !isFinished && samples.length < REQUIRED_SAMPLES && (
          <Text style={styles.hint}>
            Tip: vary your volume across the {REQUIRED_SAMPLES} samples — try a
            whisper, a normal voice, and a shout. The trained model will then
            recognize you whether you whisper or call from across the room.
          </Text>
        )}

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

            {/* v3.2.9: explicit logging indicators. Three lines:
                - Total elapsed time since training started (mm:ss)
                - Seconds since the last desktop progress event
                  (green if recent, yellow if aging, red if >60s)
                - Scrolling event log of the last few progress events
                  so the user can see exactly what happened even if
                  the status text has scrolled away. */}
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
                activate next time you open this companion.
              </Text>
            ) : null}
          </View>
        )}

        {/* Recording UI */}
        {!isTrainingInProgress && !isFinished && (
          <View style={styles.recordCard}>
            <Text style={styles.label}>Samples recorded: {samples.length} / {REQUIRED_SAMPLES}</Text>
            {/* v3.10.59: per-sample volume hint. Show each
                recorded sample's RMS next to the counter so the
                user can see if their volume is consistent
                across recordings. NaN = RMS read failed.
                Volume categories match the OpenWakeWord
                trainer's recommended ranges: quiet
                (<0.02), good (0.02-0.20), loud (>0.20). */}
            {sampleRms.length > 0 && (
              <View style={styles.sampleRmsRow}>
                {sampleRms.map((r, i) => {
                  let color = '#888';
                  let label = `#${i + 1}`;
                  if (!isNaN(r)) {
                    if (r < 0.02) { color = '#e67e22'; label = `#${i + 1} (quiet)`; }
                    else if (r > 0.20) { color = '#e67e22'; label = `#${i + 1} (loud)`; }
                    else { color = '#27ae60'; label = `#${i + 1} (${r.toFixed(3)})`; }
                  } else {
                    color = '#999';
                    label = `#${i + 1} (?)`;
                  }
                  return (
                    <Text key={i} style={[styles.sampleRmsChip, { color, borderColor: color }]}>{label}</Text>
                  );
                })}
              </View>
            )}
            {/* v3.10.59: cross-sample consistency check. Show
                the coefficient of variation (std/mean) of the
                per-sample RMS values once at least 4 samples
                are recorded. CV < 0.3 = consistent (good for
                matching production conditions); 0.3-0.7 =
                moderate variation (fine — desktop pipeline
                handles it); > 0.7 = highly variable (training
                conditions likely differ from production). */}
            {sampleRms.filter(r => !isNaN(r)).length >= 4 && (
              <Text style={styles.consistencyHint}>
                {(() => {
                  const valid = sampleRms.filter(r => !isNaN(r));
                  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
                  if (mean <= 0) return '';
                  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
                  const std = Math.sqrt(variance);
                  const cv = std / mean;
                  if (cv < 0.3) return `✓ Volume consistency: good (CV ${cv.toFixed(2)})`;
                  if (cv < 0.7) return `⚠️ Volume varies a bit (CV ${cv.toFixed(2)}) — that's fine, just don't whisper some and shout others`;
                  return `⚠️ Volume is highly variable (CV ${cv.toFixed(2)}) — try to match how you'll say it in real use`;
                })()}
              </Text>
            )}
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

        {/* v3.8.2: Near-miss recording. Optional — these are
            similar-but-wrong phrases ("hey car" for "hey
            clawsuu") that the model should reject. The
            desktop's Piper-TTS adversarial negatives catch
            general acoustic variation; user-recorded
            near-misses in your own voice + environment catch
            the specific false positives you get at home.
            Optional. The Trainer generates 3 suggestions from
            your wake phrase using simple phonetic swaps. */}
        {!isTrainingInProgress && !isFinished && (
          <View style={styles.recordCard}>
            <Text style={styles.label}>
              Near-misses (optional but recommended): {nearMissSamples.length} / {REQUIRED_NEAR_MISS_SAMPLES}
            </Text>
            <Text style={styles.nearMissHint}>
              Say phrases that sound similar but aren't your wake word. The desktop's TTS-generated
              negatives catch general variation, but YOUR near-misses in YOUR voice catch what
              actually trips the model up at home.
            </Text>

            {Array.from({ length: REQUIRED_NEAR_MISS_SAMPLES }).map((_, i) => {
              const existing = nearMissSamples[i];
              // Show suggestions only on the first empty
              // slot to avoid cluttering the UI.
              const suggestions = i === 0 ? suggestNearMisses(wakePhrase, 3) : [];
              // Empty-slot value precedence: 1.
              const slotValue = existing?.phrase
                ?? (nearMissDrafts[i] !== undefined
                      ? nearMissDrafts[i]
                      : (i === 0 && nearMissSamples.length === 0 ? (suggestions[0] ?? '') : ''));
              return (
                <View key={i} style={styles.nearMissRow}>
                  <TextInput
                    style={[styles.input, styles.nearMissInput]}
                    value={slotValue}
                    onChangeText={(text) => {
                      // Capture typed text into the per-slot draft array.
                      if (existing) {
                        setNearMissSamples((prev) => prev.map((nm, idx) => idx === i ? { ...nm, phrase: text } : nm));
                      } else {
                        setNearMissDrafts((prev) => {
                          const next = [...prev];
                          next[i] = text;
                          return next;
                        });
                      }
                    }}
                    placeholder={suggestions[0] || `e.g. hey car`}
                    placeholderTextColor="#666"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!existing}
                    maxLength={40}
                  />
                  {existing ? (
                    <View style={styles.nearMissRecorded}>
                      <Text style={styles.nearMissRecordedText}>✓</Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.nearMissRecordBtn}
                      onPress={() => {
                        // Phrase resolution precedence 1.
                        const typed = nearMissDrafts[i];
                        const phrase = (typed && typed.trim())
                          || existing?.phrase
                          || suggestions[0]
                          || '';
                        onTapToRecordNearMiss(phrase);
                      }}
                      disabled={isRecording}
                    >
                      <Text style={styles.nearMissRecordIcon}>🎤</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

            {(() => {
              const suggestions = suggestNearMisses(wakePhrase, 3);
              if (suggestions.length === 0) return null;
              return (
                <View style={styles.suggestionsRow}>
                  <Text style={styles.suggestionsLabel}>Suggestions:</Text>
                  {suggestions.map((s, i) => (
                    <TouchableOpacity
                      key={i}
                      style={styles.suggestionChip}
                      onPress={() => {
                        Alert.alert(s, 'Tap the 🎤 on an empty slot to record this phrase.');
                      }}
                    >
                      <Text style={styles.suggestionChipText}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })()}
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
      </KeyboardAvoidingView>

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
  // Trained-model status badge.
  trainedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.4)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  trainedBadgeIcon: {
    color: '#22c55e',
    fontSize: 18,
    fontWeight: '700',
    marginRight: 10,
  },
  trainedBadgeTextWrap: { flex: 1 },
  trainedBadgeText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  trainedBadgeMeta: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  untrainedBadge: {
    backgroundColor: 'rgba(156, 163, 175, 0.10)',
    borderColor: 'rgba(156, 163, 175, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  untrainedBadgeText: { color: '#9ca3af', fontSize: 13 },
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
  // v3.10.59: per-sample RMS chip row. Shows the volume
  // category for each recorded sample as a small bordered
  // chip so the user can see consistency at a glance.
  sampleRmsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 8,
  },
  sampleRmsChip: {
    fontSize: 11,
    marginHorizontal: 3,
    marginVertical: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  // Cross-sample consistency hint shown once 4+ samples have been recorded.
  consistencyHint: {
    fontSize: 11,
    color: '#bbb',
    marginTop: 8,
    textAlign: 'center',
    fontStyle: 'italic',
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
  // Explicit logging card.
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

  // Near-miss recording UI.
  nearMissHint: {
    color: '#9aa0b4',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  nearMissRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 4,
  },
  nearMissInput: {
    flex: 1,
    marginTop: 0,
    marginBottom: 0,
  },
  nearMissRecordBtn: {
    backgroundColor: '#1f1f1f',
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nearMissRecordIcon: { fontSize: 18 },
  nearMissRecorded: {
    backgroundColor: '#10b981',
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nearMissRecordedText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  suggestionsLabel: {
    color: '#7a809a',
    fontSize: 11,
    marginRight: 4,
  },
  suggestionChip: {
    backgroundColor: '#1f1f1f',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a3e',
  },
  suggestionChipText: {
    color: '#cfd2e0',
    fontSize: 12,
  },
});