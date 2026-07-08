// v3.7.6: lifted out of CompanionSettingsScreen so Quests is its
// own top-level page. Quests are global on the desktop (single
// quests.json, not per-companion), so they should be global on the
// mobile too — not nested inside a companion's settings.
//
// Pure-render component: all hooks live at the screen level (per
// the v3.7.1 lesson about hook-order-invariants when a screen has
// multiple render-functions). No helpers here that need to call
// hooks.
//
// Replaces the per-companion `cyberclaw-quests-<companionId>`
// cache key added in v3.7.4 with a single `cyberclaw-quests` key.
// On first mount, migrates any legacy per-companion entries by
// unioning them and removing the old keys.

import React, { useState, useEffect } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Clipboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';

type CompanionQuest = {
  id: string;
  name: string;
  description?: string;
  status?: 'active' | 'completed';
  directory?: string;
  goals?: Array<{ text: string; completed: boolean }>;
  created?: string;
  [k: string]: any;
};

const CACHE_KEY = 'cyberclaw-quests';
// v3.7.4 used per-companion keys. Read them on first mount and
// union the entries (deduped by id) into the new global cache.
const LEGACY_KEY_PREFIX = 'cyberclaw-quests-';

export default function QuestsScreen({
  onBack,
}: {
  onBack: () => void;
}) {
  const [quests, setQuests] = useState<CompanionQuest[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // v3.7.6: hydrate from the global cache key on mount, then
  // migrate any v3.7.4-era per-companion keys (cyberclaw-quests-<id>)
  // into the global cache before deleting them.
  //
  // SyncClient already auto-fires request_quests_list() on auth
  // and replays the cached payload on reconnect, so a live
  // `quests_list` event will arrive shortly after the screen
  // mounts. The cache read here is for offline-survival and for
  // covering the brief window before the desktop's first broadcast
  // lands.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Read new global cache (if any)
        let initial: CompanionQuest[] = [];
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) initial = parsed;
        }

        // 2. Sweep legacy per-companion keys, union them into the
        //    global cache. Dedup by id, prefer the entry from the
        //    global cache if both exist (the global is fresher
        //    because it's what the SyncClient writes to).
        //
        //    NOTE: the v3.0+ AsyncStorage API renamed
        //    `multiGet` → `getMany` and `multiRemove` →
        //    `removeMany`. `getMany` returns a Record<key,val>
        //    rather than Array<[key,val]>, so we iterate
        //    Object.entries() instead of destructuring tuples.
        const allKeys = await AsyncStorage.getAllKeys();
        const legacyKeys = allKeys.filter((k) => k.startsWith(LEGACY_KEY_PREFIX));
        if (legacyKeys.length > 0) {
          const legacyMap = await AsyncStorage.getMany(legacyKeys);
          const byId = new Map<string, CompanionQuest>();
          for (const val of Object.values(legacyMap)) {
            if (!val) continue;
            try {
              const arr = JSON.parse(val);
              if (Array.isArray(arr)) {
                for (const q of arr) {
                  if (q && typeof q === 'object' && q.id && !byId.has(q.id)) {
                    byId.set(q.id, q);
                  }
                }
              }
            } catch (_) {}
          }
          // Merge: legacy entries first, then global (global wins on id collision).
          for (const q of byId.values()) {
            if (!initial.some((g) => g.id === q.id)) initial.push(q);
          }
          // Persist merged global, drop legacy keys.
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(initial));
          await AsyncStorage.removeMany(legacyKeys);
        }

        if (!cancelled) {
          setQuests(initial);
          setHydrated(true);
        }
      } catch (_) {
        if (!cancelled) setHydrated(true);
      }
    })();

    // 3. Subscribe to live updates from SyncClient. The desktop
    //    broadcasts on boot + on every quest CRUD. Write through
    //    to the global cache on every receipt.
    const handler = (msg: any) => {
      const list: CompanionQuest[] = Array.isArray(msg?.quests) ? msg.quests : [];
      setQuests(list);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(list)).catch(() => {});
    };
    syncClient.on?.('quests_list', handler);

    return () => {
      cancelled = true;
      syncClient.off?.('quests_list', handler);
    };
  }, []);

  // Active first, then completed (matches desktop sort).
  const sorted = quests.slice().sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return 0;
  });

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.detailHeaderRow}>
          <TouchableOpacity
            onPress={onBack}
            style={styles.detailBackBtn}
          >
            <Text style={styles.detailBackBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.detailHeader}>📜  Quests</Text>
          <View style={{ width: 60 }} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active quests</Text>
          <Text style={styles.sectionDesc}>
            Synced read-only from the desktop's Quests panel.
            Edit / add / delete on the desktop; the phone updates automatically.
          </Text>
          <Text style={styles.hint}>Tap a card to copy the project path to clipboard.</Text>

          {!hydrated ? (
            <View style={styles.emptyHintBox}>
              <Text style={styles.emptyHintText}>Loading…</Text>
            </View>
          ) : sorted.length === 0 ? (
            <View style={styles.emptyHintBox}>
              <Text style={styles.emptyHintText}>
                No quests yet. Create one on the desktop in the 📜 Quests panel.
              </Text>
            </View>
          ) : (
            sorted.map((q) => {
              const isComplete = q.status === 'completed';
              const goals = Array.isArray(q.goals) ? q.goals : [];
              const done = goals.filter((g) => g.completed).length;
              const pct = goals.length === 0 ? 0 : Math.round((done / goals.length) * 100);
              const dirName = q.directory
                ? q.directory.split('/').filter(Boolean).pop() || q.directory
                : '';
              return (
                <TouchableOpacity
                  key={q.id}
                  style={[
                    styles.questCard,
                    {
                      borderColor: isComplete ? '#10b981' : '#a855f7',
                      opacity: isComplete ? 0.55 : 1,
                    },
                  ]}
                  onLongPress={() => {
                    if (q.directory) {
                      Clipboard.setString(q.directory);
                    }
                  }}
                >
                  <View style={styles.questTopRow}>
                    <Text style={styles.questName}>
                      {isComplete ? '✅' : '⚔️'}  {q.name}
                    </Text>
                    <Text style={styles.questPct}>{done}/{goals.length}</Text>
                  </View>
                  {!!q.description && (
                    <Text style={styles.questDesc}>{q.description}</Text>
                  )}
                  {goals.length > 0 && (
                    <View style={styles.questBar}>
                      <View
                        style={[
                          styles.questFill,
                          {
                            width: `${pct}%`,
                            backgroundColor: pct >= 100 ? '#10b981' : '#a855f7',
                          },
                        ]}
                      />
                    </View>
                  )}
                  {!!q.directory && (
                    <Text style={styles.questDir} numberOfLines={1}>
                      📁 {dirName}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About quests on mobile</Text>
          <Text style={styles.sectionDesc}>
            • Quests are owned by the desktop and synced via WebSocket on every change.{'\n'}
            • Project paths are NOT stored on the phone — {`quest.directory`} is read from the desktop as the project's real path and shown for reference only.{'\n'}
            • Long-press a card to copy the project path to clipboard.{'\n'}
            • Editing / creating / deleting happens on the desktop for now.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { padding: 16, paddingBottom: 64 },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  detailBackBtn: { paddingVertical: 4, paddingRight: 12 },
  detailBackBtnText: { color: '#f7931a', fontSize: 16 },
  detailHeader: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  sectionDesc: { color: '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  hint: { color: '#aaa', fontSize: 12, fontStyle: 'italic', marginBottom: 12 },
  questCard: {
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginVertical: 6,
  },
  questTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  questName: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1 },
  questPct: { color: '#aaa', fontSize: 12, fontVariant: ['tabular-nums'] },
  questDesc: { color: '#9aa0b4', fontSize: 13, lineHeight: 17, marginBottom: 6 },
  questBar: {
    height: 4,
    backgroundColor: '#1a1a2e',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
    marginBottom: 6,
  },
  questFill: { height: '100%', borderRadius: 2 },
  questDir: { color: '#7a809a', fontSize: 11, marginTop: 4 },
  emptyHintBox: {
    paddingVertical: 16,
    paddingHorizontal: 12,
    backgroundColor: '#0f1626',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a3e',
    borderStyle: 'dashed',
    marginTop: 4,
  },
  emptyHintText: { color: '#888', fontSize: 13, lineHeight: 18, textAlign: 'center' },
});