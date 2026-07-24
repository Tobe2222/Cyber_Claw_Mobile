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
  AppState,
} from 'react-native';
const { WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
// v3.10.0: OpenWakeWordTrainer / ExitPhraseTrainer /
// WakeSetManagerScreen are now rendered as full-screen
// routes by App.tsx (pushed via onPushWakeTrainer /
// onPushExitTrainer / onPushWakeManager). This file no
// longer imports them — only their trigger buttons
// remain.
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
// v3.10.25: shared "Test wake" panel (the wake page
// also uses the hook internally — the wake panel
// here renders the standard layout).
// v3.10.26: NAMED import, not default. The component
// is `export function ClassifierTestPanel(...)` with
// no default export.
import { ClassifierTestPanel, useClassifierTest } from '../components/ClassifierTest';

// v3.10.66: removed — speaker enrollment moved to global
// Settings screen 🎙️ Voice mode section. The import is no
// longer needed here.// v3.7.1: syncClient for the desktop "Test voice" button.
import syncClient from '../services/SyncClient';
// v3.10.23: addLogEntry import removed. The speaker-enrollment
// callbacks that referenced it (v3.10.19/v3.10.21) are gone in
// the v3.10.23 refactor (passive global profile, no UI). If a
// future feature here needs log output, prefer lifting
// addLogEntry / syncLog / logListeners to a shared
// src/services/LogStore.ts (same shape as SyncClient.ts) so
// screens don't cross-import each other for log calls.

type Companion = {
  id: string;
  name: string;
  emoji?: string | null;
  icon?: string | null;
};

export default function CompanionSettingsScreen({
  companionId,
  onBack,
  // v3.10.0: push-callbacks for trainer / manager /
  // exit-trainer sub-routes. Lifted to App.tsx as full
  // screens instead of inline expanded panels inside
  // this screen. Tobe: "Manage and Train buttons should
  // really open new pages rather than expanding down the
  // current. This should be the case for exit also."
  onPushWakeTrainer,
  onPushWakeManager,
  onPushExitTrainer,
  // v3.10.92: open the Personalize screen for the
  // companion. Lifted to App.tsx as a full-screen route
  // (mirrors the desktop's Companion Forge on mobile).
  onOpenCompanionEdit,
}: {
  companionId: string;
  onBack: () => void;
  onPushWakeTrainer: (ctx: { companionId: string; companionName: string; presetPhrase?: string }) => void;
  onPushWakeManager: (ctx: { companionId: string; companionName: string }) => void;
  onPushExitTrainer: (ctx: { companionId: string; companionName: string; presetPhrase?: string }) => void;
  onOpenCompanionEdit?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
}) {
  // v3.4.4: drill-down phase inside the companion
  // detail view. null = overview (cards). 'wake' / 'exit'
  // = sub-page for that phase.
  // v3.7.0: 'voice' added — per-companion voice engine +
  // voice picker (Local / Premium API / Use global default).
  // v3.7.6: 'quests' removed — Quests is now a top-level
  // screen (QuestsScreen.tsx) accessed from the arena button.
  const [companionViewPhase, setCompanionViewPhase] = useState<'wake' | 'exit' | 'voice' | null>(null);

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

  // v3.7.6: Quests moved out to QuestsScreen.tsx (top-level,
  // not per-companion). The per-companion cache keying added
  // in v3.7.4 was speculative for "future per-companion
  // divergence" that hasn't materialised. Re-introduce per-
  // companion keying here when the desktop models per-
  // companion quest assignment.

  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }>>({});

  // v3.10.5: direct active-wake-phrase lookup. Single
  // source of truth for the Wake card status line + the
  // Wake sub-page's "Currently active" panel.
  //
  // Why this exists: the v3.10.4 merge of
  // getSavedWakeModels + listWakeSets still misses the
  // active wake when the JS companionId doesn't strictly
  // match `meta.agentId` in some edge case (e.g. agentId
  // casing diff, or the set was trained before the JS
  // companionId was renamed by a desktop sync). The
  // merge filter `e.agentId === c.id` then returns zero
  // candidates and the card shows the misleading
  // fallback even though the manager shows ✓ Active.
  //
  // getActiveWakeSet(c.id) is the canonical "what's
  // currently active for this companion?" call — it's
  // a single SharedPreferences read of `active_<agentId>`,
  // the exact same key the Wake Manager reads. If it
  // returns a setId, we have an active wake; if null,
  // we don't. Then listWakeSets gives us the metadata
  // for that setId (phrase, displayName, path).
  //
  // We keep this as a SEPARATE piece of state (not
  // merged into savedWakeModels) so the UI displays the
  // canonical truth directly, and so a merge bug in
  // savedWakeModels can't mask the active binding.
  const [activeWakeDirect, setActiveWakeDirect] = useState<{
    setId: string;
    phrase: string;
    displayName?: string;
    path?: string;
  } | null>(null);

// v3.10.25: 'Test wake' was extracted into a shared
  // useClassifierTest hook. The wake sub-page now
  // renders <ClassifierTestPanel kind='wake'
  // wakeword={activeWakeDirect?.phrase} /> directly
  // (see below). The companion-level hook here was
  // REMOVED in v3.10.52 because it shadowed the
  // panel's hook and produced an unused
  // handleTestWake function. The shadowing was the
  // root cause of the v3.10.50 'Loaded model:
  // hey_jarvis' diagnostic — the panel called the
  // hook without options, so the test path's initOww
  // was never invoked. The companion-level hook had
  // the right options but wasn't wired to the panel's
  // button. Both fixed by deleting the companion-level
  // call and threading wakeword through the panel's
  // own props.

  // v3.10.23: speaker enrollment was removed from
  // CompanionSettingsScreen. The user voice profile
  // is now a SINGLE GLOBAL thing that the OWW
  // detector learns passively in the background
  // (no button, no progress bar, no per-companion
  // state). The native side auto-locks the profile
  // after enough voice-active samples or confirmed
  // wake-fires and gates wake detection on speaker
  // match. Tobe's v3.10.23 direction: "lift it out
  // entirely, learn from conversation, independent
  // of companions, no opt-in button".
  //
  // All state and callbacks previously here were
  // for v3.10.19/v3.10.21 per-companion enrollment.
  // They're gone. CompanionSettingsScreen has no
  // awareness of the speaker profile.
  //
  // If the user wants to inspect / forget the
  // profile, that's a debug surface that would live
  // in global Voice mode settings (not per-companion).
  // Not in scope for v3.10.23.
  //
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      // v3.10.5: only fetch when we know which
      // companion we're showing. The companion
      // object is resolved from availableCompanions,
      // which hydrates from cyberclaw-agents-cache
      // on mount — companion may be undefined on
      // the first render until that hydration
      // completes. Skip in that case; the effect
      // re-runs when availableCompanions changes.
      if (!companion) {
        setActiveWakeDirect(null);
        return;
      }
      try {
        const WakeWordModule = require('react-native').NativeModules.WakeWordModule;
        const activeSetId = await WakeWordModule?.getActiveWakeSet?.(companion.id);
        if (cancelled) return;
        if (!activeSetId) {
          setActiveWakeDirect(null);
          return;
        }
        // Look up the set's metadata in listWakeSets so
        // we can show phrase / displayName / path. If
        // listWakeSets fails or doesn't include this set
        // (it should — the manager just wrote the binding),
        // fall back to a minimal record so the UI can at
        // least show the setId.
        let meta: any = null;
        try {
          const allSets = await WakeWordModule?.listWakeSets?.();
          if (allSets && typeof allSets === 'object') {
            meta = allSets[activeSetId] || null;
          }
        } catch (_) {}
        if (cancelled) return;
        if (meta && meta.phrase) {
          setActiveWakeDirect({
            setId: activeSetId,
            phrase: meta.phrase,
            displayName: meta.displayName || meta.phrase,
            path: meta.path || `wake_models/${activeSetId}/model.tflite`,
          });
        } else {
          // Active binding exists but we couldn't read
          // the meta. Show a degraded entry so the user
          // sees "Active: <setId>" rather than nothing.
          setActiveWakeDirect({
            setId: activeSetId,
            phrase: activeSetId,
          });
        }
      } catch (_) {
        // Best-effort. Don't overwrite with null on a
        // transient failure — let the previous value
        // stay so the UI doesn't flicker.
      }
    };
    fetch();
    // Also refetch when the screen comes back to focus
    // (e.g. user returns from the wake manager route,
    // where they may have just activated a different
    // set). AppState 'active' covers the focus event
    // even when the route stack didn't unmount this
    // screen.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [companion?.id, availableCompanions.length]);

  // v3.10.23: per-companion speaker enrollment UI was
  // removed entirely. The profile is now global and
  // passive (handled by the OWW detector's auto-lock).
  // CompanionSettingsScreen has no awareness of speaker
  // enrollment. See the v3.10.23 CHANGES file for the
  // design.

  // v3.10.2: trained-exit-phrase list for the
  // overview card. Lifted to the screen level so
  // the hook rule is honored — renderCompanionOverview
  // is called from a dispatch (not always called),
  // and putting useState/useEffect inside it would
  // break the same-hook-order rule (same v3.7.1
  // bug class that bit voice picker state).
  //
  // CRITICAL: this hook MUST live ABOVE any
  // early-return paths (e.g. `if (!companion)
  // return <placeholder />`) so it's called on
  // every render. In v3.10.1 the state was
  // declared AFTER the `if (!companion)` early
  // return; on the first render the cache hadn't
  // hydrated so the early return fired without
  // the hook, then the cache populated and the
  // hook ran on the second render — different
  // hook counts between renders → "Rendered
  // more hooks than during the previous render"
  // crash. The same rule applies to the resolved
  // `companion` lookup below — never wrap the
  // hook declaration in conditional logic.
  const [trainedExitPhrases, setTrainedExitPhrases] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const prefix = `cyberclaw-exit-samples-${companionId}-`;
        const list = keys
          .filter(k => k.startsWith(prefix))
          .map(k => k.replace(prefix, '').replace(/-/g, ' '));
        setTrainedExitPhrases(list);
      } catch (_) {}
    })();
  }, [companionId]);

  // v3.10.0: trainer + manager + exit-trainer are now
  // full-screen routes in App.tsx, pushed via
  // onPushWakeTrainer / onPushWakeManager /
  // onPushExitTrainer props. The local trainer-modal
  // state below was deleted as part of that refactor;
  // the showOwwTrainer / showWakeSetManager /
  // showExitPhraseTrainer flags and the
  // trainingCompanionId / editingWakePhrase helpers
  // are gone.

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

  // v3.4.4: refresh saved-wake-models whenever the
  // companion list grows or the active companion
  // changes (covers post-training refresh).
  //
  // v3.10.1: also include displayName from the
  // native response (falls back to phrase on
  // legacy meta) so the picker's row title can
  // show the human-friendly name instead of the
  // raw setId / phrase interchangeably. Also
  // refetch on AppState 'active' transition —
  // same reason as SettingsScreen, the picker
  // could be stale when the user returns from
  // the wake manager or trainer route.
  //
  // v3.10.4: bulletproof fetch. Calls
  // `getSavedWakeModels` (active-only filter)
  // AND `listWakeSets` (all sets) and merges.
  // If the active-only filter returns empty for
  // an agent (e.g. active binding is stale / lost
  // / pointing at a deleted set), the fallback
  // picks the most-recent set for that agent. The
  // two previous versions (3.10.1, 3.10.2) only
  // used getSavedWakeModels; Tobe hit a real
  // gap where the manager (listWakeSets) showed
  // an active set but the Settings + Wake
  // Settings sub-page both showed "Not trained"
  // — confirming the active-only filter misses
  // sets the manager sees. The merge gives us
  // the manager's data via a different code path
  // and the active-only filter's data via another;
  // whichever populates first wins.
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const WakeWordModule = require('react-native').NativeModules.WakeWordModule;
        const [savedModels, allSets] = await Promise.all([
          WakeWordModule?.getSavedWakeModels?.().catch(() => null),
          WakeWordModule?.listWakeSets?.().catch(() => null),
        ]);
        if (cancelled) return;
        // Resolve the active setId for every
        // available companion in parallel — these
        // are cheap SharedPreferences reads, so it's
        // safe to fan out rather than serialise in
        // the loop below.
        const activeByCompanion: Record<string, string | null> = {};
        await Promise.all(
          availableCompanions.map(async (c) => {
            try {
              activeByCompanion[c.id] = await WakeWordModule?.getActiveWakeSet?.(c.id);
            } catch (_) {
              activeByCompanion[c.id] = null;
            }
          }),
        );
        if (cancelled) return;
        const out: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }> = {};
        // 1. Seed from getSavedWakeModels (active-only).
        if (savedModels && typeof savedModels === 'object') {
          for (const agentId of Object.keys(savedModels)) {
            const entry = savedModels[agentId];
            if (entry?.phrase && entry?.path) {
              out[agentId] = {
                phrase: entry.phrase,
                displayName: entry.displayName || entry.phrase,
                path: entry.path,
                savedAt: entry.savedAt || 0,
              };
            }
          }
        }
        // 2. Fill gaps from listWakeSets. For each
        // companion in availableCompanions that
        // doesn't have a savedModels entry, look up
        // their active set on the manager. If the
        // agent has any sets, pick the active one
        // (matched via getActiveWakeSet(agentId)),
        // otherwise pick the most-recently-created.
        // Either way, populate out[agentId] so the
        // per-companion page can show "Trained: X"
        // even if the active binding is broken.
        if (allSets && typeof allSets === 'object') {
          for (const c of availableCompanions) {
            if (out[c.id]?.phrase) continue; // already populated
            // listWakeSets returns { setId: entry } where
            // entry.agentId may be null (legacy) or set.
            // Filter to entries that match this companion.
            const candidates = Object.entries(allSets)
              .map(([setId, raw]: [string, any]) => ({ setId, ...raw }))
              .filter((e: any) => !e.agentId || e.agentId === c.id);
            if (candidates.length === 0) continue;
            const activeId = activeByCompanion[c.id];
            const active = candidates.find((e: any) => e.setId === activeId);
            const fallback = [...candidates].sort(
              (a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0),
            )[0];
            const picked = active || fallback;
            if (picked?.phrase) {
              const dirPath = `wake_models/${picked.setId}/model.tflite`;
              out[c.id] = {
                phrase: picked.phrase,
                displayName: picked.displayName || picked.phrase,
                // The path stored by getSavedWakeModels
                // is the absolute on-disk path; for the
                // listWakeSets fallback we don't have
                // the absolute path, but the picker only
                // uses it for "is this row showing?"
                // display, so a relative path works.
                // The trainer / manager still operate
                // off the setId directly.
                path: picked.path || dirPath,
                savedAt: picked.createdAt || 0,
              };
            }
          }
        }
        setSavedWakeModels(out);
      } catch (_) {
        // best-effort. Empty savedWakeModels is fine.
      }
    };
    fetch();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
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
  // v3.10.0: trainer / manager / exit-trainer are now
  // top-level routes in App.tsx, not inline modals.
  // Back button handling is just: drill-down phase →
  // back to overview; otherwise → onBack() to Settings.
  useEffect(() => {
    const bh = BackHandler.addEventListener('hardwareBackPress', () => {
      if (companionViewPhase) { setCompanionViewPhase(null); return true; }
      onBack();
      return true;
    });
    return () => bh.remove();
  }, [onBack, companionViewPhase]);

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

  // v3.10.2: per-companion status lines for the
  // overview cards. Computed after the early
  // return so `companion` is guaranteed to be
  // defined (the dispatch below only runs when
  // we have a companion). The trainedExitPhrases
  // state + effect are at the screen level (above
  // the early return) so this is just derivation.
  const exitStatusLine = trainedExitPhrases.length > 0
    ? `Trained: "${trainedExitPhrases[0]}"`
    : voiceExitPhrase
      ? `Default: "${voiceExitPhrase}"`
      : 'Not set';
  const wakeModel = savedWakeModels[companion.id];
  // v3.10.5: prefer the direct activeWakeDirect lookup
  // (canonical — reads the same SharedPreferences key
  // the manager reads) over the merged savedWakeModels.
  // If activeWakeDirect resolves, show that phrase. If
  // it's null but savedWakeModels has an entry (e.g. a
  // non-active set exists for this companion), fall
  // through to that. If both are empty, show the
  // neutral hint.
  const activeWake = activeWakeDirect || (wakeModel?.phrase ? wakeModel : null);
  const wakeStatusLine = activeWake
    ? `Trained: "${activeWake.displayName || activeWake.phrase}"`
    : 'No active wake on this phone — open Wake Sets to manage trained phrases';

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

            {/* v3.10.94: Personalize card is now FIRST. Tobe's
                v3.10.93 feedback: "put this companion edit in
                the top of the companion settings". The card
                opens the full CompanionEditScreen route with
                sprite picker + scale + traits + chattiness.
                The sub-line now reflects the v3.10.93 UI
                change: no LLM options on mobile (those live
                on the desktop), so we drop "model" from the
                description. */}
            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#f7931a' }]}
              onPress={() => onOpenCompanionEdit?.({
                companionId: companion.id,
                companionName: companion.name,
                emoji: companion.emoji || companion.icon || null,
              })}
            >
              <Text style={styles.phaseCardEmoji}>✏️</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Edit / Personalize</Text>
                <Text style={styles.phaseCardSub}>
                  Sprite, scale, traits, and chattiness for {companion.name}
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

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
                {/*
                  v3.10.1: show wake status here on the
                  per-companion page (Tobe: "It should
                  not say anything there but rather in
                  the wake and exit section when the
                  companion is clicked"). Two lines:
                  one for the active wake phrase (if
                  any), one for the existence of any
                  trained phrases. Falls back to "Not
                  trained" / "Default X" hints when the
                  user hasn't trained anything.
                */}
                {wakeStatusLine ? (
                  <Text style={[styles.phaseCardSub, { color: '#10b981', marginTop: 6, fontStyle: 'italic' }]}>
                    {wakeStatusLine}
                  </Text>
                ) : null}
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
                {/*
                  v3.10.1: same pattern as the Wake
                  card. Two flavors: "Trained: thanks"
                  when PerCompanionExitPicker found a
                  trained phrase, "Default: thanks"
                  when only the v3.7.1 default
                  voiceExitPhrase is in use. The exit
                  phrase is also reflected in the
                  Voice Settings voiceExitPhrase
                  control, but showing it once in the
                  per-companion list keeps the user
                  oriented without having to drill in.
                */}
                {exitStatusLine ? (
                  <Text style={[styles.phaseCardSub, { color: '#10b981', marginTop: 6, fontStyle: 'italic' }]}>
                    {exitStatusLine}
                  </Text>
                ) : null}
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

            {/* v3.7.6: Quests moved to its own top-level screen
                (QuestsScreen.tsx). Tap the 📜 Quests button on
                the arena to open it. */}
          </View>
        </ScrollView>
      </View>
    );
  }

  // v3.7.6: renderCompanionQuestsPage moved to QuestsScreen.tsx
  // (top-level). Quests are not per-companion on the desktop.

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

            {/*
              v3.10.5: "Currently active" panel. Shows
              the active wake phrase + setId + .tflite
              path right on this page so the user doesn't
              have to tap "Manage wake sets" to find out
              what's bound. The data comes from the
              activeWakeDirect lookup (canonical —
              reads the same SharedPreferences key the
              manager reads) rather than the merged
              savedWakeModels (which can miss the active
              binding in edge cases, see v3.10.4 fix
              notes).

              v3.10.6: removed the inline "Manage wake
              sets" button from this panel — there's
              already one further down. Only render the
              setId line when it differs from the
              displayName/phrase (otherwise it just
              repeats the name above, which looks like
              a typo).
            */}
            <SubTitle>Currently active wake</SubTitle>
            {activeWakeDirect ? (
              <View style={styles.activeWakePanel}>
                <View style={styles.activeWakeHeader}>
                  <Text style={styles.activeWakeDot}>◉</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.activeWakePhrase}>
                      {activeWakeDirect.displayName || activeWakeDirect.phrase}
                    </Text>
                    {/*
                      v3.10.6: only show setId when it
                      differs from the human-facing name.
                      When Tobe renamed a set to "Hey
                      Clawsuu", setId, displayName and
                      phrase all became the same string —
                      and v3.10.5's panel showed it twice
                      (once big in white, once small in
                      green).

                      v3.10.55: removed the setId line
                      entirely. Tobe reported (2026-07-19)
                      that the setId is redundant with the
                      Wake Sets manager, which already
                      shows it as the primary identifier
                      for each set. Showing it twice
                      (here + in the manager) is noise.

                      v3.10.57: also removed the .tflite
                      path line. The path is
                      `wake_models/<setId>/model.tflite`,
                      which embeds the setId as a
                      substring — so the setId was still
                      visible after v3.10.55 (just as part
                      of the path text). Tobe reported
                      (2026-07-19) that this is also
                      confusing. The path was debug-only
                      ("does the file exist on disk?") and
                      isn't useful on this panel — the
                      Wake Sets manager shows the path as
                      the primary identifier per set.
                      Active-wake panel is now: displayName
                      + Test wake button. Nothing else.
                    */}
                  </View>
                </View>
                {/*
                  v3.10.6: removed the "Manage wake sets"
                  button from this panel. It's redundant —
                  there's a "Manage wake sets for {name}"
                  button at the bottom of this same Wake
                  sub-page (further down, just below the
                  Wake phrases section). Two buttons to the
                  same screen = UI noise. The active-wake
                  panel's job is to show what's currently
                  active, not to navigate.

                  v3.10.8: added the "🎤 Test wake" button
                  here. The user can verify their trained
                  wake phrase is being recognised by the
                  OWW model, and see the peak score across
                  a 4-second test window. Useful for
                  diagnosing cold-start sensitivity
                  (Tobe: "have to almost yell") and false
                  triggers (scores spike on ambient noise).

                  v3.10.25: replaced with the shared
                  ClassifierTestPanel. Same behavior, same
                  4s window, same owwWakeDetected listener.
                  Exit + send tests live on their own
                  pages now (Exit page → ClassifierTestPanel
                  kind="exit"; Send section → kind="send").
                */}
                <ClassifierTestPanel kind="wake" wakeword={activeWakeDirect?.phrase} />

                {/*
                  v3.10.62: re-introduce the speaker
                  enrollment UI, this time as an explicit
                  "Train my voice (30s)" button. The
                  passive accumulation path (v3.10.23)
                  still runs in the background for users
                  who don't want a dedicated session, but
                  most users prefer the explicit, fast
                  path: read a paragraph for 30s, profile
                  locks immediately, gate activates.
                */}
                {/*
                  v3.10.66: enrollment panel moved to the
                  global Settings screen (under 🎙️ Voice
                  mode). It's a device-wide concept — your
                  voice, not your companion's voice. It
                  belongs in a single place, not N places
                  (one per companion). The passive
                  accumulator that runs in BG while wake
                  listening is unchanged.
                */}

                {/*
                  v3.10.23: speaker enrollment UI removed.
                  The wake-word detector now learns the
                  user's voice passively in the background
                  (no button, no progress bar). Once the
                  profile is auto-locked, wake fires are
                  gated on speaker match — the gate is
                  invisible to the user; only the
                  "did wake fire for me?" outcome differs.
                  See CHANGES_3.10.23.md for the full
                  design.
                */}
              </View>
            ) : (
              <View style={styles.activeWakePanelEmpty}>
                <Text style={styles.activeWakeEmptyText}>
                  No wake word is currently bound for {companion.name}. Use the buttons below to train one.
                </Text>
              </View>
            )}
            {/*
              v3.10.65: removed the redundant "Wake phrases" list
              (SubTitle + Hint + WakePhrasePicker). The active wake
              is already shown up top in the "Currently active wake"
              panel; the two buttons below ("Train new wake phrase"
              / "Manage wake sets") cover every action you'd want
              to do with a non-active set — activate, retrain,
              rename, delete, push, pull. The list was duplicate
              information (same data as the active panel) AND it
              sat between the active panel and the buttons that
              do things, which made the screen read as if the
              list WAS the actions. Tobe flagged it.

              v3.10.66: also folded in — the same screen got the
              "ActiveEnrollmentPanel" removed and parked in the
              global Settings screen. Wake sets / enrollment are
              both device-wide concepts now and only the active-
              per-companion stuff stays here.
            */}
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6' }]}
              onPress={() => {
                // v3.10.0: pushed as a route instead of
                // inline-expand.
                onPushWakeTrainer({
                  companionId: companion.id,
                  companionName: companion.name,
                  presetPhrase: '',
                });
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>🎤 Train new wake phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record 6 samples — desktop trains a custom neural wake word</Text>
            </TouchableOpacity>
            {/* v3.9.0: open the wake set manager. Lists
                every wake .tflite for this companion (and
                any other companions the user has trained),
                with activate / rename / delete / push-to-
                desktop / pull-from-desktop actions. */}
            <TouchableOpacity
              style={[styles.trainBtn, { backgroundColor: 'rgba(156, 163, 175, 0.10)', borderColor: '#9ca3af' }]}
              onPress={() => {
                // v3.10.0: pushed as a route instead of
                // inline-expand.
                onPushWakeManager({
                  companionId: companion.id,
                  companionName: companion.name,
                });
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#9ca3af' }]}>📂 Manage wake sets for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>List, activate, rename, delete, push to / pull from desktop</Text>
            </TouchableOpacity>
          </View>

          {/* v3.10.0: the wake trainer and wake set
              manager are now full-screen routes in
              App.tsx (pushed via onPushWakeTrainer /
              onPushWakeManager). No inline render
              blocks here anymore — Tobe asked for
              dedicated pages instead of inline-expand. */}
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

            {/* v3.10.25: per-page classifier test. The
                exit page now mirrors the wake page —
                tap "🚪 Test exit", say the trained
                exit phrase, see the peak score. Same
                shared ClassifierTestPanel. */}
            <ClassifierTestPanel kind="exit" />

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
                // v3.10.0: pushed as a route instead of
                // inline-expand.
                onPushExitTrainer({
                  companionId: companion.id,
                  companionName: companion.name,
                  presetPhrase: p,
                });
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
                // v3.10.0: pushed as a route instead of
                // inline-expand.
                onPushExitTrainer({
                  companionId: companion.id,
                  companionName: companion.name,
                  presetPhrase: '',
                });
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#f7931a' }]}>🚪 Train new exit phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record a short phrase 6 times — closes voice mode instantly when heard</Text>
            </TouchableOpacity>
          </View>

          {/* v3.10.0: exit trainer is now a full-screen
              route in App.tsx (pushed via onPushExitTrainer).
              No inline render block here. */}
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
  savedModels: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }>;
  activeCompanionId: string | null;
  onSelect: (companionId: string) => void;
  onRetrain: (companionId: string, phrase: string) => void;
  onDelete: (companionId: string) => void;
}) {
  // v3.10.0: defensive re-fetch. The parent screen
  // already calls getSavedWakeModels on mount +
  // companion-list growth, but if the cache is stale or
  // the active-only filter misses something, this
  // picker would render the "no trained" hint even
  // though the Wake Manager (separate code path) shows
  // a trained set. Re-fetch here as a fallback so the
  // hint text is always accurate.
  //
  // v3.10.4: merged getSavedWakeModels + listWakeSets,
  // same as the parent screen's effect. Picker rows
  // should show the same set the manager sees; the
  // active-only filter from getSavedWakeModels can
  // miss sets whose meta.json is missing agentId (the
  // listWakeSets path doesn't require agentId presence
  // for the display, only for the active check). With
  // this fallback, a picker row for a companion that
  // has an active set always appears.
  const [localSavedModels, setLocalSavedModels] = useState<
    Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }>
  >({});
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const { NativeModules } = require('react-native');
        const WakeWordModule = NativeModules.WakeWordModule;
        const [savedModels, allSets] = await Promise.all([
          WakeWordModule?.getSavedWakeModels?.().catch(() => null),
          WakeWordModule?.listWakeSets?.().catch(() => null),
        ]);
        if (cancelled) return;
        const out: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }> = {};
        // Seed from getSavedWakeModels (active-only).
        if (savedModels && typeof savedModels === 'object') {
          for (const agentId of Object.keys(savedModels)) {
            const entry = savedModels[agentId];
            if (entry?.phrase && entry?.path) {
              out[agentId] = {
                phrase: entry.phrase,
                displayName: entry.displayName || entry.phrase,
                path: entry.path,
                savedAt: entry.savedAt || 0,
              };
            }
          }
        }
        // Fill gaps from listWakeSets. For every companion
        // we know about, if it doesn't have a savedModels
        // entry yet, look up sets that match (or have no
        // agentId — legacy) and pick the active one, or
        // the most recently created. Either way, the
        // picker can show a row.
        if (allSets && typeof allSets === 'object') {
          for (const c of companions) {
            if (out[c.id]?.phrase) continue;
            const candidates = Object.entries(allSets)
              .map(([setId, raw]: [string, any]) => ({ setId, ...raw }))
              .filter((e: any) => !e.agentId || e.agentId === c.id);
            if (candidates.length === 0) continue;
            let activeId: string | null = null;
            try {
              activeId = await WakeWordModule?.getActiveWakeSet?.(c.id);
            } catch (_) {}
            if (cancelled) return;
            const active = activeId ? candidates.find((e: any) => e.setId === activeId) : undefined;
            const fallback = [...candidates].sort(
              (a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0),
            )[0];
            const picked = active || fallback;
            if (picked?.phrase) {
              out[c.id] = {
                phrase: picked.phrase,
                displayName: picked.displayName || picked.phrase,
                path: picked.path || `wake_models/${picked.setId}/model.tflite`,
                savedAt: picked.createdAt || 0,
              };
            }
          }
        }
        // Note: only write if we actually have data.
        // Parent's effect is the authoritative source for
        // the wake-status-line display; this local cache is
        // best-effort and only writes when it has rows
        // (so it doesn't clobber a populated parent with
        // an empty result in a race).
        if (Object.keys(out).length > 0 && !cancelled) setLocalSavedModels(out);
      } catch (_) {}
    };
    fetch();
    // v3.10.1: also re-fetch on focus. The
    // parent's effect covers mount + dep
    // changes, but returning from the wake
    // manager route doesn't change the parent's
    // deps (the active binding didn't change,
    // the agent list didn't grow) so the
    // picker's localSavedModels would stay
    // stale. AppState 'active' fires when the
    // screen comes back to focus from the
    // trainer/manager route (those are full-
    // screen pushes that don't change the JS
    // app state to background, but the focus
    // still happens when the route pops).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [Object.keys(savedModels).length]);
  // Merge parent + local. Parent wins (it has the
  // freshest data from the parent's effect).
  const merged = { ...localSavedModels, ...savedModels };
  const trainedRows = companions
    .filter(c => merged[c.id]?.phrase)
    .map(c => ({
      companionId: c.id,
      name: c.name,
      emoji: c.emoji || c.icon || '🐾',
      phrase: merged[c.id].phrase,
      // v3.10.1: prefer the human-friendly
      // displayName for the row's phrase
      // display. Falls back to phrase on
      // legacy meta.
      displayName: merged[c.id].displayName || merged[c.id].phrase,
      savedAt: merged[c.id].savedAt,
    }));

  if (trainedRows.length === 0) {
    // v3.10.0: removed the "No trained wake phrases yet"
    // hardcoded text. Tobe hit this in v3.9.9 where the
    // hint said "no trained" even though the manager
    // (separate code path) showed a trained set. Replaced
    // with a neutral hint that doesn't make a false claim.
    // The two buttons below ("Train new wake phrase" /
    // "Manage wake sets") already explain what to do.
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          Tap the buttons below to train a new wake phrase or open the manager.
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
                {r.displayName}
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
  // v3.7.6: quest-card / empty-state styles removed (they
  // live in QuestsScreen.tsx now). The styles below are still
  // used by the wake / exit / voice sub-pages.
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
  // v3.10.5: "Currently active wake" panel on the Wake
  // sub-page. Shows the active phrase + setId + .tflite
  // path so the user doesn't have to drill into the
  // manager to see what's bound. Mirrors the visual
  // language of the green ◉ indicator used elsewhere
  // (e.g. voice picker rows) so it reads as "active".
  activeWakePanel: {
    backgroundColor: '#0f1626',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#10b981',
    padding: 12,
    marginTop: 6,
    marginBottom: 6,
  },
  activeWakePanelEmpty: {
    backgroundColor: '#0f1626',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a3a',
    borderStyle: 'dashed',
    padding: 12,
    marginTop: 6,
    marginBottom: 6,
  },
  activeWakeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  activeWakeDot: {
    color: '#10b981',
    fontSize: 18,
    width: 18,
    textAlign: 'center',
    marginTop: 2,
  },
  activeWakePhrase: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  activeWakeSetId: {
    color: '#10b981',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 4,
  },
  activeWakePath: {
    color: '#666',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  activeWakeEmptyText: {
    color: '#888',
    fontSize: 13,
    fontStyle: 'italic',
  },
  // v3.10.8: test-wake button + result styles. The
  // button is a small teal pill that starts a 4-second
  // listening window. Result is a small panel showing
  // the peak wake/exit/send scores observed.
  // v3.10.25: styles orphaned by the move to
  // ClassifierTestPanel. Removed; the panel component
  // owns its own styles now.
  // v3.10.23: activeWakeTestBtnEnrolled removed
  // (no "voice is enrolled" UI anymore — enrollment
  // is global and silent).
  // v3.10.23: passive learning progress UI removed
  // (no button, no progress bar in v3.10.23 — the
  // OWW detector handles enrollment silently in
  // the background).
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