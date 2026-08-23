// v3.10.173: Skills Library screen for the mobile app.
//
// Mirrors the desktop's left-sidebar skills library so Tobe can
// browse, create, edit, and toggle per-companion skills from the
// phone. All persistence is server-side — the mobile is a thin
// client over the WebSocket sync bridge. The renderer's preload
// IPCs and the SyncServer case-statements in src/sync-server.js
// implement the same surface; this screen just consumes it.
//
// Layout:
//   - Top bar: "← Back" + "📚 SKILLS LIBRARY"
//   - "+ New Skill" button
//   - "Seed Starter Skills" button (if empty)
//   - List of skill cards (icon, name, description, trigger count,
//     edit/delete buttons)
//   - Per-companion toggle pills for the active companion
//   - Modals for create / edit / view
//
// All modals are in-component (no separate files) to keep this
// self-contained for the initial ship.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Alert,
  BackHandler,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import SyncClient from '../services/SyncClient';
const sync = require('../services/SyncClient').syncClient || SyncClient;

interface SkillRow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  triggers?: string[];
  mtime?: number;
}

interface SkillDetail extends SkillRow {
  body?: string;
  path?: string;
  frontmatter?: any;
  raw?: string;
}

interface SkillValidation {
  ok: boolean;
  errors?: { field: string; message: string }[];
  warnings?: { field: string; message: string }[];
}

interface Props {
  onBack: () => void;
  activeCompanionId?: string;
  activeCompanionName?: string;
}

