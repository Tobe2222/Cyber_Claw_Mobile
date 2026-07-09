/**
 * WakeSetManagerScreen — list / activate / rename / delete /
 * pull-from-desktop / push-to-desktop for the wake-word
 * model sets.
 *
 * v3.9.0 (wake-only first cut).
 *
 * Storage shape (Kotlin side):
 *   filesDir/wake_models/<setId>/
 *     model.tflite
 *     meta.json   { setId, phrase, scope, agentId?, createdAt }
 *
 * Multiple sets can coexist per agent. The active set is
 * the one the running detector uses; switching to another
 * hot-swaps it in. Trained .tflites the user wants to keep
 * around (e.g. "old hey-clawsu" before a retrain) just
 * sit in the list and can be re-activated anytime.
 *
 * UX:
 *   - Each row shows the setId (or a friendly alias), phrase,
 *     createdAt, sizeBytes, and an "✓ Active" badge when
 *     this set is the agent's active set.
 *   - Per-row buttons: Activate / Rename / Push to desktop
 *     / Delete.
 *   - Sticky "+ Pull from desktop" button at the bottom
 *     opens the desktop-cache list (the desktop has every
 *     .tflite it ever produced under
 *     ~/.openclaw/cyberclaw/wake-training/<agentId>/output/
 *     model/<name>.tflite) and lets the user pull any of
 *     them back into the device's local set registry.
 *
 * Cross-references:
 *   - WakeWordModule.listWakeSets / getActiveWakeSet /
 *     setActiveWakeSet / renameWakeSet / deleteWakeSet /
 *     readWakeSet
 *   - syncClient.requestListWakeSetsFromDesktop /
 *     importWakeSetFromDesktop /
 *     exportWakeSetToDesktop
 *   - Desktop main.js handlers list_wake_sets_from_desktop
 *     / import_wake_set_from_desktop /
 *     export_wake_set_to_desktop
 *   - Desktop sync-server.js wire cases
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  Alert,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeModules } from 'react-native';
import syncClient from '../services/SyncClient';

const { WakeWordModule } = NativeModules;

export type WakeSetEntry = {
  setId: string;
  phrase: string;
  scope: string;
  agentId?: string;
  createdAt: number;
  sizeBytes: number;
  active: boolean;
};

export type DesktopWakeSet = {
  setId: string;
  agentId: string;
  phrase: string;
  sourcePath: string;
  sizeBytes: number;
  modifiedAt: number;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export default function WakeSetManagerScreen({
  agentId,
  agentName,
  onBack,
}: {
  agentId: string;
  agentName: string;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [sets, setSets] = useState<WakeSetEntry[]>([]);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<{ setId: string; value: string } | null>(null);
  const [showDesktopPicker, setShowDesktopPicker] = useState(false);
  const [desktopSets, setDesktopSets] = useState<DesktopWakeSet[]>([]);
  const [desktopLoading, setDesktopLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // setId currently being acted on
  const desktopPickerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await WakeWordModule.listWakeSets();
      const list: WakeSetEntry[] = [];
      if (result && typeof result === 'object') {
        for (const [setId, raw] of Object.entries(result)) {
          const entry = raw as any;
          list.push({
            setId,
            phrase: entry.phrase || setId,
            scope: entry.scope || '',
            agentId: entry.agentId,
            createdAt: Number(entry.createdAt) || 0,
            sizeBytes: Number(entry.sizeBytes) || 0,
            active: !!entry.active,
          });
        }
      }
      list.sort((a, b) => b.createdAt - a.createdAt);
      setSets(list);
      const active = await WakeWordModule.getActiveWakeSet(agentId);
      setActiveSetId(active || null);
    } catch (e: any) {
      console.error('[WakeSetManager] refresh failed', e);
      Alert.alert('Failed to list', e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filter to this agent's sets. The registry is keyed by
  // setId (which may include other agents if the user has
  // multiple companions), so we filter post-read.
  const mySets = sets.filter((s) => !s.agentId || s.agentId === agentId);

  const handleActivate = useCallback(async (setId: string) => {
    setBusy(setId);
    try {
      await WakeWordModule.setActiveWakeSet(agentId, setId);
      setActiveSetId(setId);
      await refresh();
    } catch (e: any) {
      Alert.alert('Activation failed', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [agentId, refresh]);

  const handleDelete = useCallback((setId: string, phrase: string) => {
    Alert.alert(
      'Delete set',
      `Delete "${phrase}"?\n\nThis removes the .tflite and the meta.json. If this set is currently active, the next-detected wake will fall back to the bundled pre-trained model.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(setId);
            try {
              await WakeWordModule.deleteWakeSet(setId);
              await refresh();
            } catch (e: any) {
              Alert.alert('Delete failed', e?.message || String(e));
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }, [refresh]);

  const handleRename = useCallback((setId: string, currentName: string) => {
    setRenaming({ setId, value: currentName });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const newId = renaming.value.trim();
    if (!newId) {
      Alert.alert('Name required', 'Pick a non-empty set name.');
      return;
    }
    if (newId.includes('/') || newId.includes('..')) {
      Alert.alert('Invalid name', 'Set names can\'t contain "/" or "..".');
      return;
    }
    setBusy(renaming.setId);
    try {
      await WakeWordModule.renameWakeSet(renaming.setId, newId);
      setRenaming(null);
      await refresh();
    } catch (e: any) {
      Alert.alert('Rename failed', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [renaming, refresh]);

  // ---- Pull from desktop ----

  const openDesktopPicker = useCallback(() => {
    setShowDesktopPicker(true);
    setDesktopSets([]);
    setDesktopLoading(true);
    syncClient.requestListWakeSetsFromDesktop();
  }, []);

  // Listen for the desktop's response once. The reply is a
  // 'wake_sets_list' message; the default _handleMessage
  // branch re-emits it via this.emit(msg.type, msg).
  useEffect(() => {
    if (!showDesktopPicker) return;
    const onList = (msg: any) => {
      setDesktopLoading(false);
      setDesktopSets(msg?.sets || []);
    };
    const onImported = (msg: any) => {
      if (msg?.ok && msg?.base64) {
        // Save it as a new set in the registry.
        const setId = (msg.setId || `imported-${Date.now()}`)
          .replace(/[^a-zA-Z0-9_\-]/g, '_');
        WakeWordModule.setWakeModelFromBase64(
          agentId,
          msg.base64,
          msg.phrase || setId,
        )
          .then(() => {
            Alert.alert('Imported', `Pulled ${msg.sizeBytes || 0} bytes into "${setId}".`);
            setShowDesktopPicker(false);
            refresh();
          })
          .catch((e: any) => Alert.alert('Import failed', e?.message || String(e)));
      } else if (msg && !msg.ok) {
        Alert.alert('Import failed', msg?.error || 'unknown error');
      }
    };
    syncClient.on('wake_sets_list', onList);
    syncClient.on('wake_set_imported', onImported);
    // Safety timeout: if the desktop doesn't respond in 6s
    // (offline / unreachable), show empty list and stop spinner.
    desktopPickerTimeoutRef.current = setTimeout(() => {
      setDesktopLoading((cur) => {
        if (cur) {
          setDesktopSets([]);
        }
        return false;
      });
    }, 6000);
    return () => {
      syncClient.off?.('wake_sets_list', onList);
      syncClient.off?.('wake_set_imported', onImported);
      if (desktopPickerTimeoutRef.current) {
        clearTimeout(desktopPickerTimeoutRef.current);
        desktopPickerTimeoutRef.current = null;
      }
    };
  }, [showDesktopPicker, agentId, refresh]);

  const pullFromDesktop = useCallback((desktopSet: DesktopWakeSet) => {
    syncClient.importWakeSetFromDesktop(desktopSet.setId, desktopSet.sourcePath);
  }, []);

  // ---- Push to desktop ----

  const handleExportToDesktop = useCallback(async (setId: string) => {
    setBusy(setId);
    try {
      const data = await WakeWordModule.readWakeSet(setId);
      const entry = sets.find((s) => s.setId === setId);
      if (!data?.base64) throw new Error('readWakeSet returned no bytes');
      // Wire up the one-shot listener for the ack.
      const onAck = (msg: any) => {
        if (msg?.ok) {
          Alert.alert('Pushed', `Saved to ${msg.savedPath?.split('/').slice(-3).join('/')} on desktop.`);
        } else {
          Alert.alert('Push failed', msg?.error || 'unknown error');
        }
      };
      syncClient.on('wake_set_exported', onAck);
      syncClient.exportWakeSetToDesktop(setId, data.base64, entry?.phrase || setId);
      // Auto-cleanup the listener after 8s.
      setTimeout(() => syncClient.off?.('wake_set_exported', onAck), 8000);
    } catch (e: any) {
      Alert.alert('Push failed', e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }, [sets]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: Math.max(insets.top + 12, 60) },
        ]}
      >
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Wake Sets</Text>
          <View style={{ width: 60 }} />
        </View>

        <Text style={styles.subtitle}>
          {agentName}'s wake-word training sets. Each set is a
          separate .tflite; switch which one is "active" to
          hot-swap a different wake phrase without retraining.
        </Text>

        {loading ? (
          <ActivityIndicator color="#3b82f6" style={{ marginTop: 32 }} />
        ) : mySets.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              No wake sets yet for {agentName}. Train one — each
              training creates a new set here.
            </Text>
          </View>
        ) : (
          mySets.map((entry) => (
            <View key={entry.setId} style={[styles.setCard, entry.setId === activeSetId && styles.setCardActive]}>
              <View style={styles.setHeader}>
                <Text style={styles.setId}>{entry.setId}</Text>
                {entry.setId === activeSetId ? (
                  <View style={styles.activeBadge}>
                    <Text style={styles.activeBadgeText}>✓ Active</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.phrase}>{entry.phrase}</Text>
              <Text style={styles.meta}>
                {formatBytes(entry.sizeBytes)} · {formatDate(entry.createdAt)}
              </Text>

              <View style={styles.actionRow}>
                {entry.setId !== activeSetId ? (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnPrimary]}
                    onPress={() => handleActivate(entry.setId)}
                    disabled={busy === entry.setId}
                  >
                    <Text style={styles.actionBtnText}>Activate</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={[styles.actionBtn, styles.actionBtnDisabled]}>
                    <Text style={styles.actionBtnTextDisabled}>Active</Text>
                  </View>
                )}
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleRename(entry.setId, entry.setId)}
                  disabled={busy === entry.setId}
                >
                  <Text style={styles.actionBtnText}>Rename</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleExportToDesktop(entry.setId)}
                  disabled={busy === entry.setId}
                >
                  <Text style={styles.actionBtnText}>Push ↗</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionBtnDanger]}
                  onPress={() => handleDelete(entry.setId, entry.phrase)}
                  disabled={busy === entry.setId}
                >
                  <Text style={styles.actionBtnDangerText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}

        <TouchableOpacity
          style={styles.bigBtn}
          onPress={openDesktopPicker}
        >
          <Text style={styles.bigBtnText}>+ Pull from desktop</Text>
        </TouchableOpacity>
        <Text style={styles.helperText}>
          The desktop keeps every .tflite it ever trained for
          you under <Text style={styles.code}>~/.openclaw/cyberclaw/wake-training/</Text>.
          Use this to restore a set after a phone wipe, or to
          swap a different trained phrase onto this companion.
        </Text>
      </ScrollView>

      {/* ---- Rename modal ---- */}
      <Modal
        visible={!!renaming}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename wake set</Text>
            <TextInput
              style={styles.modalInput}
              value={renaming?.value || ''}
              onChangeText={(t) => setRenaming((r) => r ? { ...r, value: t } : null)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="set name"
              placeholderTextColor="#666"
            />
            <View style={styles.modalRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnSecondary]}
                onPress={() => setRenaming(null)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitRename}
              >
                <Text style={styles.modalBtnTextPrimary}>Rename</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ---- Desktop picker modal ---- */}
      <Modal
        visible={showDesktopPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDesktopPicker(false)}
      >
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.desktopSheet}>
            <View style={styles.desktopHeader}>
              <Text style={styles.modalTitle}>Wake sets on desktop</Text>
              <TouchableOpacity onPress={() => setShowDesktopPicker(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {desktopLoading ? (
              <ActivityIndicator color="#3b82f6" style={{ marginTop: 32 }} />
            ) : desktopSets.length === 0 ? (
              <Text style={styles.emptyText}>
                No wake sets found on the desktop. Train one
                first (this device or any other on the same
                desktop), then come back here.
              </Text>
            ) : (
              <ScrollView>
                {desktopSets.map((ds) => (
                  <View key={ds.setId} style={styles.desktopRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.phrase}>{ds.phrase}</Text>
                      <Text style={styles.meta}>
                        {ds.agentId} · {formatBytes(ds.sizeBytes)} · {formatDate(ds.modifiedAt)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionBtnPrimary]}
                      onPress={() => pullFromDesktop(ds)}
                    >
                      <Text style={styles.actionBtnText}>Pull</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { paddingHorizontal: 20, paddingBottom: 60 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  backBtn: { color: '#3b82f6', fontSize: 16, width: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#9ca3af', fontSize: 13, lineHeight: 18, marginBottom: 20 },
  emptyCard: {
    backgroundColor: '#141414',
    borderRadius: 10,
    padding: 20,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  emptyText: { color: '#9ca3af', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  setCard: {
    backgroundColor: '#141414',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
  },
  setCardActive: { borderColor: '#22c55e' },
  setHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  setId: { color: '#9ca3af', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  activeBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  activeBadgeText: { color: '#22c55e', fontSize: 11, fontWeight: '700' },
  phrase: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 4 },
  meta: { color: '#6b7280', fontSize: 12, marginBottom: 12 },
  actionRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1f1f1f',
    minWidth: 60,
    alignItems: 'center',
  },
  actionBtnPrimary: { backgroundColor: '#3b82f6' },
  actionBtnDisabled: { backgroundColor: '#1f1f1f', opacity: 0.5 },
  actionBtnDanger: { backgroundColor: 'rgba(239, 68, 68, 0.15)' },
  actionBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  actionBtnTextDisabled: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  actionBtnDangerText: { color: '#ef4444', fontSize: 13, fontWeight: '600' },
  bigBtn: {
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 16,
  },
  bigBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  helperText: {
    color: '#6b7280',
    fontSize: 12,
    marginTop: 10,
    lineHeight: 18,
    textAlign: 'center',
  },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#9ca3af',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 14,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 14 },
  modalInput: {
    backgroundColor: '#0a0a0a',
    color: '#fff',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    fontSize: 15,
    marginBottom: 16,
  },
  modalRow: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 90,
    alignItems: 'center',
  },
  modalBtnSecondary: { backgroundColor: '#1f1f1f' },
  modalBtnPrimary: { backgroundColor: '#3b82f6' },
  modalBtnText: { color: '#9ca3af', fontSize: 14 },
  modalBtnTextPrimary: { color: '#fff', fontSize: 14, fontWeight: '600' },
  desktopSheet: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    width: '100%',
    height: '80%',
    position: 'absolute',
    bottom: 0,
  },
  desktopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  modalClose: { color: '#9ca3af', fontSize: 22, padding: 4 },
  desktopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    gap: 10,
  },
});