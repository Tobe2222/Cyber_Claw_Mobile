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
// v3.8.2: optional near-miss recording. Recommended 3
// (the script does an 80/20 train/test split so 2-3
// near-misses is enough to test that the model rejects
// them in validation). Optional — the user can skip
// and training proceeds with only TTS adversarial
// negatives.
const REQUIRED_NEAR_MISS_SAMPLES = 3;

// v3.8.2: generate suggested near-miss phrases from the
// wake phrase. These are similar-but-wrong phrases the
// model should reject. The heuristics:
//
//   - Swap trailing consonants for similar-sounding ones
//     (m/n, s/t, k/g) so "hey clawsuu" -> "hey clawsu"
//   - Drop the trailing vowel so "hey clawsuu" -> "hey claws"
//   - Add a different first word ("hi clawsuu", "ok clawsuu")
//   - Sub a different trailing word ("hey clawsaw",
//     "hey claws you")
//
// These are SUGGESTIONS only — the user can type anything.
// The point is to give them a starting point so they
// don't have to think of similar-sounding phrases from
// scratch. The actual training reads the audio bytes,
// not the text, so the suggestions are just labels.
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
  // v3.3.0: optional preset phrase. When set, the
  // trainer's TextInput initializes with this string
  // instead of the default `hey ${companionName}`.
  // Used by the per-row "Retrain" button in the new
  // WakePhrasePicker to pre-fill the trainer with the
  // existing phrase so the user can re-record samples
  // without accidentally training a different word.
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
  // v3.3.0: if presetPhrase is provided (retrain path
  // from the WakePhrasePicker), use it as the initial
  // value. Otherwise default to `hey ${companionName}`
  // — the existing behavior for first-time training.
  const [wakePhrase, setWakePhrase] = useState(presetPhrase ?? `hey ${companionName}`);
  const [samples, setSamples] = useState<string[]>([]);  // absolute paths
  // v3.8.2: optional user-recorded near-miss clips. Each
  // entry is { path, phrase } where `phrase` is what the user
  // said (just for their reference — the model gets the
  // audio bytes, not the text). Sent to the desktop with the
  // training request; the desktop copies them into the
  // negative_train / negative_test dirs so the training
  // script picks them up alongside the Piper-TTS adversarial
  // negatives. Optional — if empty, training proceeds with
  // only TTS negatives (v3.8.1 behavior).
  const [nearMissSamples, setNearMissSamples] = useState<Array<{ path: string; phrase: string }>>([]);
  // v3.8.4: per-slot draft phrases for empty near-miss
  // rows. Previously the empty-slot TextInput had no
  // onChangeText handler, so the user could tap to focus
  // the input but typing went nowhere (Tobe: 'It did not
  // allow me to input near misses'). With this state,
  // typing into an empty slot is captured into drafts[i]
  // and is then used by the mic button instead of the
  // fallback suggestion. Drafts are cleared once the
  // slot is filled.
  const [nearMissDrafts, setNearMissDrafts] = useState<string[]>(['', '', '']);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  // v3.2.9: explicit logging of desktop activity on the mobile
  // side. The bar and status text are useful but they don't show
  // you WHEN something last happened — the bar at 30% and the
  // bar at 95% look identical if they aren't moving. We track
  // the timestamp of every PROGRESS:: event from the desktop
  // and surface "last event: Ns ago" + a rolling event log so
  // the user can see at a glance whether training is actually
  // progressing or stuck.
  const [lastEventAt, setLastEventAt] = useState<number>(0);
  const [trainingStartedAt, setTrainingStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const [eventLog, setEventLog] = useState<Array<{ ts: number; msg: string }>>([]);
  // v3.2.8: the wake phrase currently active on the device for
  // this companion, if any. null means no trained model is
  // installed. Surfaced as a status badge at the top of the
  // trainer so the user knows what they're about to overwrite
  // (or that they have to train to get a model).
  const [currentTrainedPhrase, setCurrentTrainedPhrase] = useState<string | null>(null);
  const [trainedModelPath, setTrainedModelPath] = useState<string | null>(null);
  // v3.2.14: snapshot of the trained phrase at the moment the
  // trainer mounted, used by the cleanup useEffect to re-init
  // the OWW listener with the right wake word when the trainer
  // closes. Without this, the cleanup falls back to whatever
  // was loaded on HomeScreen mount (usually 'hey_jarvis'),
  // even if the trainer completed a fresh training and
  // hot-swapped in a new model for the current companion.
  const [currentTrainedPhraseOnMount, setCurrentTrainedPhraseOnMount] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  // v3.2.8: on mount, fetch the currently-active trained model for
  // this companion (if any). The native side persists each trained
  // model in filesDir/wake_models/ and exposes getSavedWakeModels()
  // returning { agentId: { phrase, path, savedAt } }. We use this
  // to surface a "currently listening for: <phrase>" status badge
  // at the top of the trainer, so the user knows whether they're
  // about to train a new model or overwrite an existing one.
  useEffect(() => {
    let cancelled = false;
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (cancelled || !models) return;
        const entry = models[companionId];
        if (entry?.phrase) {
          setCurrentTrainedPhrase(entry.phrase);
          setTrainedModelPath(entry.path || null);
          // v3.2.14: snapshot the trained phrase on mount so the
          // cleanup useEffect knows what wake word to re-init
          // the OWW listener with. Only set this once, the
          // first time we resolve the saved models for this
          // companion — later training completions update
          // currentTrainedPhrase but NOT this snapshot.
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

  // v3.2.8: after a successful training, refresh the trained-phrase
  // state so the badge updates to show what was just installed.
  // stage 'complete' is set in _onModel after the native side has
  // accepted the .tflite. We re-fetch from the native side because
  // that's the single source of truth for what's actually active.
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

    // v3.2.11: stop the bundled pre-trained wake listener while
    // the trainer is mounted. The trainer is doing wake-word work
    // (either recording samples, training, or running a fresh
    // model preview) and the bundled "hey jarvis" listener from
    // HomeScreen is still active underneath — it grabs the mic,
    // it can fire the wake notification and interrupt the trainer,
    // and (less obviously) it competes with the trainer's sample
    // recorder for the audio device. Restart it on unmount.
    WakeWordModule?.stopOwwListening?.().catch(() => {});

    return () => {
      try { getSimpleAudioRecorder().stop(); } catch (_) {}
      try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
      // v3.2.14: re-init the OWW wake listener with the right
      // wake phrase before starting it. Without this, the
      // listener falls back to whatever was loaded on
      // HomeScreen mount — usually 'hey_jarvis' from the
      // bundled pre-trained model. After the user trains a
      // new wake word, the trainer's setWakeModelFromBase64
      // hot-swaps the model in the detector, but if we just
      // call startOwwListening here, the listener uses the
      // original 'hey_jarvis' init and ignores the hot-swap.
      // The fix: re-init with the wake phrase that was active
      // when the trainer mounted (which already accounts for
      // any saved custom model for this companion). If the
      // trainer completed a fresh training, currentTrainedPhrase
      // is the new phrase; otherwise we re-init with whatever
      // was loaded previously.
      const phraseToReactivate = currentTrainedPhrase || currentTrainedPhraseOnMount;
      if (phraseToReactivate) {
        WakeWordModule?.initOww?.(phraseToReactivate, 0.5)
          .catch(() => {})
          .then(() => WakeWordModule?.startOwwListening?.())
          .catch(() => {});
      } else {
        // No model for this companion — fall back to the bundled
        // pre-trained wake word so Voice Mode at least listens
        // for SOMETHING.
        WakeWordModule?.initOww?.('hey_jarvis', 0.5)
          .catch(() => {})
          .then(() => WakeWordModule?.startOwwListening?.())
          .catch(() => {});
      }
    };
  }, [companionId, stage]);

  // v3.2.12: attach the wake-training event listeners ONCE on
  // mount and never re-run. Previously these were attached in
  // startTraining() and removed by the [stage] useEffect cleanup
  // when stage transitioned from 'idle' to 'uploading' — so the
  // listener was attached for ~10ms (between sync.on() and the
  // next React render) and then removed. Every wake_training_progress
  // event broadcast by the desktop went to a removed listener.
  // The fix: attach the listeners in a useEffect with empty deps,
  // and never remove them (the trainer screen is single-mount).
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
      const filename = `wake_sample_${Date.now()}.wav`;
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

  // v3.8.2: near-miss recording. Same audio-capture path as
  // positive samples (recordOne), but stores into a
  // separate array. The phrase argument is the user's
  // label for what they said — captured into AsyncStorage
  // so the trainer can show "Hey Car (recorded)" in the
  // near-miss list. Not used by the model itself.
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
  }, []);

  // ----- progress event handlers (refs so the cleanup useEffect can reach them) -----
  // v3.2.9: 1-second tick while training is active. We use this
  // to update the "Ns since last event" indicator without
  // running a setInterval per render. The interval is started
  // when training begins (stage leaves 'idle') and stopped when
  // it reaches a terminal state.
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
      // v3.2.9: log every progress event with a timestamp so the
      // user can see at a glance whether the desktop is actively
      // working or stuck. Also push an entry to a rolling event
      // log (capped at 50 entries) so they can scroll back and
      // see what happened, even after the status text scrolls off.
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
    // v3.2.9: reset the logging state for a fresh run. Clear
    // the event log and seed lastEventAt / trainingStartedAt
    // so the "Ns since last event" indicator starts from
    // zero rather than showing a stale value from a
    // previous run.
    setEventLog([{ ts: Date.now(), msg: 'Started — sending samples to desktop...' }]);
    setLastEventAt(Date.now());
    setTrainingStartedAt(Date.now());
    setNow(Date.now());

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
      // reported "sample not found". Read each .wav as base64 and
      // let the desktop decode and write it to its training dir.
      const encoded: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        const name = p.split('/').pop() || `sample_${i}.wav`;
        // readFile with 'base64' returns the raw base64 string.
        const data = await RNFS.readFile(p, 'base64');
        encoded.push({ name, data });
        setProgress(5 + Math.round(((i + 1) / samples.length) * 25));
      }
      // v3.8.2: encode the user-recorded near-miss clips
      // the same way and ship them with the training
      // request. Optional — empty array means the desktop
      // falls back to Piper-TTS-only adversarial
      // negatives (v3.8.1 behavior).
      const nearMissEncoded: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < nearMissSamples.length; i++) {
        const nm = nearMissSamples[i];
        // Use the phrase (sanitized) as the filename prefix
        // so the desktop can see what each near-miss is.
        // Falls back to a numeric name if the phrase has
        // weird characters.
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
      <ScrollView contentContainerStyle={styles.scroll}>
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
              // v3.8.4: empty-slot value precedence:
              //   1. The user's typed draft for this slot (if any)
              //   2. The auto-suggestion for slot 0 (only on first
              //      mount, so it doesn't overwrite what the user
              //      typed)
              //   3. Empty string — placeholder takes over
              // The auto-suggestion only auto-fills the FIRST slot
              // the first time the screen renders. After that the
              // user's draft wins. Without this priority order, the
              // suggestion would overwrite the user's typed text on
              // every render and typing would silently fail.
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
                      // v3.8.4: capture typed text into the
                      // per-slot draft array. Once the slot
                      // gets a recorded entry, the draft is
                      // superseded by `existing.phrase`.
                      // Editable stays true for empty slots
                      // even though `existing` is undefined.
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
                        // v3.8.4: phrase resolution precedence
                        //   1. Whatever the user typed in this slot
                        //   2. The slot's existing recorded phrase
                        //   3. The first suggestion for slot 0
                        //   4. Empty (the recording handler will
                        //      alert if empty)
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
  // v3.2.8: trained-model status badge. Green-tinted when there's
  // an active model (so the user knows the wake word is currently
  // working); gray-tinted with a hint when there isn't (so the
  // user knows they need to train before the wake word works).
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
  // v3.2.9: explicit logging card. Shows elapsed time + time
  // since the last desktop event (color-coded green / yellow /
  // red) + a scrolling event log so the user can tell at a
  // glance whether the desktop is actively working or has
  // gone silent.
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

  // v3.8.2: near-miss recording UI. Three rows, each with
  // a text input (for the phrase label) + a record button.
  // When recorded, the row shows a green check and disables
  // the input.
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