export default function SkillsScreen({ onBack, activeCompanionId, activeCompanionName }: Props): React.JSX.Element {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [enabledIds, setEnabledIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<null | 'new' | SkillDetail>(null);
  const [viewing, setViewing] = useState<SkillDetail | null>(null);

  const sync = require('../services/SyncClient').syncClient || SyncClient;

  // Initial fetch
  useEffect(() => {
    refreshList();
    if (activeCompanionId) refreshEnabled(activeCompanionId);
    const onList = (msg: any) => setSkills((msg.skills || []) as SkillRow[]);
    const onBroadcast = (msg: any) => setSkills((msg.skills || []) as SkillRow[]);
    const onEnabled = (msg: any) => {
      if (msg.agentId === activeCompanionId) setEnabledIds(msg.enabled || []);
    };
    const onSetResult = (msg: any) => {
      if (msg.agentId === activeCompanionId && msg.ok) setEnabledIds(msg.enabled || []);
    };
    const onSeedResult = (msg: any) => {
      if (msg.ok) refreshList();
    };
    sync.on('skills_list', onList);
    sync.on('skills_list_broadcast', onBroadcast);
    sync.on('enabled_skills', onEnabled);
    sync.on('enabled_skills_set', onSetResult);
    sync.on('skill_seed_result', onSeedResult);
    return () => {
      sync.off('skills_list', onList);
      sync.off('skills_list_broadcast', onBroadcast);
      sync.off('enabled_skills', onEnabled);
      sync.off('enabled_skills_set', onSetResult);
      sync.off('skill_seed_result', onSeedResult);
    };
  }, [sync, activeCompanionId]);

  // Hardware back button (Android)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editing) { setEditing(null); return true; }
      if (viewing) { setViewing(null); return true; }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [editing, viewing, onBack]);

  const refreshList = useCallback(() => {
    setLoading(true);
    sync.requestSkillsList();
    // The skills_list response handler will clear loading via setSkills
    setTimeout(() => setLoading(false), 3000); // fallback timeout
  }, [sync]);

  const refreshEnabled = useCallback((agentId: string) => {
    sync.requestEnabledSkills(agentId);
  }, [sync]);

  const seedStarters = () => {
    Alert.alert('Seed starter skills', 'Add the built-in starter skill set (Send Screenshots, Deploy via pm2, Manage Cybercomputer Services)?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Seed', onPress: () => sync.seedStarterSkills() },
    ]);
  };

  const toggleEnabled = (skillId: string) => {
    if (!activeCompanionId) {
      Alert.alert('No active companion', 'Pick a companion on the home screen first.');
      return;
    }
    const next = enabledIds.includes(skillId)
      ? enabledIds.filter(id => id !== skillId)
      : [...enabledIds, skillId];
    setEnabledIds(next); // optimistic
    sync.setEnabledSkills(activeCompanionId, next);
  };

  const openSkill = (id: string) => {
    sync.requestSkillRead(id);
    sync.once('skill_read', (msg: any) => {
      if (msg.ok && msg.skill && msg.skill.id === id) {
        setViewing(msg.skill as SkillDetail);
      }
    });
  };

  const startEdit = (skill: SkillDetail | 'new') => {
    setEditing(skill);
  };

  const deleteSkill = (id: string) => {
    Alert.alert('Delete skill', `Delete "${id}"? This can't be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        sync.deleteSkill(id);
        sync.once('skill_delete_result', (msg: any) => {
          if (msg.ok) {
            setViewing(null);
          } else {
            Alert.alert('Delete failed', msg.error || 'unknown error');
          }
        });
      }},
    ]);
  };

  // Subscribe to create/update results for the modal
  const createSkillHandlerRef = useRef<((msg: any) => void) | null>(null);
  const updateSkillHandlerRef = useRef<((msg: any) => void) | null>(null);
  useEffect(() => {
    const onCreate = (msg: any) => createSkillHandlerRef.current?.(msg);
    const onUpdate = (msg: any) => updateSkillHandlerRef.current?.(msg);
    sync.on('skill_create_result', onCreate);
    sync.on('skill_update_result', onUpdate);
    return () => {
      sync.off('skill_create_result', onCreate);
      sync.off('skill_update_result', onUpdate);
    };
  }, [sync]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}><Text style={styles.backArrow}>←</Text></Pressable>
        <Text style={styles.headerTitle}>📚 SKILLS LIBRARY</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.toolbar}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => startEdit('new')}>
            <Text style={styles.btnText}>+ New Skill</Text>
          </Pressable>
          {skills.length === 0 && (
            <Pressable style={[styles.btn, styles.btnSecondary]} onPress={seedStarters}>
              <Text style={styles.btnText}>Seed Starter Skills</Text>
            </Pressable>
          )}
        </View>

        {activeCompanionId && skills.length > 0 && (
          <View style={styles.companionSection}>
            <Text style={styles.sectionTitle}>Enabled for {activeCompanionName || activeCompanionId}</Text>
            <View style={styles.pillRow}>
              {skills.map(s => {
                const on = enabledIds.includes(s.id);
                return (
                  <Pressable key={s.id} style={[styles.pill, on ? styles.pillOn : styles.pillOff]} onPress={() => toggleEnabled(s.id)}>
                    <Text style={styles.pillIcon}>{s.icon || '🔧'}</Text>
                    <Text style={styles.pillName} numberOfLines={1}>{s.name}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.helperText}>
              Tap a pill to toggle this skill for the current companion. Enabled skills are added to the companion's prompt — it'll apply their process when relevant.
            </Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>Library ({skills.length})</Text>
        {loading && skills.length === 0 ? (
          <Text style={styles.emptyText}>Loading…</Text>
        ) : skills.length === 0 ? (
          <Text style={styles.emptyText}>No skills yet. Tap "Seed Starter Skills" or "+ New Skill" above.</Text>
        ) : (
          skills.map(s => (
            <Pressable key={s.id} style={styles.card} onPress={() => openSkill(s.id)}>
              <Text style={styles.cardIcon}>{s.icon || '🔧'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{s.name}</Text>
                {!!s.description && <Text style={styles.cardDesc} numberOfLines={2}>{s.description}</Text>}
                <Text style={styles.cardMeta}>
                  {(s.triggers || []).length} trigger{((s.triggers || []).length === 1) ? '' : 's'}
                  {enabledIds.includes(s.id) ? ' · ✓ enabled' : ''}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </ScrollView>

      {viewing && (
        <SkillViewModal
          skill={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { const s = viewing; setViewing(null); startEdit(s); }}
          onDelete={() => deleteSkill(viewing.id)}
        />
      )}

      {editing && (
        <SkillEditModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            return new Promise<{ ok: boolean; validation?: SkillValidation; error?: string }>((resolve) => {
              if (editing === 'new') {
                createSkillHandlerRef.current = (msg: any) => {
                  createSkillHandlerRef.current = null;
                  resolve({ ok: msg.ok, validation: msg.validation, error: msg.error });
                };
                sync.createSkill(payload);
              } else if (editing && editing.id) {
                updateSkillHandlerRef.current = (msg: any) => {
                  updateSkillHandlerRef.current = null;
                  resolve({ ok: msg.ok, validation: msg.validation, error: msg.error });
                };
                sync.updateSkill(editing.id, payload);
              } else {
                resolve({ ok: false, error: 'unknown state' });
              }
            });
          }}
        />
      )}
    </View>
  );
}

// ─── Skill view modal ──────────────────────────────────────────────

function SkillViewModal({ skill, onClose, onEdit, onDelete }: { skill: SkillDetail; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <Modal animationType="slide" transparent={false} visible onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn}><Text style={styles.backArrow}>✕</Text></Pressable>
          <Text style={styles.headerTitle}>{skill.icon || '🔧'} {skill.name.toUpperCase()}</Text>
        </View>
        <ScrollView style={styles.scroll}>
          <Text style={styles.metaLine}>id: {skill.id}</Text>
          {!!skill.description && (
            <>
              <Text style={styles.h2}>Description</Text>
              <Text style={styles.body}>{skill.description}</Text>
            </>
          )}
          {!!(skill.triggers || []).length && (
            <>
              <Text style={styles.h2}>Triggers</Text>
              {(skill.triggers || []).map((t, i) => (
                <Text key={i} style={styles.bullet}>• {t}</Text>
              ))}
            </>
          )}
          <Text style={styles.h2}>Process</Text>
          <Text style={styles.body}>{skill.body || '(empty)'}</Text>
        </ScrollView>
        <View style={styles.modalActions}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onEdit}>
            <Text style={styles.btnText}>✎ Edit</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnDanger]} onPress={onDelete}>
            <Text style={styles.btnText}>🗑 Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ─── Skill create/edit modal ───────────────────────────────────────

function SkillEditModal({ initial, onClose, onSave }: { initial: SkillDetail | null; onSave: (p: any) => Promise<{ ok: boolean; validation?: SkillValidation; error?: string }>; onClose: () => void }) {
  const [name, setName] = useState(initial?.name || '');
  const [icon, setIcon] = useState(initial?.icon || '🔧');
  const [desc, setDesc] = useState(initial?.description || '');
  const [triggers, setTriggers] = useState((initial?.triggers || []).join('\n'));
  const [body, setBody] = useState(initial?.body || '');
  const [saving, setSaving] = useState(false);
  const [validationMsg, setValidationMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setValidationMsg({ text: 'Name is required.', isError: true });
      return;
    }
    setSaving(true);
    setValidationMsg(null);
    const tr = triggers.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const result = await onSave({ name: name.trim(), icon: icon.trim() || '🔧', description: desc.trim(), triggers: tr, body });
    setSaving(false);
    if (!result.ok) {
      setValidationMsg({ text: 'Save failed: ' + (result.error || 'unknown'), isError: true });
      return;
    }
    const v = result.validation;
    if (v && (v.errors?.length || v.warnings?.length)) {
      const msgs: string[] = [];
      if (v.errors?.length) msgs.push('Errors: ' + v.errors.map(e => e.message).join('; '));
      if (v.warnings?.length) msgs.push('Heads up: ' + v.warnings.map(w => w.message).join('; '));
      setValidationMsg({ text: msgs.join('\n'), isError: (v.errors?.length || 0) > 0 });
      if ((v.errors?.length || 0) > 0) return;
    }
    onClose();
  };

  return (
    <Modal animationType="slide" transparent={false} visible onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.backBtn}><Text style={styles.backArrow}>✕</Text></Pressable>
          <Text style={styles.headerTitle}>{initial ? '✎ EDIT SKILL' : '+ NEW SKILL'}</Text>
        </View>
        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Send Screenshots to User" maxLength={80} placeholderTextColor="#666" />
          <Text style={styles.label}>Icon (one emoji)</Text>
          <TextInput style={styles.input} value={icon} onChangeText={setIcon} maxLength={4} placeholderTextColor="#666" />
          <Text style={styles.label}>Description (one line)</Text>
          <TextInput style={styles.input} value={desc} onChangeText={setDesc} placeholder="Short summary" maxLength={240} placeholderTextColor="#666" />
          <Text style={styles.label}>Triggers (one per line)</Text>
          <TextInput style={[styles.input, styles.textareaSmall]} value={triggers} onChangeText={setTriggers} placeholder={'user asks for a picture\nuser says they cannot see something'} multiline placeholderTextColor="#666" />
          <Text style={styles.label}>Process (markdown — headings + numbered/bulleted steps)</Text>
          <TextInput style={[styles.input, styles.textareaLarge]} value={body} onChangeText={setBody} placeholder={'# When to use\n\nUse this when...\n\n# Process\n\n1. Step one\n2. Step two'} multiline placeholderTextColor="#666" />
          {validationMsg && (
            <Text style={[styles.validationMsg, validationMsg.isError ? styles.validationErr : styles.validationWarn]}>{validationMsg.text}</Text>
          )}
        </ScrollView>
        <View style={styles.modalActions}>
          <Pressable style={[styles.btn, styles.btnSecondary]} onPress={onClose} disabled={saving}>
            <Text style={styles.btnText}>Cancel</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={handleSave} disabled={saving}>
            <Text style={styles.btnText}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0e' },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 50, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1f1f2e' },
  backBtn: { padding: 8, marginRight: 8 },
  backArrow: { fontSize: 22, color: '#ff6b35', fontWeight: '600' },
  headerTitle: { fontSize: 16, color: '#ff6b35', fontWeight: '700', letterSpacing: 1 },
  scroll: { flex: 1, paddingHorizontal: 12 },
  toolbar: { flexDirection: 'row', gap: 8, paddingVertical: 12 },
  btn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#ff6b35' },
  btnSecondary: { backgroundColor: '#1f1f2e', borderWidth: 1, borderColor: '#00c8c8' },
  btnDanger: { backgroundColor: '#1f1f2e', borderWidth: 1, borderColor: '#ff6060' },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  companionSection: { marginVertical: 8, padding: 10, backgroundColor: '#14141c', borderRadius: 6 },
  sectionTitle: { fontSize: 12, color: '#00c8c8', fontWeight: '600', marginTop: 14, marginBottom: 8, letterSpacing: 0.5 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, gap: 4 },
  pillOn: { backgroundColor: 'rgba(255, 107, 53, 0.25)', borderWidth: 1, borderColor: '#ff6b35' },
  pillOff: { backgroundColor: '#1f1f2e', borderWidth: 1, borderColor: '#2a2a3e' },
  pillIcon: { fontSize: 12 },
  pillName: { fontSize: 11, color: '#e8e8ec', fontWeight: '500' },
  helperText: { fontSize: 10, color: '#888', marginTop: 6, lineHeight: 14 },
  emptyText: { color: '#888', fontSize: 12, textAlign: 'center', paddingVertical: 20, fontStyle: 'italic' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginVertical: 3, backgroundColor: '#14141c', borderRadius: 6 },
  cardIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  cardName: { fontSize: 13, color: '#e8e8ec', fontWeight: '600' },
  cardDesc: { fontSize: 11, color: '#aaa', marginTop: 2 },
  cardMeta: { fontSize: 10, color: '#00c8c8', marginTop: 3 },

  // Modal styles
  modalRoot: { flex: 1, backgroundColor: '#0a0a0e' },
  modalActions: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: '#1f1f2e', backgroundColor: '#14141c' },
  metaLine: { fontSize: 10, color: '#888', marginTop: 8, fontFamily: 'monospace' },
  h2: { fontSize: 14, color: '#ff6b35', fontWeight: '700', marginTop: 12, marginBottom: 6 },
  body: { fontSize: 12, color: '#e8e8ec', lineHeight: 18 },
  bullet: { fontSize: 12, color: '#e8e8ec', lineHeight: 18, marginLeft: 6 },

  // Edit form
  label: { fontSize: 11, color: '#00c8c8', fontWeight: '600', marginTop: 12, marginBottom: 4, letterSpacing: 0.5 },
  input: { backgroundColor: '#14141c', borderWidth: 1, borderColor: '#2a2a3e', color: '#e8e8ec', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  textareaSmall: { minHeight: 60, textAlignVertical: 'top' },
  textareaLarge: { minHeight: 200, textAlignVertical: 'top', fontFamily: 'monospace' },
  validationMsg: { marginTop: 10, padding: 8, borderRadius: 4, fontSize: 11, lineHeight: 16 },
  validationErr: { backgroundColor: 'rgba(255, 96, 96, 0.15)', color: '#ff8080' },
  validationWarn: { backgroundColor: 'rgba(255, 170, 0, 0.15)', color: '#ffcc66' },
});
