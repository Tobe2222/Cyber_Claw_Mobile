/**
 * WakePhraseMenu — v3.1.77 per-companion phrase list.
 *
 * Replaces the v3.1.13 "list all phrases globally" menu with
 * a per-companion view. Reads from the unified training entry
 * (`cyberclaw-wake-samples-<companionId>`) and shows each
 * phrase with its per-style sample counts.
 *
 * Tobe: "We should also allow more wake phrases like i have
 * Hey clawsuu and Hey Babe which both are created for clawsuu
 * so they trigger for him." Now the menu shows them both as
 * separate phrases under Clawsuu.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, TextInput, BackHandler,
} from 'react-native';
import {
  WakeTrainingEntry,
  WakeSampleStyle,
  loadWakeTraining,
  addWakeSample,
  WAKE_SAMPLE_STYLES,
  WAKE_SAMPLE_STYLE_LABELS,
  WAKE_STYLE_MIN,
  countByStyle,
  flattenFeatures,
} from '../services/WakeTrainingModel';

interface PhraseRow {
  phrase: string;
  sampleCount: number;
  stylesComplete: number; // 0..5: how many styles have ≥1 sample
  trainedAt: string;
  totalFeatures: number;
}

interface Props {
  companionId: string;
  companionName: string;
  onSelectPhrase: (phrase: string) => void;
  onClose: () => void;
}

export default function WakePhraseMenu({ companionId, companionName, onSelectPhrase, onClose }: Props) {
  const [entry, setEntry] = useState<WakeTrainingEntry | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newPhrase, setNewPhrase] = useState('');
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
      if (showAddDialog) { setShowAddDialog(false); return true; }
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [showAddDialog, onClose]);

  const handleAddPhrase = async () => {
    const trimmed = newPhrase.trim();
    if (!trimmed) {
      Alert.alert('Error', 'Please enter a phrase');
      return;
    }
    // Seed the phrase with one "normal" sample so the
    // per-phrase view shows up. Use a synthetic zero-feature
    // sample — the user will record real samples in the
    // TrainingDetailScreen. (We don't actually need any
    // features here; the matcher will see zero-length and
    // skip the phrase until real samples exist.)
    await addWakeSample(companionId, trimmed, {
      style: 'normal',
      features: { energy: [], zcr: [], duration: 0 },
      duration: 0,
      quality: 0,
      date: new Date().toISOString(),
    });
    setShowAddDialog(false);
    setNewPhrase('');
    setReloadKey(k => k + 1);
  };

  const handleDeletePhrase = (phrase: string) => {
    Alert.alert(
      `Delete "${phrase}"?`,
      `Removes the phrase and all its samples from ${companionName}'s training data.`,
      [
        { text: 'Cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!entry) return;
            const updated: WakeTrainingEntry = {
              ...entry,
              phrases: entry.phrases.filter(p => p.phrase.toLowerCase() !== phrase.toLowerCase()),
            };
            updated.features = flattenFeatures(updated);
            await (await import('../services/WakeTrainingModel')).saveWakeTraining(companionId, updated);
            setEntry(updated);
            setReloadKey(k => k + 1);
          },
        },
      ],
    );
  };

  const phrases: PhraseRow[] = (entry?.phrases ?? []).map(p => {
    const counts = countByStyle(p.samples);
    const stylesComplete = WAKE_SAMPLE_STYLES.filter(s => counts[s] >= WAKE_STYLE_MIN).length;
    return {
      phrase: p.phrase,
      sampleCount: p.samples.length,
      stylesComplete,
      trainedAt: entry?.trainedAt ?? new Date().toISOString(),
      totalFeatures: p.samples.filter(s => (s.features?.energy?.length ?? 0) > 0).length,
    };
  });

  const overallFeatures = entry?.features.length ?? 0;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>🎤 Wake Phrases</Text>
        <Text style={styles.subtitle}>{companionName}</Text>
        <Text style={styles.statsLine}>
          {phrases.length} phrase{phrases.length === 1 ? '' : 's'} · {overallFeatures} sample{overallFeatures === 1 ? '' : 's'} total
        </Text>

        {phrases.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No wake phrases yet</Text>
            <Text style={styles.emptySubtext}>Add your first phrase below</Text>
          </View>
        ) : (
          <View style={styles.phrasesList}>
            {phrases.map(p => (
              <PhraseRow
                key={p.phrase.toLowerCase()}
                row={p}
                onSelect={() => onSelectPhrase(p.phrase)}
                onDelete={() => handleDeletePhrase(p.phrase)}
              />
            ))}
          </View>
        )}

        {!showAddDialog ? (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => { setShowAddDialog(true); setNewPhrase(''); }}
          >
            <Text style={styles.addBtnText}>+ Add Wake Phrase</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.dialogBox}>
            <Text style={styles.dialogTitle}>New Wake Phrase for {companionName}</Text>
            <Text style={styles.dialogHint}>
              The phrase will trigger {companionName} when spoken. After
              adding, you'll need to record at least 1 sample of each style.
            </Text>
            <TextInput
              style={styles.dialogInput}
              placeholder={`e.g., hey ${companionName.toLowerCase()}`}
              placeholderTextColor="#666"
              value={newPhrase}
              onChangeText={setNewPhrase}
              autoFocus
            />
            <View style={styles.dialogBtnRow}>
              <TouchableOpacity style={styles.dialogBtn} onPress={handleAddPhrase}>
                <Text style={styles.dialogBtnText}>Add Phrase</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.dialogCancelBtn} onPress={() => setShowAddDialog(false)}>
                <Text style={styles.dialogCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
          <Text style={styles.cancelBtnText}>← Back to Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PhraseRow({ row, onSelect, onDelete }: { row: PhraseRow; onSelect: () => void; onDelete: () => void }) {
  const ready = row.stylesComplete === WAKE_SAMPLE_STYLES.length;
  return (
    <View style={styles.phraseCard}>
      <TouchableOpacity style={styles.phraseInfo} onPress={onSelect}>
        <Text style={styles.phraseName}>{row.phrase}</Text>
        <Text style={styles.phraseMeta}>
          {row.sampleCount} sample{row.sampleCount === 1 ? '' : 's'} · {row.stylesComplete}/{WAKE_SAMPLE_STYLES.length} styles
        </Text>
        <View style={styles.styleProgress}>
          {WAKE_SAMPLE_STYLES.map(s => (
            <View
              key={s}
              style={[
                styles.styleChip,
                // Use a simple colour-code based on whether
                // we have ANY sample of that style for this phrase
                { backgroundColor: ready ? '#10b981' : '#f59e0b' },
              ]}
            >
              <Text style={styles.styleChipText}>{s[0].toUpperCase()}</Text>
            </View>
          ))}
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.deletePhraseBtn} onPress={onDelete}>
        <Text style={styles.deletePhraseBtnText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a1a' },
  content: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 100 },
  title: { color: '#f7931a', fontSize: 24, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { color: '#888', fontSize: 14, marginBottom: 4 },
  statsLine: { color: '#666', fontSize: 12, marginBottom: 24 },
  emptyBox: { alignItems: 'center', padding: 32 },
  emptyText: { color: '#888', fontSize: 16, fontWeight: '600' },
  emptySubtext: { color: '#555', fontSize: 13, marginTop: 4 },
  phrasesList: { gap: 10 },
  phraseCard: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#f7931a',
    alignItems: 'center',
  },
  phraseInfo: { flex: 1 },
  phraseName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  phraseMeta: { color: '#888', fontSize: 12, marginTop: 2 },
  styleProgress: { flexDirection: 'row', marginTop: 8, gap: 4 },
  styleChip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  styleChipText: { color: '#000', fontSize: 11, fontWeight: 'bold' },
  deletePhraseBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  deletePhraseBtnText: { color: '#ef4444', fontSize: 18, fontWeight: 'bold' },
  addBtn: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#10b981',
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  addBtnText: { color: '#10b981', fontSize: 15, fontWeight: '600' },
  dialogBox: {
    marginTop: 16,
    padding: 16,
    backgroundColor: '#111',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f7931a',
  },
  dialogTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 6 },
  dialogHint: { color: '#888', fontSize: 12, marginBottom: 12 },
  dialogInput: {
    backgroundColor: '#1a1a2e',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#333',
  },
  dialogBtnRow: { flexDirection: 'row', gap: 8 },
  dialogBtn: {
    backgroundColor: '#f7931a',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  dialogBtnText: { color: '#000', fontSize: 14, fontWeight: 'bold' },
  dialogCancelBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#555',
  },
  dialogCancelText: { color: '#aaa', fontSize: 14 },
  footer: { padding: 16, paddingBottom: 32 },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelBtnText: { color: '#aaa', fontSize: 15 },
});