/**
 * CompanionSettingsScreen — per-companion settings as its OWN screen.
 *
 * v3.4.4: extracted from SettingsScreen into its own file so that
 * tapping a companion in Voice mode → list swaps the ENTIRE app
 * view to this screen, instead of rendering the companion detail
 * inline within SettingsScreen's scroll (which mixed companion
 * settings with Voice & Speech / Permissions / Connection sections
 * on the same scroll — confusing per Tobe's v3.4.3 feedback).
 *
 * Reached via App.tsx route 'companion' with a companionId prop.
 * Back button → returns to SettingsScreen.
 *
 * UI hierarchy (5 levels):
 *   App.tsx
 *     ↓ tap companion row in SettingsScreen
 *   <CompanionSettingsScreen>
 *     - companion overview (Wake / Exit cards)
 *         ↓ tap Wake card
 *     - Wake settings sub-page (greeting, phrases, train)
 *         ↓ back
 *     - companion overview
 *         ↓ tap Exit card
 *     - Exit settings sub-page (reply, phrases, train)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform, NativeModules, BackHandler,
} from 'react-native';
const { WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import OpenWakeWordTrainer from '../components/OpenWakeWordTrainer';
import ExitPhraseTrainer from '../components/ExitPhraseTrainer';
// v3.7.0: per-companion voice settings (engine + voice id,
// both Local and Premium API paths). The catalog of available
// voices is shared with the global Settings screen via
// VoiceCatalog.ts.
import {
  loadVoiceFor, saveVoiceFor, clearVoiceFor,
  loadVoiceSettings, saveSilenceMs,
} from '../services/VoiceSettings';
import {
  LOCAL_VOICES,
  PREMIUM_PROVIDERS,
  VoiceEngine,
} from '../services/VoiceCatalog';
// v3.7.1: syncClient for the desktop "Test voice" button.
import syncClient from '../services/SyncClient';

type Companion = {
  id: string;
  name: string;
  emoji?: string | null;
  icon?: string | null;
};

export default function CompanionSettingsScreen({
  companionId,
  onBack,
}: {
  companionId: string;
  onBack: () => void;
}) {
  // v3.4.4: drill-down phase inside the companion
  // detail view. null = overview (cards). 'wake' / 'exit'
  // = sub-page for that phase.
  // v3.7.0: 'voice' added — per-companion voice engine +
  // voice picker (Local / Premium API / Use global default).
  const [companionViewPhase, setCompanionViewPhase] = useState<'wake' | 'exit' | 'voice' | 'quests' | null>(null);

  // Companion list — owned here (not lifted to App.tsx)
  // because this screen needs it to resolve companionId
  // → {name, emoji}. Hydrates from the same AsyncStorage
  // cache that HomeScreen writes.
  const [availableCompanions, setAvailableCompanions] = useState<Companion[]>([]);

  // Per-companion settings state
  const [readyPhrase, setReadyPhrase] = useState('Ready to chat');
  const [readyPhraseSavedAt, setReadyPhraseSavedAt] = useState<number | null>(null);
  const readyPhraseSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [exitReplyPhrase, setExitReplyPhrase] = useState('Goodbye!');
  const [exitReplySavedAt, setExitReplySavedAt] = useState<number | null>(null);
  const exitReplySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [voiceExitPhrase, setVoiceExitPhrase] = useState('thanks');
  const [voiceExitPhraseSavedAt, setVoiceExitPhraseSavedAt] = useState<number | null>(null);

  // v3.7.1: per-companion voice picker state. v3.7.0 put
  // these inside renderCompanionVoicePage, which crashed
  // with "Rendered more hooks than during the previous
  // render" because the dispatch returns one of four
  // render-functions per render, and only one of them
  // had hooks (6 of them). When the user backed out, the
  // next render called a different render-function with 0
  // hooks, breaking React's hook bookkeeping.
  //
  // Fix: lift all voice state to the screen level, next
  // to the wake/exit state. The render-function becomes
  // pure, matching the existing renderCompanionWakePage /
  // renderCompanionExitPage pattern. Hydration re-runs
  // when the active companionId changes, mirroring the
  // voiceExitPhrase rehydration below.
  const [vcEngine, setVcEngine] = useState<VoiceEngine>('default');
  const [vcLocalId, setVcLocalId] = useState<string>('default');
  const [vcApiProvider, setVcApiProvider] = useState<string>('elevenlabs');
  const [vcApiVoice, setVcApiVoice] = useState<string>('nova');
  const [vcGlobalApiEnabled, setVcGlobalApiEnabled] = useState<boolean>(false);
  const [vcSavedAt, setVcSavedAt] = useState<number | null>(null);
  const vcLoadedRef = useRef(false);

  // v3.7.2: per-companion silence timeout. Re-runs the
  // rehydration below on companion switch (mirrors the
  // voice config rehydration). The silence picker in the
  // voice sub-page consumes this state.
  const [vcSilenceMs, setVcSilenceMs] = useState<number>(5000);
  const [vcSilenceSavedAt, setVcSilenceSavedAt] = useState<number | null>(null);
  const vcSilenceLoadedRef = useRef(false);

  // v3.1.95: per-companion quest lists. The desktop's quest
  // model is global (every quest is visible to every
  // companion), but on the mobile side we cache a copy per
  // companionId so each agent's settings screen sees its own
  // snapshot — quests can diverge per agent in the future
  // (different active-quest mappings, agent-specific filters),
  // and per-keyed storage is the right shape even when the
  // payload is currently identical for every slot.
  //
  // Read-only on mobile for now: we mirror the desktop's list
  // but don't push edits back. Create/update/delete flows
  // happen on the desktop (the directory picker, the goals
  // editor etc. all need filesystem access). Companion-side
  // toggles (e.g. mark a quest as "active for me") would land
  // here in v2.
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
  const [questsByCompanion, setQuestsByCompanion] = useState<Record<string, CompanionQuest[]>>({});
  const questsLoadedRef = useRef(false);

  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number }>>({});

  // Trainer modal state
  const [trainingCompanionId, setTrainingCompanionId] = useState<string | null>(null);
  const [trainingCompanionName, setTrainingCompanionName] = useState<string>('');
  const [editingWakePhrase, setEditingWakePhrase] = useState<string>('');
  const [showOwwTrainer, setShowOwwTrainer] = useState(false);
  const [editingExitPhrase, setEditingExitPhrase] = useState<string>('');
  const [showExitPhraseTrainer, setShowExitPhraseTrainer] = useState(false);

  // v3.4.4: set true when the active companionId was
  // missing from a populated cache and we already auto-
  // backed out, so we don't loop onBack in render.
  const hasAutoBackedRef = useRef(false);

  // Hydrate companion list from local cache
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-agents-cache');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setAvailableCompanions(parsed.map((a: any) => ({
              id: a.id,
              name: a.name,
              emoji: a.emoji || null,
              icon: a.icon || null,
            })));
          }
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate wake greeting
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-ready-phrase');
        if (raw !== null) {
          setReadyPhrase(raw);
          setReadyPhraseSavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate exit reply
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-exit-reply-phrase');
        if (raw !== null) {
          setExitReplyPhrase(raw);
          setExitReplySavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate exit phrase (per-companion)
  useEffect(() => {
    (async () => {
      try {
        const { getExitPhraseKey } = await import('../services/VoiceSettings');
        const p = await AsyncStorage.getItem(getExitPhraseKey(companionId));
        if (p) {
          setVoiceExitPhrase(p);
          setVoiceExitPhraseSavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, [companionId]);

  // v3.7.1: hydrate the per-companion voice picker state.
  // Re-runs when the active companionId changes so the
  // picker shows the right voice for the right companion.
  // Mirrors the pattern of the wake-greeting and exit-phrase
  // rehydrations above.
  useEffect(() => {
    let cancelled = false;
    vcLoadedRef.current = false;
    setVcSavedAt(null);
    (async () => {
      const cfg = await loadVoiceFor(companionId);
      // Determine stored engine: 'default' if no per-companion
      // override was written, else the explicit value.
      let storedEngine: VoiceEngine = 'default';
      try {
        const raw = await AsyncStorage.getItem(`cyberclaw-voice-engine-${companionId}`);
        if (raw === 'local' || raw === 'api' || raw === 'default') {
          storedEngine = raw;
        }
      } catch (_) {}
      const globalEngine = await AsyncStorage.getItem('cyberclaw-voice-engine').catch(() => null);
      const apiGloballyEnabled = globalEngine === 'api';
      if (cancelled) return;
      setVcEngine(storedEngine);
      setVcLocalId(cfg.localId);
      setVcApiProvider(cfg.apiProvider);
      setVcApiVoice(cfg.apiVoice);
      setVcGlobalApiEnabled(apiGloballyEnabled);
      vcLoadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [companionId]);

  // v3.7.2: hydrate the per-companion silence timeout.
  // loadVoiceSettings reads the per-companion key first
  // (cyberclaw-voice-silence-ms-<companionId>) and falls
  // back to the v3.7.1 global key, so users keep their
  // existing silence setting.
  useEffect(() => {
    let cancelled = false;
    vcSilenceLoadedRef.current = false;
    setVcSilenceSavedAt(null);
    (async () => {
      const settings = await loadVoiceSettings(companionId);
      if (cancelled) return;
      setVcSilenceMs(settings.silenceMs);
      vcSilenceLoadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [companionId]);

  // v3.7.3: listen for the desktop's companion_settings_sync
  // broadcast. If the desktop has a per-companion silence
  // value for the active companion and we don't have one
  // locally (e.g. fresh install, AsyncStorage wiped), use
  // the desktop's value. We don't overwrite a local value
  // — local is source of truth for the phone's runtime;
  // the desktop's value is the cross-device persistence
  // layer. The user can always tap Save to push their
  // local value back to the desktop.
  useEffect(() => {
    const handler = (msg: any) => {
      if (!msg?.settings) return;
      const remote = msg.settings[companionId];
      if (!remote || typeof remote.silenceMs !== 'number') return;
      // Only adopt the remote value if our local store has
      // nothing for this companion. AsyncStorage.getItem
      // is async; we just optimistically check via the
      // vcSilenceLoadedRef — if we already loaded a local
      // value (vcSilenceMs is non-default or we set it
      // earlier in the session), don't clobber.
      AsyncStorage.getItem(`cyberclaw-voice-silence-ms-${companionId}`).then(local => {
        if (local === null) {
          setVcSilenceMs(remote.silenceMs);
        }
      }).catch(() => {});
    };
    syncClient.on('companion_settings_sync', handler);
    return () => { syncClient.off?.('companion_settings_sync', handler); };
  }, [companionId]);

  // Hydrate active-wake-companion preference
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-active-wake-companion');
        if (raw) setActiveWakeCompanionId(raw);
      } catch (_) {}
    })();
  }, []);

  // v3.4.0: one-time migration from v3.3.0's global exit
  // storage to per-companion. Idempotent — no-op if the
  // active companion already has migrated data.
  useEffect(() => {
    (async () => {
      if (availableCompanions.length === 0) return;
      try {
        const { migrateLegacyExitSamples } = await import('../services/VoiceSettings');
        const targetId = activeWakeCompanionId || availableCompanions[0].id;
        await migrateLegacyExitSamples(targetId);
      } catch (_) {}
    })();
  }, [availableCompanions.length, activeWakeCompanionId]);

  // v3.1.95: hydrate the per-companion quest list from
  // AsyncStorage on mount + on companion switch, and
  // subscribe to the SyncClient 'quests_list' event so live
  // updates from the desktop flow into state + storage.
  //
  // We don't fire a separate `requestQuestsList()` here on
  // mount because the SyncClient already auto-requests on
  // auth (SyncClient.ts) and replays the cached payload on
  // reconnect. If the user opened this screen before
  // connecting, the event listener below picks up the list
  // as soon as SyncClient receives one.
  useEffect(() => {
    if (!companionId) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(`cyberclaw-quests-${companionId}`);
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            setQuestsByCompanion(prev => ({ ...prev, [companionId]: parsed }));
          }
        }
        questsLoadedRef.current = true;
      } catch (_) {
        questsLoadedRef.current = true;
      }
    })();

    const handler = (msg: any) => {
      const list: CompanionQuest[] = Array.isArray(msg?.quests) ? msg.quests : [];
      setQuestsByCompanion(prev => ({ ...prev, [companionId]: list }));
      AsyncStorage.setItem(`cyberclaw-quests-${companionId}`, JSON.stringify(list)).catch(() => {});
    };
    syncClient.on?.('quests_list', handler);
    return () => {
      cancelled = true;
      syncClient.off?.('quests_list', handler);
    };
  }, [companionId]);

  // v3.4.4: refresh saved-wake-models whenever the
  // companion list grows or the active companion
  // changes (covers post-training refresh).
  useEffect(() => {
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (!models) return;
        const out: Record<string, { phrase: string; path: string; savedAt: number }> = {};
        for (const agentId of Object.keys(models)) {
          const entry = models[agentId];
          if (entry?.phrase && entry?.path) {
            out[agentId] = {
              phrase: entry.phrase,
              path: entry.path,
              savedAt: entry.savedAt || 0,
            };
          }
        }
        setSavedWakeModels(out);
      })
      .catch(() => {});
  }, [availableCompanions.length, activeWakeCompanionId]);

  // Debounced auto-save for wake greeting
  const persistReadyPhrase = (v: string) => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
    readyPhraseSaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-ready-phrase', v);
      setReadyPhraseSavedAt(Date.now());
      // v3.1.91: kick off a desktop synthesis for the new
      // phrase so the next wake event has a cached audio
      // to play. Fire-and-forget.
      if (v && v.trim()) {
        try {
          const { ensureGreetingCached } = require('../services/GreetingAudioCache');
          ensureGreetingCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // Mirror for exit reply
  const persistExitReplyPhrase = (v: string) => {
    if (exitReplySaveTimer.current) clearTimeout(exitReplySaveTimer.current);
    exitReplySaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-exit-reply-phrase', v);
      setExitReplySavedAt(Date.now());
      // Synthesize. Empty string = silent close.
      if (v && v.trim()) {
        try {
          const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
          ensureExitReplyCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // v3.7.1: per-companion voice picker callbacks. Lifted
  // from the renderCompanionVoicePage helper along with the
  // state (see the comment on vcEngine above for the full
  // reason). Both are useCallback so the Save / Reset buttons
  // don't recreate the handler on every render.
  const saveVoice = useCallback(async () => {
    if (!vcLoadedRef.current) return;
    await saveVoiceFor(companionId, {
      engine: vcEngine,
      localId: vcLocalId,
      apiProvider: vcApiProvider,
      apiVoice: vcApiVoice,
    });
    setVcSavedAt(Date.now());
  }, [companionId, vcEngine, vcLocalId, vcApiProvider, vcApiVoice]);

  const resetToGlobal = useCallback(async () => {
    await clearVoiceFor(companionId);
    setVcEngine('default');
    // Reload effective values from globals.
    const cfg = await loadVoiceFor(companionId);
    setVcLocalId(cfg.localId);
    setVcApiProvider(cfg.apiProvider);
    setVcApiVoice(cfg.apiVoice);
    setVcSavedAt(Date.now());
  }, [companionId]);

  // v3.7.2: save the per-companion silence timeout.
  // Writes the per-companion key via saveSilenceMs in
  // VoiceSettings (the v3.7.1 global key is read-only
  // fallback, not written here).
  // v3.7.3: also push the silence value to the desktop on
  // every save, so the per-companion value lives in
  // companion-settings.json on the desktop side too. A phone
  // reinstall recovers the value from the desktop on auth
  // (companion_settings_sync replay). The local AsyncStorage
  // write is still the source of truth on the phone (it runs
  // the voice-mode loop); the push is for cross-device
  // consistency, not for the phone's runtime behaviour.
  const saveSilence = useCallback(async () => {
    if (!vcSilenceLoadedRef.current) return;
    await saveSilenceMs(companionId, vcSilenceMs);
    // Push to desktop if connected. Best-effort — if the
    // desktop is offline, the local save still works and
    // the value will sync on next connect (the desktop
    // doesn't yet send the value back to a phone that
    // missed a push, so the phone will keep its local
    // value as truth until the user changes it again).
    if (syncClient?.connected) {
      syncClient.setCompanionSilence(companionId, vcSilenceMs);
    }
    setVcSilenceSavedAt(Date.now());
  }, [companionId, vcSilenceMs]);

  // Hardware back handler — chain through phases
  useEffect(() => {
    const bh = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showOwwTrainer) { setShowOwwTrainer(false); return true; }
      if (showExitPhraseTrainer) { setShowExitPhraseTrainer(false); return true; }
      if (companionViewPhase) { setCompanionViewPhase(null); return true; }
      onBack();
      return true;
    });
    return () => bh.remove();
  }, [onBack, showOwwTrainer, showExitPhraseTrainer, companionViewPhase]);

  // v3.4.4: back out if the active companionId is
  // missing from a populated cache. Idempotent via
  // hasAutoBackedRef so re-renders don't loop onBack.
  useEffect(() => {
    if (
      availableCompanions.length > 0 &&
      !availableCompanions.find(c => c.id === companionId)
    ) {
      if (!hasAutoBackedRef.current) {
        hasAutoBackedRef.current = true;
        onBack();
      }
    }
  }, [availableCompanions, companionId, onBack]);

  // Resolve companionId → companion object. If stale
  // (deleted from cache) show a placeholder while the
  // effect above fires onBack().
  const companion = availableCompanions.find(c => c.id === companionId);
  if (!companion) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Companion</Text>
          <View style={{ width: 60 }} />
        </View>
      </View>
    );
  }

  // Dispatch
  if (companionViewPhase === 'wake') {
    return renderCompanionWakePage(companion);
  }
  if (companionViewPhase === 'exit') {
    return renderCompanionExitPage(companion);
  }
  if (companionViewPhase === 'voice') {
    return renderCompanionVoicePage(companion);
  }
  if (companionViewPhase === 'quests') {
    return renderCompanionQuestsPage(companion);
  }
  return renderCompanionOverview(companion);

  // Overview (cards)
  function renderCompanionOverview(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity onPress={onBack} style={styles.detailBackBtn}>
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              {companion.emoji || companion.icon || '🐾'}  {companion.name}
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{companion.name} settings</Text>
            <Text style={styles.sectionDesc}>
              Wake word, exit phrase, greeting, and reply for {companion.name}.
            </Text>
            <Hint>Tap a card to open its settings.</Hint>

            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#3b82f6' }]}
              onPress={() => setCompanionViewPhase('wake')}
            >
              <Text style={styles.phaseCardEmoji}>🎤</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Wake settings</Text>
                <Text style={styles.phaseCardSub}>
                  Greeting, trained wake words, train a new wake phrase
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#f7931a' }]}
              onPress={() => setCompanionViewPhase('exit')}
            >
              <Text style={styles.phaseCardEmoji}>🚪</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Exit settings</Text>
                <Text style={styles.phaseCardSub}>
                  Exit reply, trained exit phrases, train a new exit phrase
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

            {/* v3.7.0: per-companion Voice settings. Engine +
                voice picker. Gated on the global "✨ Enable API
                speech" master toggle when Premium API is
                selected (falls back to Local). API keys are
                global, shared across all companions. */}
            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#10b981' }]}
              onPress={() => setCompanionViewPhase('voice')}
            >
              <Text style={styles.phaseCardEmoji}>🔊</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Voice settings</Text>
                <Text style={styles.phaseCardSub}>
                  Engine (Local / Premium API) and voice for {companion.name}
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

            {/* v3.1.95: quest list mirror (read-only). The
                desktop owns quest CRUD, but we want the
                companion tab to see what's on the desktop
                — active quest glows, project path on each
                row, goal progress. */}
            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#a855f7' }]}
              onPress={() => setCompanionViewPhase('quests')}
            >
              <Text style={styles.phaseCardEmoji}>📜</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Quests</Text>
                <Text style={styles.phaseCardSub}>
                  {(questsByCompanion[companion.id] || []).length === 0
                    ? 'No quests on the desktop yet'
                    : `${(questsByCompanion[companion.id] || []).length} quest(s) from the desktop — read-only`}
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // v3.1.95: read-only quest list mirror. Same
  // fullscreen-screen pattern as renderCompanionWakePage and
  // renderCompanionExitPage — back button returns to the
  // companion overview. Pure render function: hooks live at
  // the screen level (state + useEffect) so the phase
  // dispatch can swap render-functions safely without
  // tripping React's hook-order invariant.
  function renderCompanionQuestsPage(companion: Companion) {
    const quests: CompanionQuest[] = questsByCompanion[companion.id] || [];
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              {companion.emoji || companion.icon || '🐾'}  Quests
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Active quests</Text>
            <Text style={styles.sectionDesc}>
              Synced read-only from the desktop's Quests panel.
              Edit / add / delete on the desktop; the phone updates automatically.
            </Text>
            <Hint>Tap a card to copy the project path to clipboard.</Hint>

            {quests.length === 0 ? (
              <View style={styles.emptyHintBox}>
                <Text style={styles.emptyHintText}>
                  No quests yet. Create one on the desktop in the 📜 Quests panel.
                </Text>
              </View>
            ) : (
              quests
                // Active first, then completed (matches desktop sort)
                .slice()
                .sort((a, b) => {
                  if (a.status === 'active' && b.status !== 'active') return -1;
                  if (a.status !== 'active' && b.status === 'active') return 1;
                  return 0;
                })
                .map((q) => {
                  const isComplete = q.status === 'completed';
                  const goals = Array.isArray(q.goals) ? q.goals : [];
                  const done = goals.filter(g => g.completed).length;
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
                          const { Clipboard } = require('react-native');
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

  function renderCompanionWakePage(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🎤  {companion.name} — Wake
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Wake settings</Text>
            <Text style={styles.sectionDesc}>
              Greeting and trained wake words for {companion.name}.
            </Text>

            <SubTitle>Wake greeting</SubTitle>
            <Hint>Phrase the companion says when the wake word fires. Auto-saves as you type.</Hint>
            <TextInput
              style={styles.input}
              value={readyPhrase}
              onChangeText={(v) => { setReadyPhrase(v); persistReadyPhrase(v); }}
              onBlur={() => AsyncStorage.setItem('cyberclaw-ready-phrase', readyPhrase).then(() => setReadyPhraseSavedAt(Date.now()))}
              placeholder="Ready to chat"
              placeholderTextColor="#555"
              returnKeyType="done"
            />
            {readyPhraseSavedAt && (
              <Text style={styles.savedHint}>✅ Saved at {new Date(readyPhraseSavedAt).toLocaleTimeString()}</Text>
            )}

            <SubTitle>Wake phrases</SubTitle>
            <Hint>Trained wake words for {companion.name}. Tap 🎙 to retrain, 🗑 to delete.</Hint>
            <WakePhrasePicker
              companions={[companion]}
              savedModels={savedWakeModels}
              activeCompanionId={activeWakeCompanionId}
              onSelect={(selectedCid) => {
                setActiveWakeCompanionId(selectedCid);
                AsyncStorage.setItem('cyberclaw-active-wake-companion', selectedCid);
                const entry = savedWakeModels[selectedCid];
                if (entry?.phrase) {
                  AsyncStorage.getItem('cyberclaw-audio-settings').then(raw => {
                    const settings = raw ? JSON.parse(raw) : {};
                    settings.wakeWord = entry.phrase;
                    AsyncStorage.setItem('cyberclaw-audio-settings', JSON.stringify(settings));
                  });
                }
              }}
              onRetrain={(rcid, phrase) => {
                setTrainingCompanionId(rcid);
                setTrainingCompanionName(companion.name);
                setEditingWakePhrase(phrase);
                setShowOwwTrainer(true);
              }}
              onDelete={(rcid) => {
                Alert.alert(
                  'Delete wake model?',
                  `Removes the trained wake word for ${companion.name}. You can re-train it later.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await AsyncStorage.removeItem(`cyberclaw-wake-samples-${rcid}`);
                          setSavedWakeModels(prev => {
                            const next = { ...prev };
                            delete next[rcid];
                            return next;
                          });
                          if (activeWakeCompanionId === rcid) {
                            setActiveWakeCompanionId(null);
                            await AsyncStorage.removeItem('cyberclaw-active-wake-companion');
                          }
                        } catch (_) {}
                      },
                    },
                  ],
                );
              }}
            />
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6' }]}
              onPress={() => {
                setTrainingCompanionId(companion.id);
                setTrainingCompanionName(companion.name);
                setEditingWakePhrase('');
                setShowOwwTrainer(true);
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>🎤 Train new wake phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record 6 samples — desktop trains a custom neural wake word</Text>
            </TouchableOpacity>
          </View>

          {showOwwTrainer && trainingCompanionId ? (
            <OpenWakeWordTrainer
              companionId={trainingCompanionId}
              companionName={trainingCompanionName}
              presetPhrase={editingWakePhrase}
              onClose={() => setShowOwwTrainer(false)}
            />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  function renderCompanionExitPage(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🚪  {companion.name} — Exit
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Exit settings</Text>
            <Text style={styles.sectionDesc}>
              Exit reply and trained exit phrases for {companion.name}.
            </Text>

            <SubTitle>Exit reply</SubTitle>
            <Hint>Phrase the companion says when voice mode closes. Empty for silent close.</Hint>
            <TextInput
              style={styles.input}
              value={exitReplyPhrase}
              onChangeText={(v) => { setExitReplyPhrase(v); persistExitReplyPhrase(v); }}
              onBlur={() => AsyncStorage.setItem('cyberclaw-exit-reply-phrase', exitReplyPhrase).then(() => setExitReplySavedAt(Date.now()))}
              placeholder="Goodbye!"
              placeholderTextColor="#555"
              returnKeyType="done"
            />
            {exitReplySavedAt && exitReplyPhrase && (
              <Text style={styles.savedHint}>✅ Saved at {new Date(exitReplySavedAt).toLocaleTimeString()}</Text>
            )}

            <SubTitle>Exit phrases</SubTitle>
            <Hint>Trained phrases that close voice mode when {companion.name} hears them. Tap 🎙 to retrain, 🗑 to delete.</Hint>
            <PerCompanionExitPicker
              companionId={companion.id}
              activePhrase={voiceExitPhrase}
              onSelect={async (p) => {
                setVoiceExitPhrase(p);
                const { saveExitPhrase } = await import('../services/VoiceSettings');
                await saveExitPhrase(companion.id, p);
                setVoiceExitPhraseSavedAt(Date.now());
              }}
              onRetrain={(p) => {
                setEditingExitPhrase(p);
                setShowExitPhraseTrainer(true);
              }}
              onDelete={async (p) => {
                Alert.alert(
                  'Delete exit phrase?',
                  `Removes the trained samples for "${p}" on ${companion.name}.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        const { clearExitSamples, saveExitPhrase } = await import('../services/VoiceSettings');
                        await clearExitSamples(companion.id, p);
                        if (voiceExitPhrase.toLowerCase() === p.toLowerCase()) {
                          setVoiceExitPhrase('');
                          await saveExitPhrase(companion.id, '');
                        }
                      },
                    },
                  ],
                );
              }}
            />
            {voiceExitPhraseSavedAt && voiceExitPhrase && (
              <Text style={styles.savedHint}>✅ Active: "{voiceExitPhrase}" saved</Text>
            )}
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#f7931a' }]}
              onPress={() => {
                setEditingExitPhrase('');
                setShowExitPhraseTrainer(true);
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#f7931a' }]}>🚪 Train new exit phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record a short phrase 6 times — closes voice mode instantly when heard</Text>
            </TouchableOpacity>
          </View>

          {showExitPhraseTrainer ? (
            <ExitPhraseTrainer
              companionId={companion.id}
              companionName={companion.name}
              presetPhrase={editingExitPhrase}
              onClose={() => setShowExitPhraseTrainer(false)}
            />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // v3.7.0: per-companion voice settings sub-page. v3.7.1:
  // this is now a pure render function — all state lives at
  // the screen level (next to the wake/exit state). The
  // dispatch at the top of the screen picks one of the four
  // render-functions per render; previously only this one
  // had hooks, which broke React's hook accounting when the
  // user navigated away.
  function renderCompanionVoicePage(companion: Companion) {
    // Resolve the effective engine for the "what would actually
    // be used right now?" status row.
    const effectiveEngine: 'local' | 'api' =
      vcEngine === 'default'
        ? (vcGlobalApiEnabled ? 'api' : 'local')
        : vcEngine;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🔊  {companion.name} — Voice
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Voice settings</Text>
            <Text style={styles.sectionDesc}>
              How {companion.name} speaks back to you. Per-companion override
              of the global voice engine and voice choice.
            </Text>

            <SubTitle>Engine</SubTitle>
            <Hint>📱 Local uses the device's Android TTS engine (free, offline). ✨ Premium API uses cloud voices (ElevenLabs / Google Cloud TTS) — requires the global 🔑 API keys setup and the ✨ API speech master toggle to be on.</Hint>
            <View style={{ marginVertical: 6 }}>
              <TouchableOpacity
                onPress={() => setVcEngine('default')}
                style={[styles.radioRow, vcEngine === 'default' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'default' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>🌐 Use global default</Text>
                  <Text style={styles.radioSub}>Inherit whatever the global master is set to right now.</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setVcEngine('local')}
                style={[styles.radioRow, vcEngine === 'local' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'local' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>📱 Local (free)</Text>
                  <Text style={styles.radioSub}>Android TTS, always available.</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => vcGlobalApiEnabled && setVcEngine('api')}
                disabled={!vcGlobalApiEnabled}
                style={[
                  styles.radioRow,
                  vcEngine === 'api' && styles.radioRowActive,
                  !vcGlobalApiEnabled && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'api' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>✨ Premium API</Text>
                  <Text style={styles.radioSub}>
                    {vcGlobalApiEnabled
                      ? 'Cloud TTS (ElevenLabs / Google). Uses the global API key.'
                      : 'Disabled — turn on ✨ API speech in the global 🔑 API keys section first.'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {effectiveEngine === 'local' ? (
              <>
                <SubTitle>Local voice</SubTitle>
                <View style={{ marginVertical: 6 }}>
                  {LOCAL_VOICES.map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => setVcLocalId(v.id)}
                      style={[styles.radioRow, vcLocalId === v.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcLocalId === v.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{v.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : (
              <>
                <SubTitle>Premium API voice</SubTitle>
                <Hint>Provider and voice for {companion.name}.</Hint>
                <View style={{ marginVertical: 6 }}>
                  {PREMIUM_PROVIDERS.map(p => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => setVcApiProvider(p.id)}
                      style={[styles.radioRow, vcApiProvider === p.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcApiProvider === p.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <SubTitle>Voice</SubTitle>
                <View style={{ marginVertical: 6 }}>
                  {PREMIUM_PROVIDERS.find(p => p.id === vcApiProvider)?.voices.map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => setVcApiVoice(v.id)}
                      style={[styles.radioRow, vcApiVoice === v.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcApiVoice === v.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{v.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            {/* v3.7.2: silence-to-end-turn picker. Moved here
                from the global Wake listening section. Per-
                companion: a chatty companion can have a
                longer silence window than a terse one.
                Default 5s; clamped to [2,10]s by
                saveSilenceMs. The "Save silence" button is
                separate from the voice Save button so the
                user can change one without committing the
                other (matches the existing wake/exit
                pattern). */}
            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <SubTitle>Silence to end turn: {vcSilenceMs / 1000}s</SubTitle>
            <Hint>Voice mode stays open in a multi-turn loop. After this much silence, the turn ends and the companion returns to passive wake-word listening.</Hint>
            <View style={{ marginVertical: 6 }}>
              {[2, 3, 5, 7, 10].map(s => (
                <TouchableOpacity
                  key={s}
                  onPress={() => setVcSilenceMs(s * 1000)}
                  style={[styles.radioRow, vcSilenceMs === s * 1000 && styles.radioRowActive]}
                >
                  <Text style={styles.radioBullet}>{vcSilenceMs === s * 1000 ? '◉' : '○'}</Text>
                  <Text style={[styles.radioTitle, { flex: 1 }]}>{s}s</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#10b981', marginTop: 6 }]}
              onPress={saveSilence}
            >
              <Text style={[styles.trainBtnText, { color: '#10b981' }]}>
                {vcSilenceSavedAt
                  ? `✅ Silence saved at ${new Date(vcSilenceSavedAt).toLocaleTimeString()}`
                  : '💾 Save silence setting'}
              </Text>
            </TouchableOpacity>

            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <Hint>
              Currently: <Text style={{ color: '#10b981', fontWeight: '600' }}>{effectiveEngine === 'api' ? 'Premium API' : 'Local'}</Text>
              {effectiveEngine === 'local' && ` — ${LOCAL_VOICES.find(v => v.id === vcLocalId)?.label || vcLocalId}`}
              {effectiveEngine === 'api' && ` — ${vcApiProvider} / ${vcApiVoice}`}
            </Hint>

            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#10b981', marginTop: 12 }]}
              onPress={saveVoice}
            >
              <Text style={[styles.trainBtnText, { color: '#10b981' }]}>
                {vcSavedAt
                  ? `✅ Saved at ${new Date(vcSavedAt).toLocaleTimeString()}`
                  : '💾 Save voice settings'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#666', marginTop: 6 }]}
              onPress={resetToGlobal}
            >
              <Text style={[styles.trainBtnText, { color: '#888' }]}>
                🔄 Reset to global default
              </Text>
              <Text style={styles.trainBtnSub}>
                Clears the per-companion override for {companion.name}.
              </Text>
            </TouchableOpacity>

            {/* v3.7.1: Test buttons. Moved from the global
                Settings screen (whose Voice & Speech section
                is gone) so the user can test a companion's
                voice after picking it. "Test local voice on
                phone" plays through the device's Android TTS
                engine. "Test voice on desktop" sends a
                speak action via the SyncClient to the
                companion's desktop. */}
            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <SubTitle>Test</SubTitle>
            <Hint>Try the picked voice out before saving. The desktop test uses the companion's currently-active voice on the desktop side.</Hint>
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6', marginTop: 8 }]}
              onPress={testLocalVoice}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>
                🔊 Test local voice on phone
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6', marginTop: 6 }]}
              onPress={testDesktopVoice}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>
                🖥️ Test voice on desktop
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }
}

// ── Inline UI helpers ──────────────────────────────────────
// (Lifted from SettingsScreen to keep this file self-contained.)

function SubTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.subGroupTitle}>{children}</Text>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

function WakePhrasePicker({
  companions,
  savedModels,
  activeCompanionId,
  onSelect,
  onRetrain,
  onDelete,
}: {
  companions: Companion[];
  savedModels: Record<string, { phrase: string; path: string; savedAt: number }>;
  activeCompanionId: string | null;
  onSelect: (companionId: string) => void;
  onRetrain: (companionId: string, phrase: string) => void;
  onDelete: (companionId: string) => void;
}) {
  const trainedRows = companions
    .filter(c => savedModels[c.id]?.phrase)
    .map(c => ({
      companionId: c.id,
      name: c.name,
      emoji: c.emoji || c.icon || '🐾',
      phrase: savedModels[c.id].phrase,
      savedAt: savedModels[c.id].savedAt,
    }));

  if (trainedRows.length === 0) {
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          No trained wake phrases yet. Tap "Train new wake phrase for {companions[0]?.name || 'this companion'}" below to record 6 samples.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.trainedPicker}>
      {trainedRows.map(r => {
        const active = activeCompanionId === r.companionId;
        return (
          <TouchableOpacity
            key={r.companionId}
            style={[styles.trainedPickerRow, active && styles.trainedPickerRowActive]}
            onPress={() => onSelect(r.companionId)}
          >
            <Text style={[styles.trainedPickerRadio, active && styles.trainedPickerRadioActive]}>
              {active ? '◉' : '◯'}
            </Text>
            <Text style={[styles.trainedPickerCompanionEmoji]}>{r.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.trainedPickerLabel, active && styles.trainedPickerLabelActive]}>
                {r.name}
              </Text>
              <Text style={styles.trainedPickerPhrase}>
                {r.phrase}
              </Text>
            </View>
            <View style={styles.trainedPickerActions}>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); onRetrain(r.companionId, r.phrase); }}
                style={styles.trainedPickerActionBtn}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Text style={styles.trainedPickerActionIcon}>🎙</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); onDelete(r.companionId); }}
                style={styles.trainedPickerActionBtn}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Text style={styles.trainedPickerActionIcon}>🗑</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        );
      })}
      {!activeCompanionId && trainedRows.length > 0 ? (
        <Text style={[styles.trainedPickerBadge, { marginTop: 6, alignSelf: 'flex-start' }]}>
          Tap a row to activate
        </Text>
      ) : null}
    </View>
  );
}

function PerCompanionExitPicker({ companionId, activePhrase, onSelect, onRetrain, onDelete }: {
  companionId: string;
  activePhrase: string;
  onSelect: (p: string) => void;
  onRetrain?: (p: string) => void;
  onDelete?: (p: string) => void;
}) {
  const [phrases, setPhrases] = useState<string[]>([]);
  const reload = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const prefix = `cyberclaw-exit-samples-${companionId}-`;
      const exitKeys = keys.filter(k => k.startsWith(prefix));
      const list = exitKeys.map(k =>
        k.replace(prefix, '').replace(/-/g, ' ')
      );
      setPhrases(list);
    } catch (_) {}
  }, [companionId]);
  useEffect(() => { reload(); }, [reload, activePhrase]);

  if (phrases.length === 0) {
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          No trained exit phrases yet. Tap "Train new exit phrase" below to record 6 samples.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.trainedPicker}>
      {phrases.map(p => {
        const active = activePhrase === p;
        return (
          <TouchableOpacity
            key={p}
            style={[styles.trainedPickerRow, active && styles.trainedPickerRowActive]}
            onPress={() => onSelect(p)}
          >
            <Text style={[styles.trainedPickerRadio, active && styles.trainedPickerRadioActive]}>
              {active ? '◉' : '◯'}
            </Text>
            <Text style={[styles.trainedPickerLabel, active && styles.trainedPickerLabelActive]}>
              {p}
            </Text>
            <View style={styles.trainedPickerActions}>
              {onRetrain ? (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); onRetrain(p); }}
                  style={styles.trainedPickerActionBtn}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Text style={styles.trainedPickerActionIcon}>🎙</Text>
                </TouchableOpacity>
              ) : null}
              {onDelete ? (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); onDelete(p); }}
                  style={styles.trainedPickerActionBtn}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Text style={styles.trainedPickerActionIcon}>🗑</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// v3.7.1: Test voice helpers, moved here from SettingsScreen
// (the global Voice & Speech section is gone). The Test
// buttons in the per-companion Voice sub-page call these.
// Both are module-level so they aren't recreated on every
// render and don't take any state — they just trigger TTS
// on the Android engine (local) or via the WebView's
// speechSynthesis (desktop).

/** Test the local Android TTS engine with a fixed phrase.
 *  Doesn't read the per-companion voice id — the Android
 *  TTS engine picks the voice from the system default
 *  (the per-companion "local voice" choice is forward-
 *  looking; the TTS layer doesn't read it yet). The test
 *  still confirms the engine is installed and working.
 *
 *  v3.1.90: probes for a TTS engine before speaking so
 *  we can offer to install Google TTS / eSpeak NG if
 *  missing. */
function testLocalVoice() {
  const phrase = 'Ready to chat. The boar is happy.';
  const wm = (NativeModules as any).WakeWordModule;
  if (!wm?.speakText) {
    Alert.alert('TTS unavailable', 'WakeWordModule not available.');
    return;
  }
  const tryInstall = () => {
    if (wm?.installTtsData) {
      wm.installTtsData().catch(() => {});
    }
  };
  if (wm?.hasTtsEngine) {
    wm.hasTtsEngine()
      .then((hasEngine: boolean) => {
        if (!hasEngine) {
          Alert.alert(
            'No TTS engine installed',
            'CyberClaw needs a Text-to-Speech engine for voice greetings. Install Google TTS or eSpeak NG?',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Install', onPress: tryInstall },
            ],
          );
          return;
        }
        wm.speakText(phrase).catch(() => {
          Alert.alert('TTS init failed', 'Engine is installed but failed to initialise. Try installing voice data in Android Settings → Accessibility → Text-to-speech output.');
        });
      })
      .catch(() => {
        wm.speakText(phrase).catch(() => {
          Alert.alert('TTS unavailable', 'Your device has no Text-to-Speech engine installed.');
        });
      });
  } else {
    wm.speakText(phrase).catch(() => {
      Alert.alert('TTS unavailable', 'Your device has no Text-to-Speech engine installed.');
    });
  }
}

/** Test the desktop's WebView speechSynthesis with a
 *  fixed phrase. Sends an eval_js action via the
 *  SyncClient to the desktop, which then speaks the
 *  phrase in the active companion's voice. */
function testDesktopVoice() {
  const phrase = 'Tobe is the coolest and most handsome man on the planet';
  const escaped = phrase.replace(/'/g, "\\'");
  syncClient.sendCompanionAction({
    type: 'eval_js',
    script: `
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance('${escaped}');
        u.rate = 0.95; u.pitch = 1.0;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      }
      true;
    `,
  });
  Alert.alert('🔊 Sent to desktop', 'The desktop should speak the test phrase.');
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  // v3.4.5: bumped paddingTop from 16 → 50 on BOTH Android
  // and iOS. Tobe's screenshot showed the section still
  // flush against the status bar even after the first
  // bump — the device was actually an iPhone (Dynamic
  // Island in the status bar) so the iOS=10 path was
  // insufficient. 50pt clears both Android status bars
  // (~30-40dp) and iOS Dynamic Island (~30pt + safe area).
  // SafeAreaView in App.tsx handles the iOS bottom inset
  // but the ScrollView still needs explicit top padding
  // because the SafeAreaView's top extends to the top of
  // the device edge — we want the scroll to start below
  // the status bar.
  scroll: { padding: 16, paddingTop: 50, paddingBottom: 60 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, paddingTop: Platform.OS === 'android' ? 34 : 10 },
  backBtn: { paddingVertical: 4, paddingRight: 12 },
  backBtnText: { color: '#f7931a', fontSize: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginLeft: 16 },
  section: { backgroundColor: '#111', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#f7931a' },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  sectionDesc: { color: '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  // v3.1.95: quest-card styles for the read-only mobile mirror.
  // Mirrors the desktop's .quest-card look-and-feel (purple
  // accent, green for completed, dimmed if completed, progress
  // bar across the bottom).
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
  subGroupTitle: { color: '#aaa', fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12, letterSpacing: 0.5 },
  hint: { color: '#666', fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 },
  savedHint: { color: '#4caf50', fontSize: 12, marginTop: 6 },
  input: { backgroundColor: '#1a1a2e', color: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 16, borderWidth: 1, borderColor: '#333' },
  trainedPicker: { marginTop: 8 },
  trainedPickerHint: { marginTop: 8, paddingVertical: 8 },
  trainedPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 6,
  },
  trainedPickerRowActive: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: '#10b981',
  },
  trainedPickerRadio: { color: '#666', fontSize: 18, marginRight: 10 },
  trainedPickerRadioActive: { color: '#10b981' },
  trainedPickerLabel: { color: '#fff', fontSize: 14, flex: 1 },
  trainedPickerLabelActive: { fontWeight: '700' },
  trainedPickerBadge: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(16,185,129,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  trainedPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
  },
  trainedPickerActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(247,147,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.30)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  trainedPickerActionIcon: { fontSize: 16 },
  trainedPickerCompanionEmoji: { fontSize: 22, marginRight: 10 },
  trainedPickerPhrase: { color: '#aaa', fontSize: 12, marginTop: 1, fontStyle: 'italic' },
  phaseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginVertical: 6,
    gap: 12,
  },
  phaseCardEmoji: { fontSize: 28 },
  phaseCardTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  phaseCardSub: { color: '#9aa0b4', fontSize: 12, marginTop: 3 },
  phaseCardArrow: { color: '#888', fontSize: 24, marginLeft: 4 },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  trainBtn: {
    borderWidth: 2,
    borderRadius: 12,
    borderStyle: 'dashed',
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: 'transparent',
  },
  trainBtnText: { fontSize: 15, fontWeight: '600' },
  trainBtnSub: { color: '#888', fontSize: 11, marginTop: 4 },
  // v3.7.0: radio-style row for the per-companion voice picker.
  // Reused for engine (Use global default / Local / Premium API)
  // and for the voice lists under each engine.
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1626',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#222',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginVertical: 3,
    gap: 10,
  },
  radioRowActive: { borderColor: '#10b981', backgroundColor: '#102a22' },
  radioBullet: { color: '#10b981', fontSize: 18, width: 18, textAlign: 'center' },
  radioTitle: { color: '#fff', fontSize: 15, fontWeight: '500' },
  radioSub: { color: '#9aa0b4', fontSize: 12, marginTop: 2 },
});