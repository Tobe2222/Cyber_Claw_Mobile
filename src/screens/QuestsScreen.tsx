// v3.7.6: lifted out of CompanionSettingsScreen so Quests is its
// own top-level page. Quests are global on the desktop (single
// quests.json, not per-companion), so they should be global on the
// mobile too — not nested inside a companion's settings.
//
// v3.7.7: safe-area padding at the top so the header doesn't
// collide with the iOS status bar / Android Dynamic Island
// (Tobe's v3.7.6 screenshot showed the "← Back" arrow under
// the 11:57 status indicator). Follows the v3.4.5 pattern from
// CompanionSettingsScreen / SettingsScreen (paddingTop: 50 on
// the scroll container + paddingTop: 34 on the header row on
// Android for the extra system-bar height).
//
// v3.7.7: tap a card to open a detail modal showing the full
// description, the full goals list (checkboxes per step), the
// full directory path, and the created date. The list-card
// long-press-to-copy-path is preserved. Tobe: "we should be
// able to click for a more detailed view of the quest, its
// points/steps, directory etc."
//
// v3.7.8: render the two new fields that desktop v3.1.50 added
// to the quest model. (1) `active: true|false` on each quest —
// the active quest is the one the companion is currently
// working on, persisted in ~/.openclaw/cyberclaw/quests.json.
// Show a loud ⚡ ACTIVE badge on the active card and put it
// first in the sort. (2) `latestChanges: [{timestamp, text}]`
// — the companion's running journal of what it did on this
// quest. Show as a timeline in the detail modal.
//
// Wire protocol: no new channels — the new fields ride the
// existing `quests_list` event from v3.1.49. The mobile just
// reads them off the quest object the SyncClient already
// hands it.
//
// Pure-render component: all hooks live at the screen level (per
// the v3.7.1 lesson about hook-order-invariants when a screen has
// multiple render-functions). No helpers here that need to call
// hooks.

