/**
 * TrainingDetailScreen — v3.1.77 wake training detail view.
 *
 * Replaces the v3.1.13 flat sample list with a per-style
 * breakdown. For a given (companionId, phrase) pair, shows:
 *   - 5 style rows (Normal / Loud / Whisper / Short / Elongated)
 *     each with X/Y samples (Y = WAKE_STYLE_MAX = 3)
 *   - "Add sample" button per style (disabled when X == Y)
 *   - Per-sample list within each style (quality + delete)
 *
 * The parent (WakePhraseMenu → TrainingDetailScreen) owns
 * which (companionId, phrase) is selected. When the user taps
 * "Add sample" on a style row, we mount the SampleTrainer
 * with the chosen style as a sub-view. After recording, we
 * refresh from storage.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  BackHandler,
} from 'react-native';
import {
  WakeSample,
  WakeSampleStyle,
  WakeTrainingEntry,
  loadWakeTraining,
  saveWakeTraining,
  WAKE_SAMPLE_STYLES,
  WAKE_SAMPLE_STYLE_LABELS,
  WAKE_STYLE_MIN,
  WAKE_STYLE_MAX,
  countByStyle,
} from '../services/WakeTrainingModel';
import SampleTrainer from './SampleTrainer';

interface Props {
  companionId: string;
  companionName: string;
  phrase: string;
  onBack: () => void;
}

export default function TrainingDetailScreen({ companionId, companionName, phrase, onBack }: Props) {
  const [entry, setEntry] = useState<WakeTrainingEntry | null>(null);
  const [trainingStyle, setTrainingStyle] = useState<WakeSampleStyle | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const e = await loadWakeTraining(companionId);
      if (!cancelled) setEntry(e);
    })();
    return () => { cancelled = true; };
  }, [companionId, reloadKey]);

  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (trainingStyle) {
        setTrainingStyle(null);
        setReloadKey(k => k + 1);
        return true;
      }
      onBack();
      return true;
    });
    return () => handler.remove();
  }, [trainingStyle, onBack]);

  const phraseEntry = entry?.phrases.find(p => p.phrase.toLowerCase() === phrase.toLowerCase());
  const samples = phraseEntry?.samples ?? [];
  const counts = countByStyle(samples);
  const totalSamples = samples.length;

  const handleDeleteSample = async (idx: number) => {
    if (!entry) return;
    Alert.alert('Delete sample?', 'Remove this training sample.', [
      { text: 'Cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const updated = JSON.parse(JSON.stringify(entry)) as WakeTrainingEntry;
          const p = updated.phrases.find(pp => pp.phrase.toLowerCase() === phrase.toLowerCase());
          if (p) p.samples.splice(idx, 1);
          await saveWakeTraining(companionId, updated);
          setEntry(updated);
        },
      },
    ]);
  };

  const refresh = useCallback(() => {
    setTrainingStyle(null);
    setReloadKey(k => k + 1);
  }, []);

  if (trainingStyle) {
    return (
      <SampleTrainer
        companionId={companionId}
        companionName={companionName}
        phrase={phrase}
        style={trainingStyle}
        onComplete={(success) => {
          if (success) refresh();
          else setTrainingStyle(null);
        }}
        onCancel={() => setTrainingStyle(null)}
      />
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>📊 "{phrase}"</Text>
          <Text style={styles.subtitle}>{companionName}</Text>
        </View>

        <View style={styles.statsBox}>
          <Text style={styles.statsLabel}>Total samples</Text>
          <Text style={styles.statsValue}>{totalSamples}</Text>
        </View>

        {WAKE_SAMPLE_STYLES.map(style => {
          const ofStyle = samples.filter(s => s.style === style);
          const count = counts[style];
          const minOk = count >= WAKE_STYLE_MIN;
          const atMax = count >= WAKE_STYLE_MAX;
          return (
            <View key={style} style={styles.styleBox}>
              <View style={styles.styleHeader}>
                <Text style={styles.styleLabel}>
                  {WAKE_SAMPLE_STYLE_LABELS[style]}
                </Text>
                <Text style={[styles.styleCount, !minOk && styles.styleCountMissing]}>
                  {count}/{WAKE_STYLE_MAX}
                  {!minOk && '  • 1+ required'}
                </Text>
              </View>
              {ofStyle.length === 0 ? (
                <Text style={styles.styleEmpty}>No samples yet</Text>
              ) : (
                ofStyle.map((s, idx) => (
                  <SampleRow
                    key={`${s.date}-${idx}`}
                    sample={s}
                    index={samples.indexOf(s) + 1}
                    onDelete={() => handleDeleteSample(samples.indexOf(s))}
                  />
                ))
              )}
              <TouchableOpacity
                style={[styles.addStyleBtn, atMax && styles.addStyleBtnDisabled]}
                onPress={() => setTrainingStyle(style)}
                disabled={atMax}
              >
                <Text style={styles.addStyleBtnText}>
                  {atMax ? `${WAKE_SAMPLE_STYLE_LABELS[style]} • full` : `+ Add ${WAKE_SAMPLE_STYLE_LABELS[style].toLowerCase()} sample`}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function SampleRow({ sample, index, onDelete }: { sample: WakeSample; index: number; onDelete: () => void }) {
  return (
    <View style={styles.sampleRow}>
      <View style={styles.sampleInfo}>
        <Text style={styles.sampleLabel}>Sample {index}</Text>
        <Text style={styles.sampleMeta}>
          Quality {(sample.quality * 100).toFixed(0)}% · {sample.duration.toFixed(1)}s · {new Date(sample.date).toLocaleDateString()}
        </Text>
      </View>
      <View
        style={[
          styles.qualityDot,
          {
            backgroundColor:
              sample.quality > 0.7 ? '#10b981' : sample.quality > 0.5 ? '#f59e0b' : '#ef4444',
          },
        ]}
      />
      <TouchableOpacity style={styles.deleteBtn} onPress={onDelete}>
        <Text style={styles.deleteBtnText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a1a' },
  content: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 80 },
  header: { marginBottom: 24 },
  backBtn: { paddingVertical: 8, paddingHorizontal: 4, marginBottom: 12 },
  backBtnText: { color: '#f7931a', fontSize: 16, fontWeight: '600' },
  title: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  subtitle: { color: '#888', fontSize: 13, marginTop: 2 },
  statsBox: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#f7931a',
    alignItems: 'center',
  },
  statsLabel: { color: '#888', fontSize: 12, textTransform: 'uppercase' },
  statsValue: { color: '#f7931a', fontSize: 32, fontWeight: 'bold' },
  styleBox: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#222',
  },
  styleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  styleLabel: { color: '#e0e0e0', fontSize: 15, fontWeight: '600' },
  styleCount: { color: '#888', fontSize: 13 },
  styleCountMissing: { color: '#f59e0b' },
  styleEmpty: { color: '#555', fontSize: 12, fontStyle: 'italic', marginBottom: 8 },
  sampleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a2e',
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
  sampleInfo: { flex: 1 },
  sampleLabel: { color: '#e0e0e0', fontSize: 13, fontWeight: '600' },
  sampleMeta: { color: '#888', fontSize: 11, marginTop: 2 },
  qualityDot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: 8 },
  deleteBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  deleteBtnText: { color: '#ef4444', fontSize: 16, fontWeight: 'bold' },
  addStyleBtn: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f7931a',
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  addStyleBtnDisabled: { borderColor: '#333', borderStyle: 'solid' },
  addStyleBtnText: { color: '#f7931a', fontSize: 13, fontWeight: '600' },
});