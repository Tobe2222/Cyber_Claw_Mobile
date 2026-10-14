// Lifted out of CompanionSettingsScreen so Quests is its own top-level page.

import React, { useState, useEffect, useRef } from 'react';
import {
  Alert,
  BackHandler,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
// SafeAreaInsets for the editor modal's top padding.
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Setters/getter for the per-device active-quest anchor (defined in HomeScreen.tsx).
import { setMobileActiveQuestAnchor } from './HomeScreen';

type CompanionQuest = {
  id: string;
  name: string;
  description?: string;
  status?: 'active' | 'completed';
  directory?: string;
  goals?: Array<{ text: string; completed: boolean }>;
  created?: string;
  // New fields from desktop v3.1.50.
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
  // v3.10.86: SafeAreaInsets for the editor modal's top
  // padding. See the comment on the import.
  const insets = useSafeAreaInsets();
  const [quests, setQuests] = useState<CompanionQuest[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Track whether at least one fresh broadcast from the desktop has been received.
  const [firstBroadcastReceived, setFirstBroadcastReceived] = useState(false);
  // v3.7.7: tapped quest shown in the detail modal. null = closed.
  const [detail, setDetail] = useState<CompanionQuest | null>(null);
  // Editor modal.
  const [editorOpen, setEditorOpen] = useState<CompanionQuest | null>(null);
  // v3.8.0: confirm dialog state. null = hidden,
  // otherwise {title, message, onConfirm}.
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  // v3.8.0: transient error toast (e.g. quest edit failed
  // on the desktop). Cleared automatically on next render
  // or on user dismiss.
  const [error, setError] = useState<string | null>(null);
  // Refresh-button spinner state.
  const [refreshing, setRefreshing] = useState(false);
  // Ref so the quests_list handler (which lives inside a useEffect with empty deps, like the others) can read+clear the current refresh…
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the `refreshing` state for the broadcast handler.
  const refreshingRef = useRef<boolean>(false);
  // Refs so the quests_list handler (which lives inside a useEffect with empty deps) can read the current editorOpen / detail state without…
  const editorOpenRef = useRef<CompanionQuest | null>(null);
  const detailRef = useRef<CompanionQuest | null>(null);
  // Ref for "is the editor open for a new quest".
  const creatingNewRef = useRef<boolean>(false);
  useEffect(() => { editorOpenRef.current = editorOpen; }, [editorOpen]);
  useEffect(() => { detailRef.current = detail; }, [detail]);
  useEffect(() => { creatingNewRef.current = !!(editorOpen && !editorOpen.id); }, [editorOpen]);
  // Keep refreshingRef in sync so the quests_list broadcast handler can read the latest value without going stale (same trap the other refs…
  useEffect(() => { refreshingRef.current = refreshing; }, [refreshing]);

  // Android system back / gesture-nav back should pop the screen (and any open modals) instead of exiting the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (confirm) { setConfirm(null); return true; }
      if (editorOpen) {
        setEditorOpen(null);
        // If the editor was opened from the detail modal, the detail modal is already null (we close detail when opening editor).
        return true;
      }
      if (detail) { setDetail(null); return true; }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, confirm, editorOpen, detail]);

  // Hydrate from the global cache key on mount, then migrate any v3.7.4-era per-companion keys (cyberclaw-quests-<id>) into the global cache…
  useEffect(() => {
    let cancelled = false;
    // Reset the first-broadcast-received flag on every mount of this screen.
    setFirstBroadcastReceived(false);
    (async () => {
      try {
        // 1. Read new global cache (if any)
        let initial: CompanionQuest[] = [];
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) initial = parsed;
        }

        // 2.
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
      // Mark first-broadcast as received so the editor can be safely opened.
      setFirstBroadcastReceived(true);
      // If a user-initiated refresh is in flight (the refresh button is showing its spinner), this broadcast is the confirmation that the desktop…
      if (refreshTimerRef.current || refreshingRef.current) {
        if (refreshTimerRef.current) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        setRefreshing(false);
      }
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(list)).catch(() => {});
      // If the editor is open and the broadcast includes a quest with the same id, the desktop has confirmed the edit.
      const editingId = editorOpenRef.current?.id;
      // If the editor is open for a new quest (empty id), the desktop has just created it; any broadcast that lands after the create_quest call is…
      if (creatingNewRef.current) {
        setEditorOpen(null);
      } else if (editingId) {
        if (list.some((q) => q.id === editingId)) {
          setEditorOpen(null);
        } else {
          // The quest was deleted while the editor was open.
          // Close the editor and any open detail modal.
          setEditorOpen(null);
          if (detailRef.current?.id === editingId) setDetail(null);
        }
      }
    };
    syncClient.on?.('quests_list', handler);

    // Listen for failed quest edits.
    const failedHandler = (msg: any) => {
      const action = msg?.action || 'edit';
      const reason = msg?.error || 'unknown error';
      let detail = `Couldn't ${action.replace(/_/g, ' ')}: ${reason}`;
      // Rich diagnostic info from the desktop.
      if (Array.isArray(msg?.available) && msg.available.length > 0) {
        const entries = msg.available
          .slice(0, 3)
          .map((a: any) => `${a.name || '(unnamed)'} (${a.id})`)
          .join(', ');
        const more = msg.available.length > 3
          ? `, +${msg.available.length - 3} more`
          : '';
        detail += ` · wanted id "${msg.id}"${msg.wantedName ? ` for "${msg.wantedName}"` : ''}, desktop has: ${entries}${more}`;
      } else {
        detail += ` · wanted id "${msg.id}", desktop has no quests`;
      }
      setError(detail);
      // Also surface the diagnostic in the console for the dev menu / log tab.
      console.warn('[QuestsScreen] edit failed:', detail, msg);
    };
    syncClient.on?.('quests_update_failed', failedHandler);

    // Request a fresh list on mount.
    try {
      syncClient.requestQuestsList?.();
    } catch (_) {}

    return () => {
      cancelled = true;
      syncClient.off?.('quests_list', handler);
      syncClient.off?.('quests_update_failed', failedHandler);
      // v3.10.117: clean up the refresh-safety timeout so
      // it can't fire after the screen unmounts and call
      // setRefreshing on an unmounted component.
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  // Action handlers.
  const handleSetActive = (id: string | null) => {
    setError(null);
    // Optimistically anchor the local active quest before the desktop replies.
    setMobileActiveQuestAnchor(id ?? null);
    syncClient.setQuestActive?.(id);
  };
  const handleUpdateQuest = (id: string, updates: Record<string, any>) => {
    setError(null);
    syncClient.updateQuest?.(id, updates);
  };
  const handleDeleteQuest = (id: string) => {
    setError(null);
    syncClient.deleteQuest?.(id);
  };
  // Removed the card-level complete-toggle button (and its handleToggleComplete helper).
  const handleMarkGoalDone = (id: string, goalIndex: number, completed: boolean) => {
    setError(null);
    syncClient.markQuestGoalDone?.(id, goalIndex, completed);
  };
  // User-initiated refresh.
  const handleRefresh = () => {
    if (refreshing) return; // double-tap guard
    setError(null);
    setRefreshing(true);
    // User-initiated refresh means "I want to re-sync from the desktop." Reset the mobile's per-device active-quest anchor so the next…
    setMobileActiveQuestAnchor(null);
    try {
      syncClient.requestQuestsList?.();
    } catch (_) {}
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      setRefreshing(false);
      refreshTimerRef.current = null;
    }, 2000);
  };

  // Sort order is now (1) the active quest, then (2) non-completed quests, then (3) completed quests.
  const sorted = quests.slice().sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return 0;
  });
  // Split the sorted list so the active quest can be pinned ABOVE the "No active quest" card.
  const activeQuest = sorted.find((q) => q.active) || null;
  const remainingQuests = sorted.filter((q) => !q.active);

  // Extracted the per-quest card render out of the JSX so we can call it twice — once for the pinned active quest above the "No active quest"…
  const renderQuestCard = (q: CompanionQuest) => {
    const isComplete = q.status === 'completed';
    const isActive = !!q.active;
    const goals = Array.isArray(q.goals) ? q.goals : [];
    const done = goals.filter((g) => g.completed).length;
    const pct = goals.length === 0 ? 0 : Math.round((done / goals.length) * 100);
    const dirName = q.directory
      ? q.directory.split('/').filter(Boolean).pop() || q.directory
      : '';
    // Swapped active/inactive colors.
    const borderColor = isActive
      ? (isComplete ? 'rgba(168, 85, 247, 0.6)' : '#a855f7')
      : (isComplete ? '#10b981' : '#f7931a');
    const cardOpacity = isActive
      ? (isComplete ? 0.85 : 1)
      : (isComplete ? 0.55 : 1);
    // The number of recent changes goes next to the done/total as a small inline counter — subtle hint that the detail modal has more.
    const changeCount = Array.isArray(q.latestChanges) ? q.latestChanges.length : 0;
    // v3.11.44: sleek card. Tobe 2026-10-13: 'clean up quest page,
    // it just looks bad, make it prettier and more sleek'. One quiet
    // card per quest: accent stripe + ACTIVE chip instead of the big
    // banner/purple border, one-line description, folder + progress
    // in a muted meta line, compact actions on the right.
    const accent = isComplete ? '#10b981' : isActive ? '#22c55e' : 'transparent';
    return (
      <TouchableOpacity
        key={q.id}
        activeOpacity={0.8}
        style={[styles.qc, isActive && styles.qcActive, { opacity: isComplete && !isActive ? 0.6 : 1 }]}
        onPress={() => setDetail(q)}
        onLongPress={() => { if (q.directory) Clipboard.setString(q.directory); }}
      >
        <View style={[styles.qcStripe, { backgroundColor: accent }]} />
        <View style={styles.qcBody}>
          <View style={styles.qcTitleRow}>
            <Text style={styles.qcName} numberOfLines={1}>{isComplete ? '✅ ' : ''}{q.name}</Text>
            {isActive && (
              <View style={styles.qcChip}><Text style={styles.qcChipText}>ACTIVE</Text></View>
            )}
          </View>
          {!!q.description && (
            <Text style={styles.qcDesc} numberOfLines={1}>{q.description}</Text>
          )}
          <View style={styles.qcMetaRow}>
            {!!q.directory && <Text style={styles.qcMeta} numberOfLines={1}>📁 {dirName}</Text>}
            {goals.length > 0 && <Text style={styles.qcMeta}>  ·  {done}/{goals.length} steps</Text>}
            {changeCount > 0 && <Text style={styles.qcMeta}>  ·  {changeCount} change{changeCount === 1 ? '' : 's'}</Text>}
          </View>
          {goals.length > 0 && (
            <View style={styles.qcBar}>
              <View style={[styles.qcFill, { width: `${pct}%`, backgroundColor: pct >= 100 ? '#10b981' : '#f7931a' }]} />
            </View>
          )}
        </View>
        <View style={styles.qcActions}>
          <TouchableOpacity
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[styles.qcPlay, isActive && styles.qcPlayActive, !firstBroadcastReceived && styles.cardActionBtnDisabled]}
            onPress={(e) => {
              e?.stopPropagation?.();
              if (!firstBroadcastReceived) return;
              handleSetActive(isActive ? null : q.id);
            }}
            accessibilityLabel={isActive ? 'Deactivate quest' : 'Set quest active'}
          >
            <Text style={[styles.qcPlayText, isActive && styles.qcPlayTextActive]}>{isActive ? '■' : '▶'}</Text>
          </TouchableOpacity>
          <View style={styles.qcIconRow}>
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              onPress={(e) => { e?.stopPropagation?.(); if (!firstBroadcastReceived) return; setEditorOpen({ ...q }); }}
            >
              <Text style={styles.qcIcon}>✎</Text>
            </TouchableOpacity>
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              onPress={(e) => {
                e?.stopPropagation?.();
                if (!firstBroadcastReceived) return;
                setConfirm({
                  title: 'Delete quest?',
                  message: `"${q.name}" will be removed from the desktop too. This can't be undone.`,
                  onConfirm: () => { setConfirm(null); handleDeleteQuest(q.id); },
                });
              }}
            >
              <Text style={[styles.qcIcon, styles.qcIconDelete]}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

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
          {/* v3.10.117: right-side action cluster. Holds
              + New (v3.8.1) and ↻ Refresh (v3.10.117)
              side by side. Both are subtle orange outlines
              so they don't shout, but they sit close
              enough together that the user reads them as a
              single "actions" group on the right edge of
              the header. The cluster keeps the outer
              detailHeaderRow's `justifyContent:
              space-between` working (it's a single child
              of the row, balancing against Back + title). */}
          <View style={styles.headerActionsCluster}>
            {/* v3.8.1: + New Quest button. Opens the editor
                modal in "new" mode (empty fields). Tapping
                Save sends create_quest to the desktop; the
                next broadcast replaces the state and the
                editor auto-closes. Replaces the 60pt spacer
                that was here before (the spacer kept the
                header text centered; now the + takes that
                space). */}
            <TouchableOpacity
              onPress={() => setEditorOpen({ id: '', name: '', description: '', status: 'active', goals: [] } as CompanionQuest)}
              style={styles.newQuestBtn}
            >
              <Text style={styles.newQuestBtnText}>+  New</Text>
            </TouchableOpacity>
            {/* v3.10.117: ↻ Refresh button. User-initiated
                re-request from the desktop. Tobe's request
                (2026-07-31): the chat pipeline can confirm
                a quest creation before the quests_list
                broadcast lands on the mobile, so the quest
                page shows nothing. Tapping refresh forces
                another request_quests_list WebSocket
                message; the next broadcast replaces the
                list. While in flight, the label switches
                to "⏳ …" so the user knows something's
                happening. Same syncClient.requestQuestsList
                call as the mount-time useEffect. */}
            <TouchableOpacity
              onPress={handleRefresh}
              style={styles.refreshBtn}
              disabled={refreshing}
            >
              <Text style={[styles.refreshBtnText, refreshing && styles.refreshBtnTextActive]}>
                {refreshing ? '⏳ …' : '↻ Refresh'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* v3.10.190: status row under the header. Acts as
            the page's "deactivate current quest" affordance.
            - When a quest is active: a GREEN BUTTON labeled
              "✓ {quest name}  ✕" that, when tapped, sends
              set_quest_active(null) to the desktop. Replaces
              the v3.10.189 green pill (which was just an info
              chip — you had to scroll to find the dashed card
              to deactivate). Now you can deactivate from the
              top of the page in one tap. Tobe 2026-09-07:
              "I dont need a pill for the active quest. I need
              a button to deactivate current in the top, the
              'pill'." The ✕ icon at the right edge of the
              button makes the action obvious; tapping anywhere
              on the button deactivates.
            - When no quest is active: the red "● No active
              quest" pill from v3.10.189 (kept — Tobe asked
              for this and it's the right way to show the
              default state). Static, non-tappable. */}
        <View style={styles.headerStatusRow}>
          {activeQuest ? (
            <TouchableOpacity
              onPress={() => handleSetActive(null)}
              style={[styles.headerStatusPill, styles.headerStatusPillActive]}
              accessibilityLabel={`Deactivate quest ${activeQuest.name}`}
            >
              <Text style={styles.headerStatusPillActiveText} numberOfLines={1}>
                ✓  {activeQuest.name}
              </Text>
              <Text style={styles.headerStatusPillDeactivateIcon}>✕</Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.headerStatusPill, styles.headerStatusPillNoActive]}>
              <Text style={styles.headerStatusPillNoActiveText}>
                ●  Casual chat
              </Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          {/* v3.10.189: removed the redundant "Quests"
              section title — the page header already
              says 📜 Quests. Cuts a chunk of vertical
              space before the first card. */}
          <Text style={styles.sectionDesc}>
            ▶ starts a quest · tap for details · long-press copies the path
          </Text>

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
            <React.Fragment>
              {/* v3.10.73: if the first desktop broadcast hasn't
                  arrived yet (cache-only render), show a small
                  hint explaining why edit buttons are dimmed.
                  Stops users from tapping ✏️ into an editor with
                  a stale id that the desktop doesn't recognize. */}
              {!firstBroadcastReceived && (
                <Text style={styles.syncingHint}>
                  ⏳ Syncing with desktop… (edit buttons will unlock when sync completes)
                </Text>
              )}
            {/* v3.10.190: removed the dashed "No active quest"
                card from the middle of the list. Tobe
                (2026-09-07, follow-up to the red pill request):
                "remove the superflous no active quest in the
                middle of everything there." The deactivate
                action lives in the green button at the top of
                the page now (tap → set_quest_active(null)),
                so the dashed card was redundant — two ways to
                do the same thing in different parts of the
                screen.

                List order now: [active quest pinned at top]
                → [all other quests]. No middle card. Cleaner
                visual hierarchy. The red "● No active quest"
                pill in the header (when nothing is active)
                still tells the user the default state. */}
            {activeQuest && renderQuestCard(activeQuest)}
            {remainingQuests.map((q) => renderQuestCard(q))}
            </React.Fragment>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About quests on mobile</Text>
          <Text style={styles.sectionDesc}>
            • Quests are owned by the desktop and synced via WebSocket on every change.{'\n'}
            • Phone edits (name, description, status, set active, delete, mark goal done) round-trip to the desktop in real-time.{'\n'}
            • Project paths are NOT stored on the phone — {`quest.directory`} is read from the desktop as the project's real path and shown for reference only.{'\n'}
            • Long-press a card to copy the project path to clipboard.
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
            {detail && (
              <QuestDetailBody
                quest={detail}
                onEdit={() => {
                  // Open the editor with a copy of the current quest.
                  setEditorOpen({ ...detail });
                  setDetail(null);
                }}
                onMarkGoalDone={(idx, done) => {
                  if (detail) handleMarkGoalDone(detail.id, idx, done);
                }}
              />
            )}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalCloseBtn, { flex: 1 }]}
                onPress={() => setDetail(null)}
              >
                <Text style={styles.modalCloseBtnText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCloseBtn, styles.modalEditBtn]}
                onPress={() => {
                  if (detail) {
                    setEditorOpen({ ...detail });
                    setDetail(null);
                  }
                }}
              >
                <Text style={styles.modalCloseBtnText}>✏️  Edit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* v3.8.0: quest editor modal. Opens when the user
          taps the ✏️ on a list card or the Edit button in
          the detail modal. The form fields are bound to a
          local copy of the quest so the user can edit
          freely. On Save we send `update_quest` to the
          desktop; the broadcast replaces the canonical
          state and the handler above closes the editor. */}
      <Modal
        visible={!!editorOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setEditorOpen(null)}
      >
        <View style={styles.modalScrim}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setEditorOpen(null)}
          />
          {editorOpen && (
            <QuestEditorBody
              quest={editorOpen}
              isNew={!editorOpen.id}
              insets={insets}
              onClose={() => setEditorOpen(null)}
              onSave={async (updates) => {
                // If we opened the editor for a new quest (empty id), call createQuest instead of updateQuest.
                if (!editorOpen.id) {
                  // Forward the user's defaultQuestDir from cyberclaw-mobile- settings so the desktop can pick the same default location the mobile suggests…
                  let defaultQuestDir: string | undefined;
                  try {
                    const raw = await AsyncStorage.getItem('cyberclaw-mobile-settings');
                    if (raw) {
                      const s = JSON.parse(raw);
                      if (typeof s?.defaultQuestDir === 'string' && s.defaultQuestDir.trim()) {
                        defaultQuestDir = s.defaultQuestDir.trim();
                      }
                    }
                  } catch (_) {}
                  syncClient.createQuest?.({
                    name: updates.name,
                    description: updates.description,
                    goals: Array.isArray(updates.goals) ? updates.goals : [],
                    directory: typeof updates.directory === 'string' && updates.directory.trim()
                      ? updates.directory.trim()
                      : undefined,
                    defaultQuestDir,
                  });
                } else {
                  handleUpdateQuest(editorOpen.id, updates);
                }
                // Don't close the editor here — let the
                // broadcast handler close it once the
                // desktop confirms. (See useEffect above.)
              }}
              onDelete={() => {
                if (!editorOpen.id) {
                  // New quest not yet saved — just close the
                  // editor.
                  setEditorOpen(null);
                  return;
                }
                const id = editorOpen.id;
                setEditorOpen(null);
                setConfirm({
                  title: 'Delete quest?',
                  message: `"${editorOpen.name}" will be removed from the desktop too. This can't be undone.`,
                  onConfirm: () => {
                    setConfirm(null);
                    handleDeleteQuest(id);
                  },
                });
              }}
            />
          )}
        </View>
      </Modal>

      {/* v3.8.0: confirm dialog (delete). Tiny modal with
          title + message + Cancel/Delete buttons. */}
      <Modal
        visible={!!confirm}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirm(null)}
      >
        <View style={styles.modalScrim}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setConfirm(null)}
          />
          <View style={styles.confirmCard}>
            {confirm && (
              <>
                <Text style={styles.confirmTitle}>{confirm.title}</Text>
                <Text style={styles.confirmMessage}>{confirm.message}</Text>
                <View style={styles.confirmActions}>
                  <TouchableOpacity
                    style={styles.confirmBtn}
                    onPress={() => setConfirm(null)}
                  >
                    <Text style={styles.confirmBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmBtn, styles.confirmBtnDanger]}
                    onPress={confirm.onConfirm}
                  >
                    <Text style={[styles.confirmBtnText, styles.confirmBtnTextDanger]}>
                      Delete
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* v3.8.0: error toast. Bottom of screen, shows
          quests_update_failed messages from the desktop.
          Auto-dismisses on the next success; user can
          also tap × to dismiss manually. */}
      {!!error && (
        <View style={styles.errorToast}>
          <Text style={styles.errorToastText} numberOfLines={2}>{error}</Text>
          <TouchableOpacity
            onPress={() => setError(null)}
            style={styles.errorToastClose}
          >
            <Text style={styles.errorToastCloseText}>×</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// Quest editor body.
function QuestEditorBody({
  quest,
  isNew,
  onClose,
  onSave,
  onDelete,
  insets,
}: {
  quest: CompanionQuest;
  // When true, the editor is in "new quest" mode.
  isNew?: boolean;
  onClose: () => void;
  onSave: (updates: Record<string, any>) => void;
  onDelete: () => void;
  // v3.10.86: SafeAreaInsets passed from the parent so the
  // editor header can start below the status bar on
  // Android edge-to-edge.
  insets?: { top: number; bottom: number; left: number; right: number };
}) {
  // Quest project instructions (markdown).
  const [questInstructionsContent, setQuestInstructionsContent] = useState<string>('');
  const [questInstructionsPath, setQuestInstructionsPath] = useState<string | null>(null);
  const [questInstructionsLoading, setQuestInstructionsLoading] = useState<boolean>(true);
  // Track whether the user edited the instructions textarea, so we can decide whether to send a save when they hit the editor's Save button.
  const [questInstructionsDirty, setQuestInstructionsDirty] = useState<boolean>(false);
  useEffect(() => {
    if (isNew || !quest.id) {
      // New quest doesn't have an instructions file yet
      // (the quest id doesn't exist until after Save).
      setQuestInstructionsContent('');
      setQuestInstructionsPath(null);
      setQuestInstructionsLoading(false);
      return;
    }
    setQuestInstructionsLoading(true);
    setQuestInstructionsDirty(false);
    let cancelled = false;
    const onInstructions = (msg: any) => {
      if (msg.questId !== quest.id) return;
      if (cancelled) return;
      if (msg.ok) {
        setQuestInstructionsContent(msg.content || '');
        setQuestInstructionsPath(msg.path || null);
      } else {
        setQuestInstructionsContent('');
        setQuestInstructionsPath(null);
      }
      setQuestInstructionsLoading(false);
    };
    syncClient.on('quest_instructions', onInstructions);
    syncClient.requestQuestInstructions(quest.id);
    return () => {
      cancelled = true;
      syncClient.off?.('quest_instructions', onInstructions);
    };
  }, [quest.id, isNew]);
  // Local form state. Initialized from the quest prop.
  // The form is uncontrolled-ish (we just track values);
  // Save bundles them into an updates object.
  const [name, setName] = useState(quest.name || '');
  const [description, setDescription] = useState(quest.description || '');
  // Status is no longer editor-editable.
  const [directory, setDirectory] = useState<string>(() => {
    if (!isNew) return quest.directory || '';
    // For new quests, start blank.
    if (!isNew) {
      return quest.directory || '';
    }
    return '';
  });
  const [directorySuggestion, setDirectorySuggestion] = useState<string>('');
  useEffect(() => {
    // Compute the suggested directory path when the editor opens.
    let cancelled = false;
    (async () => {
      try {
        const settingsRaw = await AsyncStorage.getItem('cyberclaw-mobile-settings');
        if (cancelled) return;
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        const base = (settings?.defaultQuestDir || '').trim();
        const safeName = (quest.name || name || 'unnamed-quest')
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        setDirectorySuggestion(base ? `${base.replace(/\/+$/, '')}/${safeName}` : '');
      } catch {
        // settings parse failed or AsyncStorage unavailable;
        // leave suggestion empty so the UI just hides the
        // suggestion row.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew]);
  // Goal list is now editable in the editor.
  const [goals, setGoals] = useState<Array<{ text: string; completed: boolean }>>(() => {
    if (!Array.isArray(quest.goals)) return [];
    return quest.goals.map((g) =>
      typeof g === 'string'
        ? { text: g, completed: false }
        : { text: g.text || '', completed: !!g.completed },
    );
  });

  return (
    // PaddingTop includes the safe-area inset so the editor header starts below the status bar on Android (edge-to-edge mode).
    <View style={[styles.editorCard, { paddingTop: insets.top + 8 }]}>
      <View style={styles.editorHeader}>
        <Text style={styles.editorTitle}>{isNew ? '➕  New quest' : '✏️  Edit quest'}</Text>
        <TouchableOpacity onPress={onClose} style={styles.editorCloseBtn}>
          <Text style={styles.editorCloseBtnText}>×</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.editorBody} contentContainerStyle={styles.editorBodyContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.editorFieldLabel}>Name</Text>
        <TextInput
          style={styles.editorInput}
          value={name}
          onChangeText={setName}
          placeholder="Quest name"
          placeholderTextColor="#666"
        />
        <Text style={styles.editorFieldLabel}>Description</Text>
        <TextInput
          style={[styles.editorInput, styles.editorInputMulti]}
          value={description}
          onChangeText={setDescription}
          placeholder="What this quest is about"
          placeholderTextColor="#666"
          multiline
          numberOfLines={3}
        />
        {/* v3.10.134: removed the Status (Active/Completed)
            row from the editor. Tobe: 'We dont need to have
            that status active or complete there, we can just
            add a complete sign in the quest overview right
            beside the delete Instead.' The status is now
            toggled from a 🏁 button on the quest card. The
            active marker (☆) is unchanged — still set from
            the same card button. */}
        {/* v3.10.134: project directory field for NEW
            quests. Pre-fill suggestion based on the
            Settings.defaultQuestDir + sanitized quest name.
            For existing quests we still show the current
            directory (read-only) so the user can see where
            the desktop is looking, but we don't let it be
            edited in the editor — changing a quest's
            directory mid-flight is a heavy operation (the
            desktop would need to move QUEST_INSTRUCTIONS.md
            + the conversation-log hint) and is out of scope
            here. Users wanting to move a directory should
            delete + recreate. */}
        {/* v3.10.136: project directory is always
            visible + editable, both for new AND
            existing quests. Tobe 2026-08-04 17:31:
            'Tried to edit a quest, its directory is
            not shown and should be editable. Here we
            potentially need to move and/or create new
            directories for the user.'
            The desktop's `quests:update` (v3.2.62)
            detects a directory change and re-scaffolds
            the new dir (mkdir + write INSTRUCTIONS.md
            placeholder + CONVERSATION.md placeholder).
            We do NOT migrate the old files — moving
            the directory is the right user signal that
            the quest is now about a different folder.

            For new quests the directory field starts
            blank and the suggestion auto-fills via the
            "← Use" button (re-using the v3.10.134 logic).
            For existing quests we pre-fill with the
            current directory (so editing shows the
            current value), and the "← Use" button
            suggests a NEW directory based on the
            Settings.defaultQuestDir + quest.name (if
            different from the current value). The
            Auto-set to Project default button does the
            same as the editor's existing "← Use". */}

        <Text style={styles.editorFieldLabel}>📁 Project directory</Text>
        <TextInput
          style={styles.editorInput}
          value={directory}
          onChangeText={setDirectory}
          placeholder="(optional) path on this device or remote host"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {directorySuggestion && directorySuggestion !== directory && (
          <View style={styles.editorDirectorySuggestion}>
            <View style={styles.editorDirectorySuggestionTextWrap}>
              <Text style={styles.editorDirectorySuggestionText}>
                💡 Suggested:{' '}
                {/* v3.10.153: tap the path to copy it (the "← Use" button
                    still sets the field; this is for the "I want to grab
                    the path and put it somewhere else" case). */}
                <Text
                  style={styles.editorDirectorySuggestionPath}
                  onPress={() => {
                    Clipboard.setString(directorySuggestion);
                    Alert.alert('Copied', directorySuggestion);
                  }}
                  suppressHighlighting={false}
                >
                  {directorySuggestion}
                </Text>
              </Text>
            </View>
            <TouchableOpacity
              style={styles.editorDirectorySuggestionBtn}
              onPress={() => setDirectory(directorySuggestion)}
            >
              <Text style={styles.editorDirectorySuggestionBtnText}>← Use</Text>
            </TouchableOpacity>
          </View>
        )}
        <Text style={styles.editorDirectoryHelpText}>
          {isNew
            ? 'Optional. Set a default in Settings → Quest directory, or leave blank to add later via the desktop.'
            : 'Edit to move the quest to a different directory. Desktop will mkdir + scaffold INSTRUCTIONS.md + CONVERSATION.md in the new location.'}
        </Text>
        {/* v3.10.74: removed the "Active" toggle (the
            double-active bug Tobe reported). The "this
            is THE active quest" flag is now set
            exclusively via the ☆ button on the card
            list, not from inside the editor. Keeping a
            redundant toggle inside the editor caused
            confusion: V2 in the screenshot had status
            "active" highlighted AND HIVE_CONTROL had
            the ACTIVE badge — they meant different
            things but looked the same. */}
        {/* v3.10.134: the read-only directory hint for
            EXISTING quests now lives in the same JSX
            block as the editable input for NEW quests
            (above this comment) so the two paths don't
            drift. */}

        {/* v3.10.74: goal list editor. One TextInput per
            step, plus remove + add buttons. The mobile
            previously only let the user mark goals done
            (via the detail modal tap-to-toggle) but
            couldn't add/edit/delete step text. Tobe
            reported the missing-steps bug 2026-07-22. */}
        <View style={styles.editorGoalsHeader}>
          <Text style={styles.editorFieldLabel}>Steps ({goals.length})</Text>
          <TouchableOpacity
            style={styles.editorGoalAddBtn}
            onPress={() => setGoals((g) => [...g, { text: '', completed: false }])}
          >
            <Text style={styles.editorGoalAddBtnText}>+ Add step</Text>
          </TouchableOpacity>
        </View>
        {goals.length === 0 && (
          <Text style={styles.editorGoalsEmpty}>
            No steps yet. Tap "+ Add step" to create the first one.
          </Text>
        )}
        {goals.map((g, i) => (
          <View key={i} style={styles.editorGoalRow}>
            <TouchableOpacity
              style={[
                styles.editorGoalCheck,
                g.completed && styles.editorGoalCheckCompleted,
              ]}
              onPress={() => setGoals((gs) =>
                gs.map((gg, j) => (j === i ? { ...gg, completed: !gg.completed } : gg)),
              )}
            >
              <Text style={styles.editorGoalCheckText}>
                {g.completed ? '☑' : '☐'}
              </Text>
            </TouchableOpacity>
            <TextInput
              style={[
                styles.editorGoalInput,
                g.completed && styles.editorGoalInputCompleted,
              ]}
              value={g.text}
              onChangeText={(text) => setGoals((gs) =>
                gs.map((gg, j) => (j === i ? { ...gg, text } : gg)),
              )}
              placeholder="Step description"
              placeholderTextColor="#666"
            />
            <TouchableOpacity
              style={styles.editorGoalRemoveBtn}
              onPress={() => setGoals((gs) => gs.filter((_, j) => j !== i))}
            >
              <Text style={styles.editorGoalRemoveBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}

        {/* v3.10.102: per-quest project instructions
            field. Mirrors the desktop's quest editor
            (v3.2.32). The textarea is monospace + dark
            so it looks like a code/file editor. The
            file path is shown below so the user can
            verify it lives in the expected directory.
            Hydration is async (we wait for the
            quest_instructions ack on mount). For NEW
            quests (isNew=true), the file doesn't exist
            yet — the section is hidden until after
            Save + a subsequent open. */}
        {!isNew && (
          <View style={styles.editorInstructionsBlock}>
            <Text style={styles.editorFieldLabel}>📋 Quest instructions</Text>
            <Text style={styles.editorInstructionsHint}>
              Per-quest project instructions for the companion. Injected into the chat prompt as a separate context block when this quest is active. Use this for "how to do tasks" (e.g. "deploy via scp to the VPS", "edit files directly on the server").
            </Text>
            {questInstructionsLoading ? (
              <Text style={styles.editorInstructionsLoading}>Loading instructions file…</Text>
            ) : (
              <>
                <TextInput
                  style={styles.editorInstructionsTextarea}
                  value={questInstructionsContent}
                  onChangeText={(text) => {
                    setQuestInstructionsContent(text);
                    setQuestInstructionsDirty(true);
                  }}
                  placeholder="# Project instructions for this quest&#10;&#10;## Deploy&#10;- scp dist/* user@vps:/var/www/&#10;- ssh user@vps 'systemctl restart nginx'"
                  placeholderTextColor="#666"
                  multiline
                  numberOfLines={8}
                  textAlignVertical="top"
                />
                {!!questInstructionsPath && (
                  <Text style={styles.editorInstructionsPath} selectable>
                    {questInstructionsPath}
                  </Text>
                )}
                {questInstructionsDirty && (
                  <Text style={styles.editorInstructionsDirtyHint}>
                    ✎ Edited — will save on Save
                  </Text>
                )}
              </>
            )}
          </View>
        )}
      </ScrollView>
      <View style={styles.editorFooter}>
        {!isNew && (
          <TouchableOpacity
            style={[styles.editorFooterBtn, styles.editorFooterBtnDanger]}
            onPress={onDelete}
          >
            <Text style={styles.editorFooterBtnTextDanger}>Delete</Text>
          </TouchableOpacity>
        )}
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          style={styles.editorFooterBtn}
          onPress={onClose}
        >
          <Text style={styles.editorFooterBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.editorFooterBtn, styles.editorFooterBtnPrimary]}
          onPress={() => {
            // Goals are now editable.
            const cleanedGoals = goals
              .map((g) => ({ text: g.text.trim(), completed: g.completed }))
              .filter((g) => g.text.length > 0);
            // Status is no longer editor-editable, so we don't include it in `updates` here.
            const updates: Record<string, any> = {
              name: name.trim() || quest.name,
              description: description.trim(),
              goals: cleanedGoals,
            };
            const trimmedDir = directory.trim();
            updates.directory = trimmedDir || undefined;
            // Note: updates.directory is now always present in the payload (new + existing).
            onSave(updates);
            // If the user edited the instructions textarea, send the file to the desktop as part of the same Save.
            if (!isNew && quest.id && questInstructionsDirty) {
              // The parent's onClose happens in QuestsScreen after the ack.
              const onSaved = (msg: any) => {
                if (msg.questId !== quest.id) return;
                syncClient.off?.('quest_instructions_saved', onSaved);
                if (msg.ok) {
                  setQuestInstructionsDirty(false);
                } else {
                  Alert.alert(
                    'Save failed',
                    `Could not save instructions: ${msg.error || 'unknown error'}`,
                  );
                }
              };
              syncClient.on('quest_instructions_saved', onSaved);
              syncClient.saveQuestInstructions(quest.id, questInstructionsContent);
            }
          }}
        >
          <Text style={styles.editorFooterBtnTextPrimary}>Save</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Detail-modal body.
function QuestDetailBody({
  quest,
  onEdit,
  onMarkGoalDone,
}: {
  quest: CompanionQuest;
  onEdit?: () => void;
  onMarkGoalDone?: (goalIndex: number, done: boolean) => void;
}) {
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

  // Per-quest instructions.
  const [questInstructionsContent, setQuestInstructionsContent] = useState<string | null>(null);
  const [questInstructionsPath, setQuestInstructionsPath] = useState<string | null>(null);
  const [questInstructionsLoading, setQuestInstructionsLoading] = useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    setQuestInstructionsContent(null);
    setQuestInstructionsPath(null);
    setQuestInstructionsLoading(true);
    const onQuestInstructions = (msg: any) => {
      if (msg.questId !== quest.id) return;
      if (cancelled) return;
      if (msg.ok) {
        setQuestInstructionsContent(msg.content || '');
        setQuestInstructionsPath(msg.path || null);
      } else {
        setQuestInstructionsContent('');
        setQuestInstructionsPath(null);
      }
      setQuestInstructionsLoading(false);
    };
    syncClient.on('quest_instructions', onQuestInstructions);
    syncClient.requestQuestInstructions(quest.id);
    return () => {
      cancelled = true;
      syncClient.off?.('quest_instructions', onQuestInstructions);
    };
  }, [quest.id]);

  return (
    <ScrollView style={styles.modalBody} contentContainerStyle={styles.modalBodyContent}>
      <Text style={styles.modalTitle}>
        {isComplete ? '✅' : '⚔️'}  {quest.name}
      </Text>

      <View style={styles.modalStatusRow}>
        {isActive && (
          // Separate ACTIVE badge so the detail modal makes it clear which quest is the working one.
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

      {/* v3.10.136: per-quest directory surfaced in the
          detail modal so the user can see WHERE the
          project files live without opening the editor.
          Tobe 2026-08-04 17:31: "And in the inspect or
          Click on the quest the directory should be
          shown there too." Tapping the row opens the
          editor (where the directory is now editable
          — see the v3.10.136 changes in
          QuestEditorBody above), so the path is also
          a shortcut to "Move to a different project
          folder". For quests without a directory, the
          row says "(no directory)" and the tap still
          drops into the editor so the user can add
          one. */}


      {/* v3.10.101: per-quest instructions. Shown
          read-only on the mobile. The desktop's quest
          editor is the source of truth for edits; the
          mobile fetches the file content from the desktop
          via request_quest_instructions when the detail
          modal opens. Tobe's v3.10.98 feedback:
          "I think we should add or make visible in
          the quests, the dedicated md files for each
          quest. Where we input quest/project specific
          behaviour for the companion." */}
      <View style={styles.modalSection}>
        <Text style={styles.modalSectionTitle}>
          📋 Quest instructions
        </Text>
        {questInstructionsLoading ? (
          <Text style={styles.modalSectionBody}>
            Loading quest instructions…
          </Text>
        ) : (questInstructionsContent && questInstructionsContent.length > 0) ? (
          <>
            {!!questInstructionsPath && (
              <Text style={styles.modalQuestInstructionsPath} selectable>
                {questInstructionsPath}
              </Text>
            )}
            <View style={styles.modalQuestInstructionsBox}>
              <Text style={styles.modalQuestInstructionsText}>
                {questInstructionsContent}
              </Text>
            </View>
            <Text style={styles.modalQuestInstructionsHint}>
              Read-only on mobile. Edit on the desktop's Quests panel.
            </Text>
          </>
        ) : (
          <Text style={styles.modalSectionBody}>
            No quest instructions yet. Add one on the desktop's Quests panel (tap the quest's "📋 Instructions" button).
          </Text>
        )}
      </View>

      {goals.length > 0 && (
        <View style={styles.modalSection}>
          <Text style={styles.modalSectionTitle}>
            Steps / goals ({done}/{goals.length})
          </Text>
          {goals.map((g, i) => (
            // Tap a goal to toggle its completed flag.
            <TouchableOpacity
              key={i}
              style={styles.goalRow}
              onPress={() => onMarkGoalDone?.(i, !g.completed)}
              activeOpacity={0.6}
            >
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
            </TouchableOpacity>
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
            onPress={() => {
              Clipboard.setString(quest.directory!);
              // Surface the copy result so the user knows it worked.
              Alert.alert('Copied', quest.directory);
            }}
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
        // Latest changes timeline.
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

// Format a date as a relative time-ago string.
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
  // v3.11.44: sleek quest cards
  qc: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: '#11131c', borderRadius: 12, borderWidth: 1, borderColor: '#23263a', marginBottom: 8, overflow: 'hidden' },
  qcActive: { backgroundColor: '#0f1d16', borderColor: 'rgba(34,197,94,0.45)' },
  qcStripe: { width: 4 },
  qcBody: { flex: 1, paddingVertical: 11, paddingLeft: 12, paddingRight: 6 },
  qcTitleRow: { flexDirection: 'row', alignItems: 'center' },
  qcName: { color: '#f1f2f6', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  qcChip: { marginLeft: 8, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(34,197,94,0.16)' },
  qcChipText: { color: '#4ade80', fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  qcDesc: { color: '#9aa0b4', fontSize: 13, marginTop: 3 },
  qcMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5, flexWrap: 'nowrap' },
  qcMeta: { color: '#6b7088', fontSize: 11.5 },
  qcBar: { height: 3, backgroundColor: '#23263a', borderRadius: 2, marginTop: 7, overflow: 'hidden' },
  qcFill: { height: 3, borderRadius: 2 },
  qcActions: { width: 64, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderLeftWidth: 1, borderLeftColor: '#1c1f2e' },
  qcPlay: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: '#f7931a', alignItems: 'center', justifyContent: 'center' },
  qcPlayActive: { borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.15)' },
  qcPlayText: { color: '#f7931a', fontSize: 13, marginLeft: 2 },
  qcPlayTextActive: { color: '#4ade80', marginLeft: 0 },
  qcIconRow: { flexDirection: 'row', marginTop: 8, gap: 14 },
  qcIcon: { color: '#6b7088', fontSize: 15 },
  qcIconDelete: { color: '#a15a5a' },
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  // PaddingTop: 50 matches the v3.4.5 pattern from CompanionSettingsScreen / SettingsScreen.
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
  // v3.8.1: + New Quest button in the header row.
  // Subtle orange outline so it doesn't shout but is
  // still discoverable next to the page title.
  newQuestBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.55)',
    backgroundColor: 'rgba(247, 147, 26, 0.08)',
  },
  // Right-side action cluster.
  headerActionsCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // ↻ Refresh button.
  refreshBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.35)',
    backgroundColor: 'rgba(247, 147, 26, 0.05)',
  },
  // v3.10.117: refresh button text. Same color as + New
  // for sibling visual consistency.
  refreshBtnText: {
    color: '#f7931a',
    fontSize: 14,
  },
  // Refresh button text while a refresh is in flight.
  refreshBtnTextActive: {
    opacity: 0.7,
  },
  newQuestBtnText: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '700',
  },
  detailHeader: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  // Pill row directly below the header.
  headerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  // Shared pill base.
  headerStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: '92%',
    gap: 8,
  },
  // Green active-state pill.
  headerStatusPillActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: 'rgba(16, 185, 129, 0.55)',
  },
  headerStatusPillActiveText: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    flexShrink: 1,
  },
  // v3.10.190: ✕ icon at the right edge of the green
  // button. Slightly faded green so it reads as
  // "close/remove" without dominating the quest name.
  headerStatusPillDeactivateIcon: {
    color: 'rgba(16, 185, 129, 0.75)',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 2,
  },
  // Red "no active quest" pill.
  headerStatusPillNoActive: {
    backgroundColor: 'rgba(170, 68, 85, 0.16)',
    borderColor: 'rgba(170, 68, 85, 0.7)',
  },
  headerStatusPillNoActiveText: {
    color: '#f87171',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  // Tighter description.
  sectionDesc: { color: '#888', fontSize: 12, marginBottom: 8, lineHeight: 16 },
  hint: { color: '#aaa', fontSize: 12, fontStyle: 'italic', marginBottom: 12 },
  questCard: {
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginVertical: 5,
  },
  // Removed `noQuestCard`, `noQuestCardActive`, `noQuestCardDesc`, `noQuestCardHint` — the dashed "No active quest" card in the middle of the…
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
  // Inline step list on the card.
  questSteps: { marginTop: 4, marginBottom: 4 },
  questStepText: {
    color: '#cfd2e0',
    fontSize: 12,
    lineHeight: 17,
  },
  questStepCompleted: {
    color: '#666',
    textDecorationLine: 'line-through',
  },
  questStepMore: {
    color: '#7a809a',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 2,
  },
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

  // Detail-modal styles.
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
  // Per-quest instructions display.
  modalQuestInstructionsPath: {
    color: '#666',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 6,
  },
  modalQuestInstructionsBox: {
    backgroundColor: '#0a0a0a',
    borderColor: '#2a2a3f',
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    maxHeight: 200,
  },
  modalQuestInstructionsText: {
    color: '#cfd2e0',
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalQuestInstructionsHint: {
    color: '#666',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 6,
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
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#15151a',
  },
  modalCloseBtnText: {
    color: '#f7931a',
    fontSize: 15,
    fontWeight: '600',
  },

  // List-card ACTIVE banner (inline, top of card).
  activeBanner: {
    backgroundColor: 'rgba(247, 147, 26, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.55)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 8,
  },
  activeBannerText: {
    color: '#f7931a',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
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

  // v3.8.0: card action row. Three quick actions per
  // card: ⭐ set active, ✏️ edit, ✕ delete. The row sits
  // at the bottom of the card with a thin top border.
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    gap: 6,
  },
  cardActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  // Prominent "Set as active" button.
  cardSetActiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: '#f7931a',
    backgroundColor: 'rgba(247, 147, 26, 0.15)',
    gap: 6,
  },
  cardSetActiveBtnIcon: {
    fontSize: 14,
    color: '#f7931a',
    fontWeight: '700',
  },
  cardSetActiveBtnText: {
    fontSize: 13,
    color: '#f7931a',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  // Active-state visual for the set-active button.
  cardSetActiveBtnActive: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
  },
  cardSetActiveBtnTextActive: {
    color: '#10b981',
  },
  // Stale-id guard.
  cardActionBtnDisabled: {
    opacity: 0.35,
  },
  // Small hint shown above the card list when no broadcast has been received from the desktop yet.
  syncingHint: {
    color: '#888',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  cardActionText: {
    fontSize: 16,
    color: '#aaa',
  },
  cardActionTextActive: {
    color: '#f7931a',
  },
  cardActionTextDelete: {
    color: '#a55',
  },

  // Detail-modal footer (Close + Edit).
  modalFooter: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 8,
  },
  modalEditBtn: {
    flex: 1,
  },

  // v3.8.0: confirm dialog. Compact card with title,
  // message, and two buttons.
  confirmCard: {
    backgroundColor: '#0f1626',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#a55',
    padding: 18,
    width: '100%',
    maxWidth: 360,
  },
  confirmTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  confirmMessage: {
    color: '#cfd2e0',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  confirmBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
  },
  confirmBtnDanger: {
    backgroundColor: '#a55',
    borderColor: '#a55',
  },
  confirmBtnText: {
    color: '#cfd2e0',
    fontSize: 13,
    fontWeight: '600',
  },
  confirmBtnTextDanger: {
    color: '#fff',
  },

  // v3.8.0: error toast. Fixed at the bottom of the
  // screen, dismissable with ×.
  errorToast: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: '#3a0e0e',
    borderColor: '#a55',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 100,
  },
  errorToastText: {
    color: '#fbb',
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  errorToastClose: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  errorToastCloseText: {
    color: '#fbb',
    fontSize: 20,
    fontWeight: '700',
  },

  // Editor modal.
  editorCard: {
    backgroundColor: '#0f1626',
    borderWidth: 1,
    borderColor: '#2a2a3e',
    width: '100%',
    height: '100%',
    paddingTop: 8, // small breathing room above the header
    overflow: 'hidden',
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
  },
  editorTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  editorCloseBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  editorCloseBtnText: {
    color: '#aaa',
    fontSize: 22,
    fontWeight: '700',
  },
  editorBody: {
    flexGrow: 0,
  },
  editorBodyContent: {
    padding: 16,
  },
  editorFieldLabel: {
    color: '#f7931a',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
    marginTop: 8,
  },
  editorInput: {
    backgroundColor: '#0a0a18',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a3e',
    color: '#fff',
    fontSize: 14,
    padding: 10,
  },
  editorInputMulti: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  editorStatusRow: {
    flexDirection: 'row',
    gap: 8,
  },
  editorStatusChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  editorStatusChipActive: {
    backgroundColor: '#1a1a2e',
    borderColor: '#f7931a',
  },
  editorStatusChipText: {
    color: '#cfd2e0',
    fontSize: 13,
  },
  editorActiveToggle: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#0a0a18',
  },
  editorActiveToggleText: {
    color: '#cfd2e0',
    fontSize: 13,
  },
  // Goal list editor styles.
  editorGoalsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  editorGoalAddBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.45)',
    backgroundColor: 'rgba(247,147,26,0.08)',
  },
  editorGoalAddBtnText: {
    color: '#f7931a',
    fontSize: 12,
    fontWeight: '600',
  },
  editorGoalsEmpty: {
    color: '#666',
    fontSize: 12,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  editorGoalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 6,
  },
  editorGoalCheck: {
    width: 28,
    height: 28,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#444',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a0a18',
  },
  editorGoalCheckCompleted: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16,185,129,0.15)',
  },
  editorGoalCheckText: {
    color: '#cfd2e0',
    fontSize: 14,
  },
  editorGoalInput: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#333',
  },
  editorGoalInputCompleted: {
    color: '#666',
    textDecorationLine: 'line-through',
  },
  editorGoalRemoveBtn: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: '#1a1a28',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorGoalRemoveBtnText: {
    color: '#a55',
    fontSize: 14,
  },
  editorDirectoryHint: {
    color: '#7a809a',
    fontSize: 11,
    marginTop: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // Directory-suggestion hint for NEW quests.
  editorDirectorySuggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#1a1a2e',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2a2a3f',
  },
  editorDirectorySuggestionText: {
    color: '#9a9eb8',
    fontSize: 11,
    lineHeight: 16,
  },
  // v3.10.153: wrapper so the tappable path text can size itself
  // without forcing the parent <Text> to shrink-to-fit (which would
  // break line wrapping on long paths).
  editorDirectorySuggestionTextWrap: {
    flex: 1,
    paddingRight: 6,
  },
  editorDirectorySuggestionPath: {
    color: '#00f0ff',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
  },
  editorDirectorySuggestionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#2a2a3f',
    borderRadius: 4,
    marginLeft: 8,
  },
  editorDirectorySuggestionBtnText: {
    color: '#ff8c1a',
    fontSize: 11,
    fontWeight: '700',
  },
  editorDirectoryHelpText: {
    color: '#5a5e78',
    fontSize: 10,
    marginTop: 6,
    fontStyle: 'italic',
  },
  // Per-quest project instructions field in the editor.
  editorInstructionsBlock: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2a3f',
  },
  editorInstructionsHint: {
    color: '#7a809a',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  editorInstructionsTextarea: {
    backgroundColor: '#0a0a0a',
    borderColor: '#2a2a3f',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#e0e0e0',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    minHeight: 180,
    textAlignVertical: 'top',
  },
  editorInstructionsPath: {
    color: '#666',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 6,
    paddingHorizontal: 4,
  },
  editorInstructionsLoading: {
    color: '#7a809a',
    fontSize: 12,
    fontStyle: 'italic',
    paddingVertical: 12,
  },
  editorInstructionsDirtyHint: {
    color: '#fbbf24',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 6,
  },
  editorHint: {
    color: '#666',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 12,
    lineHeight: 15,
  },
  editorFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#1a1a2e',
    gap: 8,
  },
  editorFooterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  editorFooterBtnDanger: {
    borderColor: '#a55',
  },
  editorFooterBtnPrimary: {
    backgroundColor: '#f7931a',
    borderColor: '#f7931a',
  },
  editorFooterBtnText: {
    color: '#cfd2e0',
    fontSize: 13,
    fontWeight: '600',
  },
  editorFooterBtnTextDanger: {
    color: '#a55',
    fontSize: 13,
    fontWeight: '600',
  },
  editorFooterBtnTextPrimary: {
    color: '#0a0a0a',
    fontSize: 13,
    fontWeight: '700',
  },
});