import React, { useState, useEffect } from 'react';
import {
  Clipboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
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
  // v3.7.8: new fields from desktop v3.1.50. `active` flags
  // which quest the companion is currently working on (exactly
  // one per desktop). `latestChanges` is the companion's
  // running journal of what it did on this quest.
  active?: boolean;
  latestChanges?: Array<{ timestamp: string; text: string }>;
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
  // v3.7.7: tapped quest shown in the detail modal. null = closed.
  const [detail, setDetail] = useState<CompanionQuest | null>(null);

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

  // v3.7.8: sort order is now (1) the active quest, then
  // (2) non-completed quests, then (3) completed quests.
  // Matches the desktop's intent: the working quest is
  // always at the top, even if it's been marked completed.
  const sorted = quests.slice().sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
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
          <Text style={styles.sectionTitle}>Quests</Text>
          <Text style={styles.sectionDesc}>
            Synced read-only from the desktop's Quests panel.
            The active quest (the one the companion is working on) is
            marked with a ⚡ ACTIVE badge and a gold border.
            Edit / add / delete on the desktop; the phone updates automatically.
          </Text>
          <Text style={styles.hint}>Tap a card for the full details. Long-press to copy the project path.</Text>

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
              const isActive = !!q.active;
              const goals = Array.isArray(q.goals) ? q.goals : [];
              const done = goals.filter((g) => g.completed).length;
              const pct = goals.length === 0 ? 0 : Math.round((done / goals.length) * 100);
              const dirName = q.directory
                ? q.directory.split('/').filter(Boolean).pop() || q.directory
                : '';
              // v3.7.8: active quest gets a gold border + soft
              // gold glow. If active + completed, use a muted
              // gold so it doesn't shout. The completed
              // (non-active) case is unchanged.
              const borderColor = isActive
                ? (isComplete ? 'rgba(247, 147, 26, 0.6)' : '#f7931a')
                : (isComplete ? '#10b981' : '#a855f7');
              const cardOpacity = isActive
                ? (isComplete ? 0.85 : 1)
                : (isComplete ? 0.55 : 1);
              // v3.7.8: the number of recent changes goes
              // next to the done/total as a small inline
              // counter — subtle hint that the detail modal
              // has more.
              const changeCount = Array.isArray(q.latestChanges) ? q.latestChanges.length : 0;
              return (
                <TouchableOpacity
                  key={q.id}
                  style={[
                    styles.questCard,
                    {
                      borderColor,
                      borderWidth: isActive ? 2 : 1.5,
                      opacity: cardOpacity,
                    },
                  ]}
                  onPress={() => setDetail(q)}
                  onLongPress={() => {
                    if (q.directory) {
                      Clipboard.setString(q.directory);
                    }
                  }}
                >
                  {isActive && (
                    // v3.7.8: ⚡ ACTIVE badge sits in the
                    // top-right of the card. Bold gold so
                    // it's the first thing the eye lands on.
                    <View style={styles.activeBadge}>
                      <Text style={styles.activeBadgeText}>⚡ ACTIVE</Text>
                    </View>
                  )}
                  <View style={styles.questTopRow}>
                    <Text style={styles.questName} numberOfLines={1}>
                      {isComplete ? '✅' : '⚔️'}  {q.name}
                    </Text>
                    <Text style={styles.questPct}>{done}/{goals.length}</Text>
                  </View>
                  {!!q.description && (
                    <Text style={styles.questDesc} numberOfLines={2}>
                      {q.description}
                    </Text>
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
                  {changeCount > 0 && (
                    // v3.7.8: small inline counter showing
                    // how many journal entries exist. Tapping
                    // the card opens the detail modal where
                    // the full timeline is rendered.
                    <Text style={styles.questChangesHint}>
                      📝 {changeCount} change{changeCount === 1 ? '' : 's'} logged
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

      {/* v3.7.7: tap-to-detail modal. Tobe: "we should be able
          to click for a more detailed view of the quest, its
          points/steps, directory etc." Renders the full goal
          list with per-step checkboxes, the complete directory
          path (tap to copy), the description, and the created
          date. Tapping the scrim or the Close button dismisses.
          The scrim is a separate absoluteFill Pressable behind
          the card so taps on the card don't bubble to the
          scrim (stopPropagation isn't reliable on RN synthetic
          events across all versions). */}
      <Modal
        visible={!!detail}
        transparent
        animationType="fade"
        onRequestClose={() => setDetail(null)}
      >
        <View style={styles.modalScrim}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setDetail(null)}
          />
          <View style={styles.modalCard}>
            {detail && <QuestDetailBody quest={detail} />}
            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setDetail(null)}
            >
              <Text style={styles.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// v3.7.7: detail-modal body. Pure render — props in, JSX out,
// no hooks. Keeping it a sibling function of QuestsScreen so
// the screen-level hook order stays clean (v3.7.1 pattern).
function QuestDetailBody({ quest }: { quest: CompanionQuest }) {
  const isComplete = quest.status === 'completed';
  const isActive = !!quest.active;
  const goals = Array.isArray(quest.goals) ? quest.goals : [];
  const done = goals.filter((g) => g.completed).length;
  const pct = goals.length === 0 ? 0 : Math.round((done / goals.length) * 100);
  const created = quest.created ? new Date(quest.created) : null;
  // v3.7.8: latestChanges is the companion's running journal
  // of what it did on this quest. Sort newest-first so the
  // most recent work is at the top of the timeline.
  const changes = Array.isArray(quest.latestChanges) ? quest.latestChanges.slice().reverse() : [];

  return (
    <ScrollView style={styles.modalBody} contentContainerStyle={styles.modalBodyContent}>
      <Text style={styles.modalTitle}>
        {isComplete ? '✅' : '⚔️'}  {quest.name}
      </Text>

      <View style={styles.modalStatusRow}>
        {isActive && (
          // v3.7.8: separate ACTIVE badge so the detail
          // modal makes it clear which quest is the
          // working one. The Active/Completed badge
          // below describes the quest's status; this
          // ACTIVE badge describes whether the
          // companion is currently working on it.
          // The two are independent: you can have a
          // Completed quest that is still ACTIVE (you
          // finished but still have it open for
          // reference).
          <View style={styles.modalActiveBadge}>
            <Text style={styles.modalActiveBadgeText}>⚡ ACTIVE</Text>
          </View>
        )}
        <View
          style={[
            styles.modalStatusBadge,
            {
              backgroundColor: isComplete ? '#0a3d2e' : '#3d1e5e',
              borderColor: isComplete ? '#10b981' : '#a855f7',
            },
          ]}
        >
          <Text
            style={[
              styles.modalStatusBadgeText,
              { color: isComplete ? '#10b981' : '#c084fc' },
            ]}
          >
            {isComplete ? 'Completed' : 'Active'}
          </Text>
        </View>
        {goals.length > 0 && (
          <Text style={styles.modalPct}>{done}/{goals.length}  ·  {pct}%</Text>
        )}
      </View>

      {!!quest.description && (
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>Description</Text>
          <Text style={styles.modalSectionBody}>{quest.description}</Text>
        </View>
      )}

      {goals.length > 0 && (
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>
            Steps / goals ({done}/{goals.length})
          </Text>
          {goals.map((g, i) => (
            <View key={i} style={styles.goalRow}>
              <Text
                style={[
                  styles.goalCheckbox,
                  { color: g.completed ? '#10b981' : '#7a809a' },
                ]}
              >
                {g.completed ? '☑' : '☐'}
              </Text>
              <Text
                style={[
                  styles.goalText,
                  g.completed && styles.goalTextDone,
                ]}
              >
                {g.text}
              </Text>
            </View>
          ))}
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
        </View>
      )}

      {!!quest.directory && (
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>Project directory</Text>
          <TouchableOpacity
            onPress={() => Clipboard.setString(quest.directory!)}
            style={styles.modalDirBox}
          >
            <Text style={styles.modalDirPath} selectable>
              {quest.directory}
            </Text>
            <Text style={styles.modalDirHint}>Tap to copy</Text>
          </TouchableOpacity>
        </View>
      )}

      {created && !isNaN(created.getTime()) && (
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>Created</Text>
          <Text style={styles.modalSectionBody}>
            {created.toLocaleString()}
          </Text>
        </View>
      )}

      {changes.length > 0 && (
        // v3.7.8: latest changes timeline. Shows the
        // companion's journal of what it did on this quest,
        // newest first. Each entry has a relative timestamp
        // (e.g. "2h ago") plus the text. The user can
        // scroll through the full history.
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>
            Latest changes ({changes.length})
          </Text>
          <Text style={styles.changeIntro}>
            Synced from the desktop. The companion appends to this when it does something worth logging.
          </Text>
          {changes.map((c, i) => {
            const ts = c?.timestamp ? new Date(c.timestamp) : null;
            const ago = ts && !isNaN(ts.getTime()) ? formatTimeAgo(ts) : '';
            return (
              <View key={i} style={styles.changeRow}>
                <View style={styles.changeDot} />
                <View style={styles.changeBody}>
                  <Text style={styles.changeText}>{c?.text || ''}</Text>
                  {!!ago && (
                    <Text style={styles.changeTime}>{ago}</Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

// v3.7.8: format a date as a relative time-ago string.
// Pure function, no hooks, used in the latestChanges
// timeline. Mirrors the desktop's fmtAgo in app.js so
// the mobile and desktop render the same way.
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const t = date.getTime();
  if (isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  // Older than 30 days: show the actual date so the
  // relative time doesn't get absurdly long.
  return date.toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  // v3.7.7: paddingTop: 50 matches the v3.4.5 pattern from
  // CompanionSettingsScreen / SettingsScreen. Clears both
  // Android status bars (~30-40dp) and iOS Dynamic Island
  // (~30pt + safe area). SafeAreaView in App.tsx handles the
  // bottom inset; the ScrollView still needs explicit top
  // padding because the SafeAreaView's top extends to the top
  // of the device edge.
  scroll: { padding: 16, paddingTop: 50, paddingBottom: 64 },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    // v3.7.7: extra top padding on Android for the system
    // bar height (matches the v3.4.5 header pattern).
    paddingTop: Platform.OS === 'android' ? 34 : 10,
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

  // v3.7.7: detail-modal styles. Modal renders over the
  // list with a translucent dark scrim. The card has its
  // own ScrollView so long goal lists don't overflow the
  // viewport.
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#0f1626',
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#a855f7',
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  modalBody: { flexGrow: 0 },
  modalBodyContent: { padding: 18, paddingBottom: 8 },
  modalTitle: {
    color: '#fff',
    fontSize: 19,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  modalStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalStatusBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginRight: 10,
  },
  modalStatusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  modalPct: {
    color: '#aaa',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  modalSection: { marginBottom: 16 },
  modalSectionTitle: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  modalSectionBody: {
    color: '#cfd2e0',
    fontSize: 14,
    lineHeight: 20,
  },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginVertical: 3,
  },
  goalCheckbox: {
    fontSize: 16,
    width: 22,
    textAlign: 'center',
    marginTop: 1,
  },
  goalText: {
    color: '#cfd2e0',
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
  },
  goalTextDone: {
    color: '#7a809a',
    textDecorationLine: 'line-through',
  },
  modalDirBox: {
    backgroundColor: '#0a0a18',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a3e',
    padding: 10,
  },
  modalDirPath: {
    color: '#cfd2e0',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 17,
  },
  modalDirHint: {
    color: '#7a809a',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'right',
  },
  modalCloseBtn: {
    borderTopWidth: 1,
    borderTopColor: '#222',
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseBtnText: {
    color: '#f7931a',
    fontSize: 15,
    fontWeight: '600',
  },

  // v3.7.8: list-card ACTIVE badge (top-right of each card).
  // Gold background tint + gold border + uppercase. The eye
  // lands on this before the rest of the card.
  activeBadge: {
    position: 'absolute',
    top: 6,
    right: 8,
    backgroundColor: 'rgba(247, 147, 26, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.5)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    zIndex: 1,
  },
  activeBadgeText: {
    color: '#f7931a',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // v3.7.8: small inline counter under the goal bar
  // showing how many journal entries exist.
  questChangesHint: {
    color: '#9aa0b4',
    fontSize: 11,
    marginTop: 4,
    fontStyle: 'italic',
  },
  // v3.7.8: detail-modal ACTIVE badge (in the status row).
  // Sits next to the Active/Completed status badge. The two
  // are independent concepts.
  modalActiveBadge: {
    backgroundColor: 'rgba(247, 147, 26, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.5)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 8,
  },
  modalActiveBadgeText: {
    color: '#f7931a',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  // v3.7.8: latest-changes timeline. Each row has a small
  // dot on the left (the timeline bullet) and the text +
  // timestamp on the right. Newest first.
  changeIntro: {
    color: '#7a809a',
    fontSize: 11,
    fontStyle: 'italic',
    marginBottom: 10,
    lineHeight: 15,
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginVertical: 4,
  },
  changeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#a855f7',
    marginTop: 6,
    marginRight: 10,
  },
  changeBody: {
    flex: 1,
  },
  changeText: {
    color: '#cfd2e0',
    fontSize: 13,
    lineHeight: 18,
  },
  changeTime: {
    color: '#7a809a',
    fontSize: 11,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
});
