/**
 * SampleTrainer — v3.1.77 single-sample wake word trainer.
 *
 * Replaces the v3.1.67 trainer's "record 3 samples" mechanic
 * with one-shot style-tagged recording. The parent
 * (TrainingDetailScreen) chooses the companion, phrase, and
 * style, then mounts this component to capture one sample.
 *
 * On success: saves the sample to the per-companion training
 * entry and calls `onComplete(true)`. The parent then re-renders
 * with the updated sample list (the next style to fill, or
 * close the screen if everything's done).
 *
 * Flow (the parent pre-validates everything; this component
 * doesn't need to):
 *  - props.phrase is non-empty
 *  - props.style is one of WAKE_SAMPLE_STYLES
 *  - there's room for one more sample of this style (parent
 *    caps at WAKE_STYLE_MAX)
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from 'react-native';
import RNFS from 'react-native-fs';
import { NativeModules } from 'react-native';
import { extractAudioFeatures, compareAudioFeatures, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array, validateAudio } from '../services/AudioUtils';
import { getSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import {
  WakeSampleStyle,
  addWakeSample,
  saveWakeTraining,
} from '../services/WakeTrainingModel';

const { WakeWordModule } = NativeModules;

const SILENCE_TIMEOUT_MS = 1500;
const MAX_DURATION_MS = 3000;

interface Props {
  companionId: string;
  companionName: string;
  phrase: string;
  style: WakeSampleStyle;
  onComplete: (success: boolean, quality?: number) => void;
  onCancel: () => void;
}

export default function SampleTrainer({ companionId, companionName, phrase, style, onComplete, onCancel }: Props) {
  const [phase, setPhase] = useState<'ready' | 'recording' | 'saving' | 'done' | 'error'>('ready');
  const [message, setMessage] = useState('Tap to start recording');
  const [quality, setQuality] = useState<number | null>(null);
  const [pulse] = useState(new Animated.Value(1));

  // Stop the live wake listener while we're recording so
  // saying the wake phrase doesn't fire wake mode mid-recording.
  useEffect(() => {
    try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
    return () => {
      try { WakeWordModule?.startSampleListening?.(); } catch (_) {}
    };
  }, []);

  const startPulse = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    ).start();
  };

  const stopPulse = () => {
    pulse.stopAnimation();
    pulse.setValue(1);
  };

  const recordAndSave = useCallback(async () => {
    setPhase('recording');
    setMessage('🎤 Recording… speak clearly');
    setQuality(null);
    startPulse();

    try {
      const recorder = getSimpleAudioRecorder();
      const path = `${RNFS.CachesDirectoryPath}/wake_sample_${Date.now()}.m4a`;
      await recorder.start(path, SILENCE_TIMEOUT_MS);

      let stopped = false;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;
      let unsubSilence: (() => void) | null = null;
      const stopRecording = async () => {
        if (stopped) return;
        stopped = true;
        if (maxTimer) clearTimeout(maxTimer);
        if (unsubSilence) try { unsubSilence(); } catch (_) {}
        try {
          stopPulse();
          const finalPath = await recorder.stop();
          const base64 = await RNFS.readFile(finalPath, 'base64');
          const pcm16 = base64ToInt16Array(base64);
          const validation = validateAudio(pcm16);
          if (!validation.valid) {
            setPhase('error');
            setMessage(`❌ ${validation.reason || 'Invalid audio'}`);
            return;
          }
          const features = extractAudioFeatures(pcm16);
          setMessage(`✅ Got ${(features.duration / 16000).toFixed(1)}s — saving…`);
          setPhase('saving');
          const saved = await addWakeSample(companionId, phrase, {
            style,
            features,
            duration: features.duration / 16000,
            quality: 0.8,
            date: new Date().toISOString(),
          });
          // Compute quality vs existing samples of the same style for this phrase.
          const phraseEntry = saved.phrases.find(p => p.phrase.toLowerCase() === phrase.toLowerCase());
          const sameStyle = (phraseEntry?.samples ?? []).filter(s => s.style === style);
          let computedQuality = 0.8;
          if (sameStyle.length > 1) {
            const others = sameStyle.slice(0, -1);
            const sims = others.map(s => compareAudioFeatures(features, s.features));
            computedQuality = sims.reduce((a, b) => a + b, 0) / sims.length;
          }
          // Update quality on the just-saved sample by re-saving.
          if (phraseEntry) {
            const just = phraseEntry.samples[phraseEntry.samples.length - 1];
            if (just) just.quality = computedQuality;
            await saveWakeTraining(companionId, saved);
          }
          setQuality(computedQuality);
          setPhase('done');
          setMessage(`✅ Saved! Quality: ${(computedQuality * 100).toFixed(0)}%`);
          setTimeout(() => onComplete(true, computedQuality), 1000);
        } catch (e: any) {
          setPhase('error');
          setMessage(`❌ Recording error: ${e?.message ?? e}`);
        }
      };

      unsubSilence = recorder.once('silence', () => { stopRecording(); });
      maxTimer = setTimeout(() => { stopRecording(); }, MAX_DURATION_MS);
    } catch (e: any) {
      setPhase('error');
      setMessage(`❌ Failed to start: ${e?.message ?? e}`);
    }
  }, [companionId, phrase, style, onComplete, pulse]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🎤 {style.toUpperCase()} sample</Text>
      <Text style={styles.subtitle}>
        {companionName} · "{phrase}"
      </Text>

      <Animated.View style={[styles.pulseCircle, { transform: [{ scale: pulse }] }]}>
        <Text style={styles.pulseIcon}>
          {phase === 'recording' ? '🔴' : phase === 'saving' ? '💾' : phase === 'done' ? '✅' : phase === 'error' ? '⚠️' : '🎙️'}
        </Text>
      </Animated.View>

      <Text style={styles.message}>{message}</Text>
      {quality !== null && (
        <Text style={styles.quality}>Quality: {(quality * 100).toFixed(0)}%</Text>
      )}

      <View style={styles.buttonRow}>
        {phase === 'ready' || phase === 'error' ? (
          <>
            <TouchableOpacity style={styles.recordBtn} onPress={recordAndSave}>
              <Text style={styles.recordBtnText}>
                {phase === 'error' ? 'Try Again' : 'Start Recording'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : phase === 'done' ? (
          <TouchableOpacity style={styles.recordBtn} onPress={() => onComplete(true, quality ?? undefined)}>
            <Text style={styles.recordBtnText}>Done</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
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
    padding: 24,
    paddingTop: 60,
    alignItems: 'center',
  },
  title: {
    color: '#f7931a',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  subtitle: {
    color: '#888',
    fontSize: 14,
    marginBottom: 32,
  },
  pulseCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#1a1a2e',
    borderWidth: 3,
    borderColor: '#f7931a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  pulseIcon: {
    fontSize: 64,
  },
  message: {
    color: '#e0e0e0',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
    minHeight: 24,
  },
  quality: {
    color: '#10b981',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    marginTop: 32,
    gap: 12,
  },
  recordBtn: {
    backgroundColor: '#f7931a',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  recordBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  cancelBtn: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#555',
  },
  cancelBtnText: {
    color: '#aaa',
    fontSize: 16,
  },
});