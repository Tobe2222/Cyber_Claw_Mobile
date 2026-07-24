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

import React, { useState, useEffect, useRef } from 'react';
import {
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
// v3.10.86: SafeAreaInsets for the editor modal's top
// padding. Without this, the editor modal's bottom-sheet
// card sits at the bottom and the dimmed quest list above
// it shows through the scrim, with the status bar drawn on
// top of the scrim — looks like a visual conflict at the
// top of the screen (Tobe reported 2026-07-23). With the
// inset padding, the modal starts below the status bar.
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  // v3.10.86: SafeAreaInsets for the editor modal's top
  // padding. See the comment on the import.
  const insets = useSafeAreaInsets();
  const [quests, setQuests] = useState<CompanionQuest[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // v3.10.73: track whether at least one fresh broadcast
  // from the desktop has been received. Without this, the
  // user can tap ✏️ while the cache is still showing
  // pre-broadcast data — the editor opens with a stale id
  // that the desktop doesn't recognize, and Save fails
  // with "quest not found". Tobe hit this on 2026-07-22.
  // We render cards from cache for instant paint, but
  // block edits (and show a hint) until the first
  // broadcast arrives so the editor always uses fresh ids.
  const [firstBroadcastReceived, setFirstBroadcastReceived] = useState(false);
  // v3.7.7: tapped quest shown in the detail modal. null = closed.
  const [detail, setDetail] = useState<CompanionQuest | null>(null);
  // v3.8.0: editor modal. null = closed, otherwise the
  // quest being edited (a shallow copy of the current state
  // so the form fields can be edited without mutating the
  // displayed quest). When the user taps Save we send an
  // update to the desktop and the broadcast replaces the
  // state with the canonical version.
  const [editorOpen, setEditorOpen] = useState<CompanionQuest | null>(null);
  // v3.8.0: confirm dialog state. null = hidden,
  // otherwise {title, message, onConfirm}.
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  // v3.8.0: transient error toast (e.g. quest edit failed
  // on the desktop). Cleared automatically on next render
  // or on user dismiss.
  const [error, setError] = useState<string | null>(null);
  // v3.8.0: refs so the quests_list handler (which lives
  // inside a useEffect with empty deps) can read the
  // current editorOpen / detail state without going stale.
  // Without these, the handler would always see the values
  // from the first render (both null) and never auto-close
  // the editor when the broadcast confirms the edit.
  const editorOpenRef = useRef<CompanionQuest | null>(null);
  const detailRef = useRef<CompanionQuest | null>(null);
  // v3.8.1: ref for "is the editor open for a new quest".
  // When true, the broadcast handler closes the editor on
  // the next broadcast (we don't need to match an id since
  // the new quest gets a fresh id from the desktop).
  const creatingNewRef = useRef<boolean>(false);
  useEffect(() => { editorOpenRef.current = editorOpen; }, [editorOpen]);
  useEffect(() => { detailRef.current = detail; }, [detail]);
  useEffect(() => { creatingNewRef.current = !!(editorOpen && !editorOpen.id); }, [editorOpen]);

  // v3.10.84: Android system back / gesture-nav back
  // should pop the screen (and any open modals) instead
  // of exiting the app. Tobe reported on v3.10.83
  // (2026-07-23): "when inside the quest menu the phone
  // back swipe exits the program. It should just go back
  // to the home screen."
  //
  // Mirrors the pattern SettingsScreen (line 472) and
  // CompanionSettingsScreen (line 765) use for their own
  // back handling. Priority order matters:
  //   1. confirm dialog (delete confirmation)
  //   2. editor modal (create/edit quest)
  //   3. detail modal (view quest)
  //   4. screen itself → onBack() to return to home
  // Each step returns true to tell the OS "I handled
  // this, don't bubble it up to the activity (which would
  // exit the app)."
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (confirm) { setConfirm(null); return true; }
      if (editorOpen) {
        setEditorOpen(null);
        // If the editor was opened from the detail modal,
        // the detail modal is already null (we close
        // detail when opening editor). But onBack flow
        // already cleared it, so nothing else to do here.
        return true;
      }
      if (detail) { setDetail(null); return true; }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack, confirm, editorOpen, detail]);

  // v3.7.6: hydrate from the global cache key on mount, then
  // migrate any v3.7.4-era per-companion keys (cyberclaw-quests-<id>)
  // into the global cache before deleting them.
  //
  // v3.7.10: also fire `requestQuestsList()` on mount so the
  // desktop sends a fresh payload within ~100ms. Without this,
  // the screen relies on the broadcast that fired at auth time
  // (SyncClient auto-fires request_quests_list 500ms after
  // auth), which the user may have missed if they navigated
  // here long after connecting, or were on a different tab
  // when the broadcast went out. The cache is read first for
  // instant render, then the fresh request fires and the
  // handler replaces the cache data with the live broadcast.
  //
  // Lesson (v3.7.8 → v3.7.10): when a screen mirrors data
  // from a source that broadcasts only on certain events
  // (auth, save, etc.), the screen needs to also request on
  // mount to guarantee a fresh payload. Otherwise the screen
  // is at the mercy of the auth-time broadcast, which can be
  // missed in normal navigation patterns. Tobe's first
  // v3.7.8 test showed the v3.7.7 visual because the cache
  // was holding pre-v3.1.50 data and the screen wasn't
  // re-requesting on mount. Adding the mount-time request
  // fixes this.
  useEffect(() => {
    let cancelled = false;
    // v3.10.73: reset the first-broadcast-received flag
    // on every mount of this screen. Otherwise the flag
    // is sticky across navigations and a user who enters
    // Quests a second time could land on stale-id data
    // if the cache wasn't refreshed in the meantime.
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
      // v3.10.73: mark first-broadcast as received so the
      // editor can be safely opened. Cache-only data has
      // potentially stale ids that the desktop won't
      // recognize (Tobe hit "Couldn't update quest: quest
      // not found" on 2026-07-22). After this point the
      // card data is canonical and edits will round-trip.
      setFirstBroadcastReceived(true);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(list)).catch(() => {});
      // v3.8.0: if the editor is open and the broadcast
      // includes a quest with the same id, the desktop has
      // confirmed the edit. Close the editor so the user
      // sees the new state in the list. We use refs here
      // (not state) because the handler lives inside a
      // useEffect with empty deps — reading state directly
      // would give us the stale initial value.
      const editingId = editorOpenRef.current?.id;
      // v3.8.1: if the editor is open for a new quest
      // (empty id), the desktop has just created it; any
      // broadcast that lands after the create_quest call
      // is the confirmation. Close the editor.
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

    // v3.8.0: listen for failed quest edits. The desktop
    // sends `quests_update_failed` when the mutation
    // couldn't be applied (e.g. quest not found). Show an
    // error toast so the user knows the edit didn't take.
    //
    // v3.10.74: include the desktop's diagnostic info
    // (the list of available quest ids, when provided) so
    // Tobe can see "looking for X, available [a, b, c]"
    // and we can pinpoint the id-mismatch bug without
    // guessing. Also log the full msg to console for the
    // dev menu / log tab.
    const failedHandler = (msg: any) => {
      const action = msg?.action || 'edit';
      const reason = msg?.error || 'unknown error';
      let detail = `Couldn't ${action.replace(/_/g, ' ')}: ${reason}`;
      // v3.10.77: rich diagnostic info from the
      // desktop. Shows id + name pairs so Tobe can
      // see whether the id is genuinely unknown or
      // just stale (e.g. "id=abc123 is for the
      // CYBERHIVE_WEBSITE V2 quest on the desktop, but
      // the mobile is asking for id=xyz789 which
      // doesn't match").
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
      // v3.10.74: also surface the diagnostic in the
      // console for the dev menu / log tab. addLogEntry
      // is a HomeScreen helper not in scope here, but
      // console.log gets picked up by the log tab via
      // the WebView's console listener.
      console.warn('[QuestsScreen] edit failed:', detail, msg);
    };
    syncClient.on?.('quests_update_failed', failedHandler);

    // v3.7.10: request a fresh list on mount. The auth-time
    // request fires 500ms after WebSocket auth, but the user
    // may have navigated to the QuestsScreen long after that
    // — or the auth-time broadcast may have been missed if the
    // screen wasn't mounted yet. Requesting on mount guarantees
    // the handler fires with the latest data, which sets state
    // to the live broadcast (with the latest `active` and
    // `latestChanges` fields). The cache read above covered the
    // brief render window before the response arrives.
    try {
      syncClient.requestQuestsList?.();
    } catch (_) {}

    return () => {
      cancelled = true;
      syncClient.off?.('quests_list', handler);
      syncClient.off?.('quests_update_failed', failedHandler);
    };
  }, []);

  // v3.8.0: action handlers. Each one calls the
  // corresponding SyncClient method which sends a WebSocket
  // message to the desktop. The desktop performs the
  // mutation and broadcasts the updated list (existing
  // path); the handler in the useEffect above replaces the
  // local state with the canonical data within ~100ms.
  //
  // No optimistic update here — the broadcast is fast
  // enough that the user perceives an instant change, and
  // skipping the optimistic-update path means we never have
  // to roll back if the desktop rejects the edit. The
  // `quests_update_failed` handler (also in the useEffect)
  // shows a toast on rejection.
  const handleSetActive = (id: string | null) => {
    setError(null);
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
  const handleMarkGoalDone = (id: string, goalIndex: number, completed: boolean) => {
    setError(null);
    syncClient.markQuestGoalDone?.(id, goalIndex, completed);
  };

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
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quests</Text>
          <Text style={styles.sectionDesc}>
            Synced from the desktop's Quests panel. The active quest
            (the one the companion is working on) is marked with a
            ⚡ ACTIVE badge and a gold border. Tap the actions below a
            card to set it active, edit it, or delete it. The phone
            edits round-trip to the desktop in real-time.
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
            {/* v3.10.82: "No active quest" card. Tobe's request
                (2026-07-23): "Also add a default/no quest for
                conversations not related to any of them."
                Previously the only way to clear the active quest
                was via the desktop UI; on the mobile, an active
                quest stayed active forever once set, which meant
                the agent kept getting quest context injected on
                every chat reply even when the user wanted to
                chat about something unrelated.

                This card is the "default state" toggle. Tapping
                it calls handleSetActive(null), which sends
                `set_quest_active` with `id: null` to the desktop.
                The desktop's onSetQuestActive handler already
                supports empty/null ids (sets active: false on all
                quests). The chat pipeline then stops injecting
                quest context until another quest is set active.

                The card is always visible at the top of the list
                so the user can switch back to "no active quest"
                even when a quest is currently active.

                Visual: dashed border, lighter background, and a
                ☆ icon that turns to ★ when "no quest" is the
                current active state (matches the active-quest
                visual language on the other cards). */}
            <TouchableOpacity
              style={[
                styles.questCard,
                styles.noQuestCard,
                quests.every(q => !q.active) && styles.noQuestCardActive,
              ]}
              onPress={(e) => {
                e?.stopPropagation?.();
                if (!firstBroadcastReceived) return;
                handleSetActive(null);
              }}
              disabled={!firstBroadcastReceived}
            >
              <View style={styles.questTopRow}>
                <Text style={styles.questName}>💬  No active quest</Text>
                <Text style={[styles.questPct, { fontSize: 16 }]}>
                  {quests.every(q => !q.active) ? '★' : '☆'}
                </Text>
              </View>
              <Text style={styles.noQuestCardDesc}>
                Default state — chat without any quest context.
                Use this for conversations that aren't about any
                specific project. Tap to clear the active quest.
              </Text>
              {quests.some(q => q.active) && (
                <Text style={styles.noQuestCardHint}>
                  ⏵ Tap to deactivate “{quests.find(q => q.active)?.name}”
                </Text>
              )}
            </TouchableOpacity>
            {sorted.map((q) => {
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
                    // v3.7.10: ⚡ ACTIVE banner at the top of
                    // the card. INLINE (not absolute-positioned
                    // like v3.7.8 was) so it doesn't overlap
                    // the done/total count. Bumped font size
                    // from 9pt to 11pt and added a subtle
                    // background tint so the eye lands on it
                    // even at a glance.
                    <View style={styles.activeBanner}>
                      <Text style={styles.activeBannerText}>
                        ⚡  ACTIVE — companion is working on this
                      </Text>
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
                  {/* v3.10.79: inline step list. Previously the card
                     showed only the progress text + bar; users had
                     to tap the card to see the actual steps in the
                     detail modal. Tobe reported on 2026-07-22 that
                     the steps should be visible inline so he doesn't
                     have to tap each card to remember what's left.
                     First 3 steps show by default; the rest fall in
                     the detail modal. */}
                  {goals.length > 0 && (
                    <View style={styles.questSteps}>
                      {goals.slice(0, 3).map((g, i) => (
                        <Text
                          key={i}
                          style={[
                            styles.questStepText,
                            g.completed && styles.questStepCompleted,
                          ]}
                          numberOfLines={1}
                        >
                          {g.completed ? '☑' : '☐'}  {g.text}
                        </Text>
                      ))}
                      {goals.length > 3 && (
                        <Text style={styles.questStepMore}>
                          +{goals.length - 3} more (tap card for full list)
                        </Text>
                      )}
                    </View>
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

                  {/* v3.8.0: action row. Three quick actions
                      on each card: ⭐ set active (hidden
                      on the already-active card since the
                      ACTIVE banner already says it's
                      active), ✏️ open editor, ✕ delete.
                      Inline TouchableOpacity so the touch
                      is absorbed and doesn't bubble to
                      the card's onPress (which would open
                      the detail modal). */}
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      // v3.10.73: disable the ✏️ button
                      // until the first broadcast arrives.
                      // Otherwise the editor opens with a
                      // stale id from the cache and Save
                      // fails with "quest not found" because
                      // the desktop doesn't recognize the
                      // id. Tobe hit this on 2026-07-22.
                      style={[
                        styles.cardActionBtn,
                        !firstBroadcastReceived && styles.cardActionBtnDisabled,
                      ]}
                      onPress={(e) => {
                        e?.stopPropagation?.();
                        if (!firstBroadcastReceived) return;
                        setEditorOpen({ ...q });
                      }}
                    >
                      <Text style={styles.cardActionText}>✏️</Text>
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                    {/* v3.10.83: prominent "Set as active" button.
                        v3.10.82 moved ☆ to the right but kept it
                        as a small icon-only button. Tobe's
                        follow-up (2026-07-23): "That star is it
                        perhaps but thats not intuitive. Create a
                        bigger set as active button on the right
                        side of each as i asked for."

                        Now it's a proper labeled button with
                        the star icon + "Set as active" text,
                        gold-tinted, sits clearly on the right
                        edge of the action row. When the quest
                        IS active, replace with a non-interactive
                        "✓ Active" label so the user can confirm
                        the state at a glance (the ACTIVE banner
                        at the top of the card is fine for the
                        initial discovery, but the inline label
                        right next to the action button confirms
                        the current state when scanning cards).

                        The ✕ stays as a small icon-only button
                        on the far right edge (destructive
                        actions on the edge, infrequent). ✏️
                        stays on the left as a small icon-only
                        button (secondary action). */}
                    <TouchableOpacity
                      style={[
                        styles.cardSetActiveBtn,
                        isActive && styles.cardSetActiveBtnActive,
                        !firstBroadcastReceived && styles.cardActionBtnDisabled,
                      ]}
                      onPress={(e) => {
                        e?.stopPropagation?.();
                        if (!firstBroadcastReceived) return;
                        if (isActive) {
                          // Tap the active button → deactivate
                          // (jump to "no active quest" default).
                          // Mirrors the no-quest card behavior
                          // — easier than going back to the top
                          // of the list.
                          handleSetActive(null);
                        } else {
                          handleSetActive(q.id);
                        }
                      }}
                    >
                      <Text style={[
                        styles.cardSetActiveBtnIcon,
                        isActive && styles.cardSetActiveBtnTextActive,
                      ]}>
                        {isActive ? '✓' : '☆'}
                      </Text>
                      <Text style={[
                        styles.cardSetActiveBtnText,
                        isActive && styles.cardSetActiveBtnTextActive,
                      ]}>
                        {isActive ? 'Active' : 'Set active'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      // v3.10.73: same staleness guard as
                      // ✏️ and the set-active button. delete_quest
                      // with a stale id silently no-ops which
                      // is even worse than the others — the
                      // user clicks Delete, the confirmation
                      // dialog appears, they confirm, and
                      // nothing happens.
                      style={[
                        styles.cardActionBtn,
                        !firstBroadcastReceived && styles.cardActionBtnDisabled,
                      ]}
                      onPress={(e) => {
                        e?.stopPropagation?.();
                        if (!firstBroadcastReceived) return;
                        setConfirm({
                          title: 'Delete quest?',
                          message: `"${q.name}" will be removed from the desktop too. This can't be undone.`,
                          onConfirm: () => {
                            setConfirm(null);
                            handleDeleteQuest(q.id);
                          },
                        });
                      }}
                    >
                      <Text style={[styles.cardActionText, styles.cardActionTextDelete]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              );
            })}
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
                  // v3.8.0: open the editor with a copy of
                  // the current quest. Closing the detail
                  // modal first so we don't have two modals
                  // stacked. The editor handles its own
                  // save/cancel flow.
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
              onSave={(updates) => {
                // v3.8.1: if we opened the editor for a new
                // quest (empty id), call createQuest instead
                // of updateQuest. The desktop assigns the id
                // and broadcasts the new quest; the handler
                // in the useEffect above closes the editor
                // when the next broadcast arrives.
                if (!editorOpen.id) {
                  syncClient.createQuest?.({
                    name: updates.name,
                    description: updates.description,
                    goals: Array.isArray(editorOpen.goals) ? editorOpen.goals : [],
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

// v3.8.0: quest editor body. Pure render (no hooks
// inside, v3.7.1 pattern). The form fields are local
// state — when the user taps Save we call the
// onSave callback with the diff and the parent
// (QuestsScreen) sends the update to the desktop.
//
// The form is intentionally simple: a ScrollView
// with TextInput rows. For a richer editor we'd
// add a goals sub-list with add/remove buttons, but
// the v3.8.0 scope is the basics (name, description,
// status, active, plus goal-completion via the detail
// modal's tap-to-toggle).
function QuestEditorBody({
  quest,
  isNew,
  onClose,
  onSave,
  onDelete,
  insets,
}: {
  quest: CompanionQuest;
  // v3.8.1: when true, the editor is in "new quest" mode.
  // Hides the Delete button (nothing to delete yet) and
  // the title changes to "New quest". The Save handler in
  // the parent detects this via the empty quest.id and
  // calls createQuest instead of updateQuest.
  isNew?: boolean;
  onClose: () => void;
  onSave: (updates: Record<string, any>) => void;
  onDelete: () => void;
  // v3.10.86: SafeAreaInsets passed from the parent so the
  // editor header can start below the status bar on
  // Android edge-to-edge.
  insets?: { top: number; bottom: number; left: number; right: number };
}) {
  // Local form state. Initialized from the quest prop.
  // The form is uncontrolled-ish (we just track values);
  // Save bundles them into an updates object.
  const [name, setName] = useState(quest.name || '');
  const [description, setDescription] = useState(quest.description || '');
  const [status, setStatus] = useState<'active' | 'completed'>(quest.status || 'active');
  // v3.10.74: goal list is now editable in the editor.
  // Each entry is { text: string, completed: boolean }.
  // We normalize string[] legacy entries on load. The
  // editor renders one TextInput per goal with a remove
  // button, plus an "Add step" button at the bottom.
  // Tobe reported on 2026-07-22: "Still missing the
  // steps" — the previous "Goal text editing lands in a
  // future release" hint was correct but the feature is
  // shipping now.
  const [goals, setGoals] = useState<Array<{ text: string; completed: boolean }>>(() => {
    if (!Array.isArray(quest.goals)) return [];
    return quest.goals.map((g) =>
      typeof g === 'string'
        ? { text: g, completed: false }
        : { text: g.text || '', completed: !!g.completed },
    );
  });

  return (
    // v3.10.86: paddingTop includes the safe-area inset so
    // the editor header starts below the status bar on
    // Android (edge-to-edge mode). `insets.top` is 0 on
    // iOS with the system status bar, ~30-50dp on Android
    // depending on the device. The paddingTop: 8 in the
    // style adds a small breathing-room on top of that.
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
        <Text style={styles.editorFieldLabel}>Status</Text>
        <View style={styles.editorStatusRow}>
          <TouchableOpacity
            style={[
              styles.editorStatusChip,
              status === 'active' && styles.editorStatusChipActive,
            ]}
            onPress={() => setStatus('active')}
          >
            <Text style={styles.editorStatusChipText}>
              {status === 'active' ? '⚔️' : '  '} Active
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.editorStatusChip,
              status === 'completed' && styles.editorStatusChipActive,
            ]}
            onPress={() => setStatus('completed')}
          >
            <Text style={styles.editorStatusChipText}>
              {status === 'completed' ? '🏁' : '  '} Completed
            </Text>
          </TouchableOpacity>
        </View>
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
        {!!quest.directory && (
          <Text style={styles.editorDirectoryHint}>
            📁 {quest.directory}
          </Text>
        )}

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
            // v3.10.74: goals are now editable. We send
            // the full array (preserving `completed`
            // flags and order) and filter out empty
            // entries so the user can save a step mid-
            // typing without losing the rest. The
            // desktop's onUpdateQuest strips `id`/`active`
            // and accepts goals as-is.
            const cleanedGoals = goals
              .map((g) => ({ text: g.text.trim(), completed: g.completed }))
              .filter((g) => g.text.length > 0);
            const updates: Record<string, any> = {
              name: name.trim() || quest.name,
              description: description.trim(),
              status,
              goals: cleanedGoals,
            };
            onSave(updates);
          }}
        >
          <Text style={styles.editorFooterBtnTextPrimary}>Save</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// v3.7.7: detail-modal body. Pure render — props in, JSX out,
// no hooks. Keeping it a sibling function of QuestsScreen so
// the screen-level hook order stays clean (v3.7.1 pattern).
// v3.8.0: detail body takes optional callbacks for
// edit and mark-goal-done. Passed in from QuestsScreen so
// the body stays pure (no hooks) per the v3.7.1 pattern.
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

  // v3.10.101: per-quest instructions. Read-only on the
  // mobile. We request the file content from the desktop
  // when the detail modal opens and cache it locally.
  // The desktop's editor is the source of truth; the
  // mobile just shows what the file currently says.
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
            // v3.8.0: tap a goal to toggle its completed
            // flag. TouchableOpacity absorbs the touch so
            // it doesn't bubble. Optional onMarkGoalDone
            // callback (only wired when the screen is
            // rendered via QuestsScreen, which always wires
            // it; the prop is optional so the function
            // remains usable in isolation).
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
  // v3.10.82: "No active quest" card. Dashed border to
  // visually distinguish it from real quests (which have
  // solid colored borders). Lighter background so it
  // doesn't compete with the real quests below. When this
  // is the active state, swap to a soft gold border +
  // bright star icon, matching the active-quest visual
  // language on regular cards.
  noQuestCard: {
    backgroundColor: '#0a0e1a',
    borderColor: '#3a3f55',
    borderStyle: 'dashed',
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginVertical: 6,
  },
  noQuestCardActive: {
    borderColor: '#f7931a',
    borderStyle: 'solid',
    borderWidth: 2,
    backgroundColor: '#1a1408',
  },
  noQuestCardDesc: {
    color: '#7a809a',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  noQuestCardHint: {
    color: '#f7931a',
    fontSize: 11,
    marginTop: 6,
    fontStyle: 'italic',
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
  // v3.10.79: inline step list on the card. Compact
  // display so a 3-step quest fits without making the
  // card feel crowded; longer lists fall back to "+N
  // more (tap card)" hint.
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
  // v3.10.101: per-quest instructions display. The
  // path is shown in a monospace font with a muted
  // color so it doesn't compete with the content.
  // The content is in a styled box with a monospace
  // font to mirror the desktop editor's textarea.
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

  // v3.7.10: list-card ACTIVE banner (inline, top of card).
  // Replaces the v3.7.8 absolute-positioned badge which was
  // too subtle (9pt font) and overlapped the done/total count.
  // Now: full-width banner at the top of the card, 11pt font,
  // bold gold text on a soft gold tint, slight letter-spacing
  // for that "alert" feel. Impossible to miss.
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
  // v3.10.83: prominent "Set as active" button.
  // Gold-tinted pill, sits on the right side of the
  // action row. v3.10.82 had ☆ as a small icon-only
  // button which Tobe found unintuitive — the icon
  // was visually similar to the ✕ next to it and
  // didn't read as a primary action. Now it's a
  // proper labeled pill: star icon + "Set active"
  // text, gold border + soft gold background. When
  // the quest IS active, the same button becomes
  // green (✓ Active) to show the current state at
  // a glance without relying on the ACTIVE banner
  // at the top of the card.
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
  // v3.10.83: active-state visual for the set-active
  // button. Green (instead of gold) so it reads as
  // "this is the current state" rather than "tap to
  // do something". The ACTIVE banner at the top of
  // the card is gold, so green here gives a clear
  // visual distinction between "the card is the
  // active quest" (top, gold) and "this button
  // confirms the active state" (bottom, green).
  cardSetActiveBtnActive: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
  },
  cardSetActiveBtnTextActive: {
    color: '#10b981',
  },
  // v3.10.73: stale-id guard. When the first desktop
  // broadcast hasn't arrived yet (cache-only render),
  // the card action buttons dim so the user sees they
  // can't safely edit yet.
  cardActionBtnDisabled: {
    opacity: 0.35,
  },
  // v3.10.73: small hint shown above the card list
  // when no broadcast has been received from the
  // desktop yet. Explains why edit/active/delete
  // buttons are dimmed.
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

  // v3.10.82: detail-modal footer (Close + Edit). Both
  // buttons get flex: 1 so they share width equally.
  // v3.8.0 had flex: 1 only on Edit, which made Close
  // hug the left edge while Edit stretched across the
  // rest — looked wonky. Both buttons now get their own
  // visible border (the v3.10.82 polish Tobe asked for)
  // and a bit more vertical breathing room.
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

  // v3.10.86: editor modal. Full-screen layout with safe-
  // area top padding instead of the v3.8.0 bottom-sheet
  // style. Tobe reported (2026-07-23): "some padding top
  // for the background when editing quests. You can see
  // the conflict in the top here." The v3.8.0 bottom-
  // sheet design used `marginTop: 'auto'` to push the card
  // to the bottom with `maxHeight: '90%'`, which left the
  // top ~10% of the scrim showing the dimmed quest list
  // behind. Combined with Android 15+ edge-to-edge (status
  // bar drawn on top of the scrim, not above it), the top
  // of the screen ended up showing a confusing mix of
  // dimmed quest content + status bar + modal — the
  // "conflict" Tobe saw.
  //
  // The fix: make the editor card full-screen (width +
  // height 100%) with a small top padding for the safe
  // area. This makes the editor feel like a dedicated
  // editing screen rather than a partial bottom sheet,
  // and the dimmed quest list is no longer visible
  // through the scrim. The bottom-sheet rounded corners
  // are gone too — a full-screen card doesn't need them.
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
  // v3.10.74: goal list editor styles. The mobile
  // previously had no way to edit goal text — only
  // tap-to-toggle in the detail modal. Tobe reported
  // the missing-steps bug 2026-07-22.
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
