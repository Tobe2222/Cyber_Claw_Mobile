/** CompanionSettingsScreen — per-companion settings as its OWN screen. */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform, NativeModules, BackHandler,
  AppState, Dimensions,
} from 'react-native';
// Animated sprite view at the top of the settings screen.
import { WebView } from 'react-native-webview';
const { WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
// OpenWakeWordTrainer / ExitPhraseTrainer / WakeSetManagerScreen are now rendered as full-screen routes by App.tsx (pushed via…
import {
  loadVoiceFor, saveVoiceFor, clearVoiceFor,
  loadVoiceSettings, saveSilenceMs,
} from '../services/VoiceSettings';
import { promptIfMissingTtsEngine } from '../services/TtsPrompt';
import {
  LOCAL_VOICES,
  VoiceEngine,
} from '../services/VoiceCatalog';
// Shared "Test wake" panel (the wake page also uses the hook internally — the wake panel here renders the standard layout).
import { ClassifierTestPanel, useClassifierTest } from '../components/ClassifierTest';

// v3.10.66: removed — speaker enrollment moved to global
// Settings screen 🎙️ Voice mode section. The import is no
// longer needed here.// v3.7.1: syncClient for the desktop "Test voice" button.
import syncClient from '../services/SyncClient';
// AddLogEntry import removed.

type Companion = {
  id: string;
  name: string;
  emoji?: string | null;
  icon?: string | null;
  // Companion skill XP + levels, mirrored from the desktop's companion-stats.json.
  skills?: {
    level: number;
    xp: number;
    xpTotal: number;
    skills: Record<string, { level: number; xp: number }>;
  } | null;
  // Companion sprite configuration mirrored from the desktop's sprites.json.
  spriteConfig?: {
    pixelCompanionId?: string;
    scale?: number;
    traits?: string[];
    chattiness?: number;
    customName?: string;
  } | null;
  // Top-level sprite + chattiness fields from the broadcast payload.
  sprite?: string | null;
  chattiness?: number | null;
};

export default function CompanionSettingsScreen({
  companionId,
  onBack,
  // Push-callbacks for trainer / manager / exit-trainer sub-routes.
  onPushWakeTrainer,
  onPushWakeManager,
  onPushExitTrainer,
  // v3.10.92: open the Personalize screen for the
  // companion. Lifted to App.tsx as a full-screen route
  // (mirrors the desktop's Companion Forge on mobile).
  onOpenCompanionEdit,
  // Split editor callbacks — Looks + Behaviour open separate screens.
  onOpenCompanionLooks,
  onOpenCompanionBehaviour,
  // Models editor callback (third split-screen editor).
  onOpenCompanionModels,
  // Open the Skills screen scoped to this companion.
  onOpenSkills,
}: {
  companionId: string;
  onBack: () => void;
  onPushWakeTrainer: (ctx: { companionId: string; companionName: string; presetPhrase?: string }) => void;
  onPushWakeManager: (ctx: { companionId: string; companionName: string }) => void;
  onPushExitTrainer: (ctx: { companionId: string; companionName: string; presetPhrase?: string }) => void;
  onOpenCompanionEdit?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
  // Split editor callbacks.
  onOpenCompanionLooks?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
  onOpenCompanionBehaviour?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
  // Models editor callback prop.
  onOpenCompanionModels?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
  onOpenSkills?: (ctx: { companionId: string; companionName: string; emoji?: string | null }) => void;
}) {
  // Drill-down phase inside the companion detail view.
  const [companionViewPhase, setCompanionViewPhase] = useState<'wake' | 'exit' | 'voice' | null>(null);

  // Experience card collapsible state.
  const [experienceExpanded, setExperienceExpanded] = useState(false);

  // Companion list — owned here (not lifted to App.tsx) because this screen needs it to resolve companionId → {name, emoji}.
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

  // Per-companion voice picker state.
  const [vcEngine, setVcEngine] = useState<VoiceEngine>('default');
  const [vcLocalId, setVcLocalId] = useState<string>('default');
  const [vcSavedAt, setVcSavedAt] = useState<number | null>(null);
  const vcLoadedRef = useRef(false);

  // Live voice list from the desktop.
  const [voiceList, setVoiceList] = useState<Array<{ id: string; label: string; desc: string; group?: string }> | null>(null);
  const [desktopVoice, setDesktopVoice] = useState<string>('lessac');

  // Tap a voice in the picker.
  const onPickVoice = useCallback((voiceId: string) => {
    setVcLocalId(voiceId);
    // Optimistic local save: also write to AsyncStorage so the picker reflects the choice even if the desktop is offline.
    saveVoiceFor(companionId, { engine: vcEngine, localId: voiceId }).catch(() => {});
    if (syncClient?.connected) {
      syncClient.setTtsVoice(voiceId);
    }
  }, [companionId, vcEngine]);

  // Subscribe to TTS voice events from the desktop.
  useEffect(() => {
    const onSettings = (msg: any) => {
      if (msg?.ok && Array.isArray(msg.voices)) {
        setVoiceList(msg.voices.map((v: any) => ({
          id: v.id,
          label: v.label,
          desc: v.id === v.label ? '' : (v.id.charAt(0).toUpperCase() + v.id.slice(1) + ' — '), // group-prefix
          group: v.group,
        })));
        if (msg.current) setDesktopVoice(msg.current);
        if (msg.current) setVcLocalId(msg.current);
      }
    };
    const onSettingsChanged = (msg: any) => {
      if (msg?.current) {
        setDesktopVoice(msg.current);
        setVcLocalId(msg.current);
      }
    };
    syncClient?.on?.('tts_settings', onSettings);
    syncClient?.on?.('tts_settings_changed', onSettingsChanged);
    // Request on mount. The desktop will respond; if it's
    // not connected (offline), the fallback LOCAL_VOICES
    // list stays visible.
    if (syncClient?.connected) {
      syncClient.requestTtsSettings();
    }
    return () => {
      syncClient?.off?.('tts_settings', onSettings);
      syncClient?.off?.('tts_settings_changed', onSettingsChanged);
    };
  }, []);

  // Per-companion silence timeout.
  const [vcSilenceMs, setVcSilenceMs] = useState<number>(5000);
  const [vcSilenceSavedAt, setVcSilenceSavedAt] = useState<number | null>(null);
  const vcSilenceLoadedRef = useRef(false);

  // Quests moved out to QuestsScreen.tsx (top-level, not per-companion).

  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }>>({});

  // Direct active-wake-phrase lookup.
  const [activeWakeDirect, setActiveWakeDirect] = useState<{
    setId: string;
    phrase: string;
    displayName?: string;
    path?: string;
  } | null>(null);

// 'Test wake' was extracted into a shared useClassifierTest hook.

  // Speaker enrollment was removed from CompanionSettingsScreen.
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      // Only fetch when we know which companion we're showing.
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
        // Look up the set's metadata in listWakeSets so we can show phrase / displayName / path.
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
    // Also refetch when the screen comes back to focus (e.g.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [companion?.id, availableCompanions.length]);

  // Per-companion speaker enrollment UI was removed entirely.

  // Trained-exit-phrase list for the overview card.
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

  // Trainer + manager + exit-trainer are now full-screen routes in App.tsx, pushed via onPushWakeTrainer / onPushWakeManager /…

  // v3.4.4: set true when the active companionId was
  // missing from a populated cache and we already auto-
  // backed out, so we don't loop onBack in render.
  const hasAutoBackedRef = useRef(false);

  // WebView ref for the animated sprite view at the top of the settings page.
  const viewWebViewRef = useRef<WebView>(null);

  // Track whether arena.html's JS has finished bootstrapping (received arena_loaded).
  const [arenaReady, setArenaReady] = useState(false);

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
              // Pass through the skills payload (desktop v3.2.84 adds this to agents_list).
              skills: a.skills ?? null,
              // Pass through spriteConfig so the Behaviour card can show current values without a separate IPC round-trip.
              spriteConfig: a.spriteConfig ?? null,
              // Also pass through top-level sprite + chattiness from the broadcast payload.
              sprite: a.sprite || null,
              chattiness: typeof a.chattiness === 'number' ? a.chattiness : null,
            })));
          }
        }
      } catch (_) {}
    })();
  }, []);

  // Also subscribe to live agents_list broadcasts so the Skills section refreshes when the desktop awards XP (the desktop re-broadcasts after…
  useEffect(() => {
    const handler = (msg: any) => {
      if (!msg?.agents || !Array.isArray(msg.agents)) return;
      setAvailableCompanions(prev => {
        // Merge by id so we keep any companions that arrived
        // via cache but haven't been re-broadcast yet.
        const byId = new Map(prev.map(c => [c.id, c]));
        for (const a of msg.agents) {
          byId.set(a.id, {
            id: a.id,
            name: a.name,
            emoji: a.emoji || null,
            icon: a.icon || null,
            skills: a.skills ?? null,
            // Pass through spriteConfig on live broadcasts too (Behaviour card updates when the user saves changes via the edit route and the desktop…
            spriteConfig: a.spriteConfig ?? null,
            // v3.10.146: also pass through top-level
            // sprite + chattiness (see cache hydration
            // comment above for why).
            sprite: a.sprite || null,
            chattiness: typeof a.chattiness === 'number' ? a.chattiness : null,
          });
        }
        return Array.from(byId.values());
      });
    };
    syncClient.on('agents_list', handler);
    return () => { syncClient.off?.('agents_list', handler); };
  }, []);

  // Also update the AsyncStorage cache when agents_list arrives.
  useEffect(() => {
    const persistHandler = (msg: any) => {
      if (!msg?.agents || !Array.isArray(msg.agents)) return;
      AsyncStorage.setItem(
        'cyberclaw-agents-cache',
        JSON.stringify(msg.agents),
      ).catch(() => { /* ignore — cache is best-effort */ });
    };
    syncClient.on('agents_list', persistHandler);
    return () => { syncClient.off?.('agents_list', persistHandler); };
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

  // Hydrate the per-companion voice picker state.
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
        // 'api' is no longer a valid engine.
        if (raw === 'local') {
          storedEngine = 'local';
        } else if (raw === 'default') {
          storedEngine = 'default';
        } else {
          storedEngine = 'default';
        }
      } catch (_) {}
      if (cancelled) return;
      setVcEngine(storedEngine);
      setVcLocalId(cfg.localId);
      vcLoadedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [companionId]);

  // Hydrate the per-companion silence timeout.
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

  // When the user enters this companion's voice settings page (companionViewPhase === 'voice'), run the lazy TTS availability check.
  useEffect(() => {
    if (companionViewPhase === 'voice') {
      promptIfMissingTtsEngine('companion-voice-page').catch(() => {});
    }
  }, [companionViewPhase]);

  // Listen for the desktop's companion_settings_sync broadcast.
  useEffect(() => {
    const handler = (msg: any) => {
      if (!msg?.settings) return;
      const remote = msg.settings[companionId];
      if (!remote || typeof remote.silenceMs !== 'number') return;
      // Only adopt the remote value if our local store has nothing for this companion.
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

  // Refresh saved-wake-models whenever the companion list grows or the active companion changes (covers post-training refresh).
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
        // Resolve the active setId for every available companion in parallel — these are cheap SharedPreferences reads, so it's safe to fan out…
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
        // 2.
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
                // The path stored by getSavedWakeModels is the absolute on-disk path; for the listWakeSets fallback we don't have the absolute path, but the…
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
          // Now async (resolves voice from AsyncStorage internally); fire-and-forget with .catch so an internal failure doesn't surface as an…
          ensureGreetingCached(v.trim()).catch(() => {});
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
          ensureExitReplyCached(v.trim()).catch(() => {});
        } catch (_) {}
      }
    }, 600);
  };

  // Per-companion voice picker callbacks.
  const saveVoice = useCallback(async () => {
    if (!vcLoadedRef.current) return;
    await saveVoiceFor(companionId, {
      engine: vcEngine,
      localId: vcLocalId,
    });
    // Apply the voice selection to the native engine IMMEDIATELY, not just on next app start.
    const wm = (NativeModules as any).WakeWordModule;
    if (wm?.setTtsVoice) {
      try {
        const applied = await wm.setTtsVoice(vcLocalId);
        console.log(`[Voice] applied voice "${applied ?? '(default)'}" for ${companionId}`);
      } catch (e: any) {
        // Engine not bound yet is the common case (probe is still running or found nothing).
        console.log(`[Voice] setTtsVoice deferred: ${e?.message || e}`);
      }
    }
    // ALSO drive the desktop's piper voice.
    if (syncClient?.connected) {
      syncClient.setTtsVoice(vcLocalId);
    }

    // Clear all three piper audio caches so the next wake / exit / working cue synthesizes with the NEW voice instead of playing a stale WAV…
    try {
      const { clearGreetingCache } = require('../services/GreetingAudioCache');
      const { clearExitReplyCache } = require('../services/ExitReplyAudioCache');
      const { clearWorkingSpeechCache: clearWorkingCache } = require('../services/WorkingSpeechAudioCache');
      // Clear all known phrases — the cache file pattern is just `cyberclaw-greeting-*.wav` etc., so we walk the existing AsyncStorage index to…
      await clearGreetingCache();
      await clearExitReplyCache();
      if (clearWorkingCache) await clearWorkingCache();
      console.log('[Voice] Cleared piper audio caches after voice change');
    } catch (e: any) {
      console.warn('[Voice] Cache clear after voice change failed:', e?.message);
    }

    setVcSavedAt(Date.now());
  }, [companionId, vcEngine, vcLocalId]);

  const resetToGlobal = useCallback(async () => {
    await clearVoiceFor(companionId);
    setVcEngine('default');
    // Reload effective values from globals.
    const cfg = await loadVoiceFor(companionId);
    setVcLocalId(cfg.localId);
    setVcSavedAt(Date.now());
  }, [companionId]);

  // Save the per-companion silence timeout.
  const saveSilence = useCallback(async () => {
    if (!vcSilenceLoadedRef.current) return;
    await saveSilenceMs(companionId, vcSilenceMs);
    // Push to desktop if connected.
    if (syncClient?.connected) {
      syncClient.setCompanionSilence(companionId, vcSilenceMs);
    }
    setVcSilenceSavedAt(Date.now());
  }, [companionId, vcSilenceMs]);

  // Hardware back handler — chain through phases v3.10.0: trainer / manager / exit-trainer are now top-level routes in App.tsx, not inline…
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

  // When the active companion changes (e.g.
  useEffect(() => {
    const c = availableCompanions.find(x => x.id === companionId);
    if (!c || !viewWebViewRef.current) return;
    const spriteName = (c as any).sprite || (c as any).spriteConfig?.pixelCompanionId;
    if (!spriteName) return;
    const slim = [{
      id: c.id,
      name: c.name,
      sprite: spriteName,
      // Scale is overridden by setCentered(true) via the ?centeredScale=5 URL param.
      scale: 5,
    }];
    // Re-inject setCentered(true) to keep the companion centered after a companion switch.
    viewWebViewRef.current.injectJavaScript(
      `(async function(){` +
        `if (!window.Arena) return;` +
        `window.Arena.setActive(${JSON.stringify(c.id)});` +
        `await window.Arena.setAgents(${JSON.stringify(slim)});` +
        `window.Arena.setCentered(true);` +
      `})(); true;`
    );
  }, [companionId, availableCompanions.length]);

  // NOT resetting arenaReady on companion switch.

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

  // Per-companion status lines for the overview cards.
  const exitStatusLine = trainedExitPhrases.length > 0
    ? `Trained: "${trainedExitPhrases[0]}"`
    : voiceExitPhrase
      ? `Default: "${voiceExitPhrase}"`
      : 'Not set';
  const wakeModel = savedWakeModels[companion.id];
  // Prefer the direct activeWakeDirect lookup (canonical — reads the same SharedPreferences key the manager reads) over the merged…
  const activeWake = activeWakeDirect || (wakeModel?.phrase ? wakeModel : null);
  const wakeStatusLine = activeWake
    ? `Trained: "${activeWake.displayName || activeWake.phrase}"`
    : 'No active wake on this phone — open Wake Sets to manage trained phrases';

  // Skyrim-style Experience card.
  function renderSkillsSection() {
    // SKILL_DEFS mirrors the desktop's SKILL_DEFS in main.js (v3.2.84).
    const SKILL_DEFS = [
      { name: 'Building',     icon: '🔧' },
      { name: 'Writing',      icon: '✍️'  },
      { name: 'Design',       icon: '🎨' },
      { name: 'Analysis',     icon: '📊' },
      { name: 'Strategy',     icon: '🗺️'  },
      { name: 'Research',     icon: '🔍' },
      { name: 'Communication', icon: '💬' },
      { name: 'Game',         icon: '🎮' },
      { name: 'General',      icon: '✨' },
    ];

    // helper: XP curve mirrors the desktop's
    // xpForLevel() in main.js — 100 * 1.5^(level-1).
    // Level 1 = 100 XP to next, level 2 = 150, level 3 = 225.
    const xpForLevel = (level: number) =>
      Math.floor(100 * Math.pow(1.5, Math.max(1, level) - 1));

    // Build category rows for ALL 9 categories, not just ones with XP > 0.
    const skillRows = SKILL_DEFS
      .map(def => {
        const s = companion?.skills?.skills?.[def.name];
        // v3.10.175: default { level: 1, xp: 0 } for
        // categories with no entry yet. The empty bar
        // shows 0% (correct — 0 / xpForLevel(1) = 0%).
        return { ...def, level: s?.level ?? 1, xp: s?.xp ?? 0 };
      })
      .sort((a, b) => {
        const xpDiff = b.xp - a.xp;
        if (xpDiff !== 0) return xpDiff;
        return a.name.localeCompare(b.name);
      });

    // Character level bar — read from companion.skills directly (the desktop computes this from the sum of category XP, mobile just renders).
    const charLevel = companion?.skills?.level ?? 1;
    const charXp = companion?.skills?.xp ?? 0;
    const charXpToNext = xpForLevel(charLevel);
    const charXpTotal = companion?.skills?.xpTotal ?? 0;
    const charPct = Math.min(100, (charXp / charXpToNext) * 100);
    const hasStats = !!companion?.skills;

    return (
      <View style={styles.skillsSection}>
        <TouchableOpacity
          style={styles.skillsSectionHeader}
          onPress={() => setExperienceExpanded(v => !v)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ expanded: experienceExpanded }}
          accessibilityLabel={`Experience, level ${charLevel}. Tap to ${experienceExpanded ? 'collapse' : 'expand'} category breakdown.`}
        >
          <Text style={styles.skillsSectionIcon}>⭐</Text>
          <View style={{ flex: 1 }}>
            <View style={styles.skillGridRow}>
              <Text style={styles.skillsSectionTitle}>
                Experience · Lv.{charLevel}
              </Text>
              <Text style={styles.skillsSectionXp}>
                {charXp} / {charXpToNext} XP
              </Text>
            </View>
            <Text style={styles.skillsSectionDesc}>
              {hasStats
                ? `Lifetime ${charXpTotal} XP · tap for categories`
                : 'Stats syncing from desktop…'}
            </Text>
          </View>
          <Text style={[styles.skillsSectionChevron, experienceExpanded && styles.skillsSectionChevronOpen]}>
            ›
          </Text>
        </TouchableOpacity>

        {/* v3.10.175: always-visible character XP bar. Lives
            OUTSIDE the toggle so the user can see their
            companion's overall progress at a glance, even
            with the categories collapsed. */}
        <View style={styles.charBar}>
          <View style={[styles.charBarFill, { width: `${charPct}%` }]} />
        </View>

        {experienceExpanded && (
          // Per-category breakdown.
          <View style={styles.skillsGrid}>
            {skillRows.map(s => {
              const xpNeeded = xpForLevel(s.level);
              const pct = Math.min(100, (s.xp / xpNeeded) * 100);
              return (
                <View key={s.name} style={styles.skillGridCell}>
                  <Text style={styles.skillGridIcon}>{s.icon}</Text>
                  <View style={{ flex: 1 }}>
                    <View style={styles.skillGridRow}>
                      <Text style={styles.skillGridName} numberOfLines={1}>{s.name}</Text>
                      <Text style={styles.skillGridLevel}>Lv.{s.level}</Text>
                    </View>
                    <View style={styles.skillGridBar}>
                      <View style={[styles.skillGridFill, { width: `${pct}%` }]} />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  }

  // Animated sprite view window.
  function renderCompanionViewWindow() {
    // Source URI includes the URL params arena.html parses at boot: - ?mode=wake → adds wake-mode body class (hides arena controls) -…
    const sourceUri = `file:///android_asset/arena.html?v=${ARENA_HTML_VERSION}&platform=mobile&mode=wake&onlyActive=true&centered=true&centeredScale=5`;

    // Fallback display.
    const placeholderEmoji = (companion as any)?.emoji
      || (companion as any)?.icon
      || '🐾';
    const placeholderSprite = (companion as any)?.sprite
      ? `${(companion as any).sprite} sprite`
      : 'default sprite';

    return (
      <View style={styles.viewWindow}>
        <WebView
          ref={viewWebViewRef}
          source={{ uri: sourceUri }}
          style={{ width: VIEW_BOX_W, height: VIEW_BOX_H, backgroundColor: '#0a0a2e' }}
          scrollEnabled={false}
          bounces={false}
          javaScriptEnabled
          allowFileAccess
          originWhitelist={['*']}
          // Arena.html events treated as no-ops.
          onMessage={(event) => {
            try {
              const msg = JSON.parse(event.nativeEvent.data || '{}');
              if (msg && msg.type === 'arena_loaded') {
                setArenaReady(true);
              }
            } catch (_) { /* ignore non-JSON */ }
          }}
          // Track load state.
          onLoadEnd={() => {
            const c = availableCompanions.find(x => x.id === companionId);
            if (!c) return;
            const spriteName = (c as any).sprite || (c as any).spriteConfig?.pixelCompanionId;
            if (!spriteName) return;
            const slim = [{
              id: c.id,
              name: c.name,
              sprite: spriteName,
              // Scale is ignored when setCentered(true) is called — arena.html overrides it with CENTERED_SCALE (5 for the mobile settings view, via the…
              scale: 5,
            }];
            viewWebViewRef.current?.injectJavaScript(
              `(async function(){` +
                `if (!window.Arena) return;` +
                `window.Arena.setActive(${JSON.stringify(c.id)});` +
                `await window.Arena.setAgents(${JSON.stringify(slim)});` +
                // RE-ADD setCentered(true).
                `window.Arena.setCentered(true);` +
              `})(); true;`
            );
          }}
        />
        {/* v3.10.145: small label at the BOTTOM of
            the view window showing the companion's
            name + sprite id. This is always visible
            (the WebView is mostly empty space at the
            bottom; the sprite is centered higher
            up). Gives the user confirmation that the
            view is showing the right companion.
            v3.10.174: hide the caption once arena.html
            has finished bootstrapping (arenaReady).
            The canvas-drawn name above the centered
            sprite is then visible and the caption
            duplicates it ("Clawsuu" appears twice in
            the box). The caption stays visible during
            the boot window as a fallback if the
            WebView fails to load (black-box case). */}
        {(!arenaReady || placeholderSprite === 'default sprite') && (
          <View style={styles.viewWindowLabel} pointerEvents="none">
            <Text style={styles.viewWindowLabelText}>
              {companion?.name || ''} · {placeholderSprite}
            </Text>
          </View>
        )}
      </View>
    );
  }

  // Behaviour card.
  const TRAIT_LABELS: Record<string, string> = {
    sassy: '😏 Sassy',
    curious: '🔍 Curious',
    lazy: '😴 Lazy',
    cheerful: '🌟 Cheerful',
    foodobsessed: '🍖 Food-obsessed',
    dramatic: '🎭 Dramatic',
    stoic: '🗿 Stoic',
    adventurous: '⚔️ Adventurous',
    goblin: '👺 Goblin',
  };

  // Split the Behaviour card into Looks + Behaviour.
function renderLooksCard(companion: Companion) {
  const sc = (companion as any).spriteConfig || {};
  const spriteName = sc.pixelCompanionId
    ? (sc.pixelCompanionId.charAt(0).toUpperCase() + sc.pixelCompanionId.slice(1))
    : 'Default';
  const scale = typeof sc.scale === 'number' ? sc.scale : '?';
  // Prefer the split-screen callback (v3.10.186); fall back to the legacy onOpenCompanionEdit so older builds that haven't wired the new…
  const openEditor = onOpenCompanionLooks || onOpenCompanionEdit;

  return (
    <View style={styles.behaviourCard}>
      <View style={styles.behaviourHeader}>
        <Text style={styles.behaviourTitle}>🎨 Looks</Text>
        {openEditor ? (
          <TouchableOpacity
            onPress={() => openEditor({
              companionId: companion.id,
              companionName: companion.name,
              emoji: companion.emoji || companion.icon || null,
            })}
            style={styles.behaviourEditBtn}
          >
            <Text style={styles.behaviourEditBtnText}>Edit ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={styles.behaviourRow}>
        <Text style={styles.behaviourLabel}>Sprite</Text>
        <Text style={styles.behaviourValue}>{spriteName}</Text>
      </View>
      <View style={styles.behaviourRow}>
        <Text style={styles.behaviourLabel}>Scale</Text>
        <Text style={styles.behaviourValue}>{scale}</Text>
      </View>
    </View>
  );
}

function renderBehaviourCard(companion: Companion) {
    const sc = (companion as any).spriteConfig || {};
    const chattiness = typeof sc.chattiness === 'number' ? sc.chattiness : 3;
    const traitIds: string[] = Array.isArray(sc.traits) ? sc.traits : [];
    // Prefer the split-screen callback (v3.10.186); fall
    // back to the legacy callback for older App.tsx builds.
    const openEditor = onOpenCompanionBehaviour || onOpenCompanionEdit;

    return (
      <View style={styles.behaviourCard}>
        <View style={styles.behaviourHeader}>
          <Text style={styles.behaviourTitle}>🎭 Behaviour</Text>
          {openEditor ? (
            <TouchableOpacity
              onPress={() => openEditor({
                companionId: companion.id,
                companionName: companion.name,
                emoji: companion.emoji || companion.icon || null,
              })}
              style={styles.behaviourEditBtn}
            >
              <Text style={styles.behaviourEditBtnText}>Edit ›</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.behaviourRow}>
          <Text style={styles.behaviourLabel}>Chattiness</Text>
          <View style={styles.behaviourChattinessBar}>
            <View style={styles.behaviourChattinessTrack}>
              {[1, 2, 3, 4, 5].map(n => (
                <View
                  key={n}
                  style={[
                    styles.behaviourChattinessTick,
                    n <= chattiness && styles.behaviourChattinessTickActive,
                  ]}
                />
              ))}
            </View>
            <Text style={styles.behaviourChattinessNum}>{chattiness}</Text>
          </View>
        </View>
        {/* v3.10.144: traits as wrap chips. Was a
            comma-separated string that got truncated
            ("Curious, Foodobsessed, Dramatic, Stoic, A...").
            Tobe: "make better use of the space for
            the traits, one should see all with their
            associated emoji for a quick view". Each
            trait is a small chip with its emoji. Chips
            wrap to next line when they run out of
            width — so the user always sees all
            selected traits regardless of how many. */}
        <View style={styles.behaviourRow}>
          <Text style={styles.behaviourLabel}>Traits</Text>
          <View style={styles.traitsChips}>
            {traitIds.length === 0 ? (
              <Text style={styles.traitsEmpty}>None selected</Text>
            ) : (
              traitIds.map(id => (
                <View key={id} style={styles.traitChip}>
                  <Text style={styles.traitChipText}>
                    {TRAIT_LABELS[id] || id}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>
      </View>
    );
  }

  // Models card — summary of the companion's LLM configuration.
  function renderModelsCard(companion: Companion) {
    const sc = (companion as any).spriteConfig || {};
    // Model fields on the spriteConfig object.
    const primary = typeof sc.primaryModel === 'string' && sc.primaryModel
      ? sc.primaryModel
      : '';
    const secondary = typeof sc.secondaryModel === 'string' && sc.secondaryModel
      ? sc.secondaryModel
      : '';
    // Split a "provider/model" string into display-friendly parts.
    const splitModel = (m: string): { provider: string; name: string; isLocal: boolean } => {
      if (!m) return { provider: '', name: '', isLocal: false };
      const idx = m.indexOf('/');
      const provider = idx >= 0 ? m.slice(0, idx) : '';
      const name = idx >= 0 ? m.slice(idx + 1) : m;
      // Local providers include ollama (most common — the desktop forge ships with an "ollama/llama3" default), plus lmstudio / llamacpp / vllm…
      const localProviders = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
      return { provider, name, isLocal: localProviders.has(provider.toLowerCase()) };
    };
    const primaryParts = splitModel(primary);
    const secondaryParts = splitModel(secondary);
    // Pretty-print the model id.
    const prettyProvider = (p: string): string => {
      if (!p) return '';
      const lower = p.toLowerCase();
      if (lower === 'anthropic') return 'Anthropic';
      if (lower === 'openai') return 'OpenAI';
      if (lower === 'google') return 'Google';
      if (lower === 'ollama') return 'Ollama';
      if (lower === 'lmstudio') return 'LM Studio';
      if (lower === 'llamacpp') return 'llama.cpp';
      if (lower === 'vllm') return 'vLLM';
      return p.charAt(0).toUpperCase() + p.slice(1);
    };
    const prettyName = (n: string): string => {
      if (!n) return '';
      // Anthropic: claude-opus-4-6 → Claude Opus 4
      const m = n.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i);
      if (m) {
        const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        return `Claude ${tier} ${m[2]}`;
      }
      // OpenAI: gpt-4o / gpt-4o-mini → GPT-4o / GPT-4o Mini
      const g = n.match(/^gpt-(.+)$/i);
      if (g) return `GPT-${g[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
      // Google: gemini-2.5-pro → Gemini 2.5 Pro
      const gm = n.match(/^gemini-(.+)$/i);
      if (gm) return `Gemini ${gm[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
      // Fallback: title-case, replace dashes.
      return n.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    };
    const openEditor = onOpenCompanionModels || onOpenCompanionEdit;

    return (
      <View style={styles.behaviourCard}>
        <View style={styles.behaviourHeader}>
          <Text style={styles.behaviourTitle}>🧠 Models</Text>
          {openEditor ? (
            <TouchableOpacity
              onPress={() => openEditor({
                companionId: companion.id,
                companionName: companion.name,
                emoji: companion.emoji || companion.icon || null,
              })}
              style={styles.behaviourEditBtn}
            >
              <Text style={styles.behaviourEditBtnText}>Edit ›</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.behaviourRow}>
          <Text style={styles.behaviourLabel}>Primary</Text>
          {/* v3.10.191: primary model display. Shows
              "Provider / Model" when both are
              known, or the raw id when no provider
              is parseable. A small green dot is
              drawn next to local-model primaries so
              the user can see "this companion is
              running against a local LLM" without
              opening the editor. */}
          <Text style={styles.behaviourValue}>
            {primary ? (
              <>
                {primaryParts.isLocal && (
                  <Text style={styles.modelLocalDot}>  ● </Text>
                )}
                {prettyProvider(primaryParts.provider)}{primaryParts.provider ? ' / ' : ''}{prettyName(primaryParts.name) || primary}
              </>
            ) : (
              <Text style={styles.modelDefault}>Default</Text>
            )}
          </Text>
        </View>
        <View style={styles.behaviourRow}>
          <Text style={styles.behaviourLabel}>Secondary</Text>
          <Text style={styles.behaviourValue}>
            {secondary ? (
              <>
                {secondaryParts.isLocal && (
                  <Text style={styles.modelLocalDot}>  ● </Text>
                )}
                {prettyProvider(secondaryParts.provider)}{secondaryParts.provider ? ' / ' : ''}{prettyName(secondaryParts.name) || secondary}
              </>
            ) : (
              <Text style={styles.modelDefault}>None</Text>
            )}
          </Text>
        </View>
        {/* v3.10.191: small footer hint inside the
            card explaining what "Secondary" means
            (the fallback model the chat pipeline
            switches to when the primary is down or
            context-overflows). One short line, sits
            below the rows. Helps new users. */}
        <Text style={styles.modelFooterHint}>
          Secondary is the fallback used when the primary is down.
        </Text>
      </View>
    );
  }

  // Compact settings card.
  function renderSettingsCard(opts: {
    emoji: string;
    title: string;
    currentValue: string | null;
    onPress: () => void;
    borderColor?: string;
  }) {
    return (
      <TouchableOpacity
        style={[styles.settingsCard, opts.borderColor ? { borderColor: opts.borderColor } : null]}
        onPress={opts.onPress}
      >
        <Text style={styles.settingsCardEmoji}>{opts.emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.settingsCardTitle}>{opts.title}</Text>
          {opts.currentValue ? (
            <Text style={styles.settingsCardValue} numberOfLines={1}>
              {opts.currentValue}
            </Text>
          ) : null}
        </View>
        <Text style={styles.settingsCardArrow}>›</Text>
      </TouchableOpacity>
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
  return renderCompanionOverview(companion);

  // Overview (cards) v3.10.142: redesigned layout per Tobe 2026-08-07.
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

          {/* 1. v3.10.140: animated sprite view window */}
          {renderCompanionViewWindow()}

          {/* 2. v3.10.139 + 3.10.142: skills grid (compact,
              moved up from below Exit card) */}
          {renderSkillsSection()}

          {/* 3. v3.10.186: split into Looks + Behaviour cards.
              v3.10.142's single behaviour card held Sprite +
              Scale + Chattiness + Traits under one heading,
              which made Sprite feel misplaced (it's visual
              identity, not personality). Each card now has its
              own Edit button that opens a dedicated editor
              screen. The companion's avatar block above the
              Experience widget serves as the visual preview;
              the Looks card surfaces the picker-driven sprite
              name + scale number so the user can confirm what
              they picked without opening the editor. */}
          {renderLooksCard(companion)}
          {renderBehaviourCard(companion)}
          {/* v3.10.191: Models card — third in the
              Looks / Behaviour / Models trio. Shows the
              active primary model + the secondary (if
              any) so the user knows which models this
              companion is configured to use without
              opening the editor. Tapping Edit opens
              the dedicated Models editor (a new route
              in App.tsx). The card's design mirrors
              Looks + Behaviour so the trio reads as
              one consistent pattern. */}
          {renderModelsCard(companion)}

          {/* v3.10.174: Skills library entry point.
              Sits between Behaviour and the SETTINGS
              separator. Tappable card → opens
              SkillsScreen pre-bound to this companion
              (per-companion toggle pills work
              immediately, no companion picker). This
              is the ONLY place on the mobile where the
              Skills library is reachable (Tobe: "Skills
              in the companion settings, nowhere
              else"). The v3.10.139 Skills → Experience
              rename above avoids the dual-Skills-label
              confusion (Experience widget = XP, Skills
              library = toggleable abilities). */}
          {onOpenSkills && (
            <TouchableOpacity
              style={styles.skillsLibraryCard}
              onPress={() => onOpenSkills({
                companionId: companion.id,
                companionName: companion.name,
                emoji: companion.emoji || companion.icon || null,
              })}
              accessibilityRole="button"
              accessibilityLabel={`Skills library for ${companion.name}`}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.skillsLibraryIcon}>📚</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.skillsLibraryTitle}>Skills library</Text>
                  <Text style={styles.skillsLibraryDesc}>
                    Browse, create, edit, and toggle skills for {companion.name}.
                  </Text>
                </View>
                <Text style={styles.skillsLibraryChevron}>›</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* 4. v3.10.142: visual separator between the
              "about this companion" sections (view +
              skills + behaviour) and the "settings"
              sections (wake/exit/voice) */}
          <View style={styles.overviewSeparator}>
            <Text style={styles.overviewSeparatorText}>SETTINGS</Text>
          </View>

          {/* 5. v3.10.142: collapsed settings cards.
              Each shows the current value inline +
              chevron. Tap → existing sub-page (which
              already has the full editor). */}

          {renderSettingsCard({
            emoji: '🎤',
            title: 'Wake',
            currentValue: wakeStatusLine || 'Not trained',
            onPress: () => setCompanionViewPhase('wake'),
            borderColor: '#3b82f6',
          })}

          {renderSettingsCard({
            emoji: '🚪',
            title: 'Exit',
            currentValue: exitStatusLine || 'Not trained',
            onPress: () => setCompanionViewPhase('exit'),
            borderColor: '#f7931a',
          })}

          {renderSettingsCard({
            emoji: '🔊',
            title: 'Voice',
            // Show current voice + engine.
            currentValue:
              vcLocalId && vcLocalId !== 'default'
                ? `Local · ${vcLocalId}`
                : 'Local · Default',
            onPress: () => setCompanionViewPhase('voice'),
            borderColor: '#10b981',
          })}

          <View style={{ height: 24 }} />
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

  // Per-companion voice settings sub-page.
  function renderCompanionVoicePage(companion: Companion) {
    // Resolve the effective voice id for the "what would actually be used right now?" status row.
    const effectiveLocalId: string =
      vcEngine === 'local' ? vcLocalId : 'default';

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

            <SubTitle>Voice</SubTitle>
            <Hint>📱 Uses the device's Android TTS engine — Google TTS, RHVoice, eSpeak NG, Samsung TTS, or whatever you have installed. Always free, always offline.</Hint>
            <View style={{ marginVertical: 6 }}>
              <TouchableOpacity
                onPress={() => setVcEngine('default')}
                style={[styles.radioRow, vcEngine === 'default' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'default' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>🌐 Use global default</Text>
                  <Text style={styles.radioSub}>Inherit whatever the global master local voice is set to right now.</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setVcEngine('local')}
                style={[styles.radioRow, vcEngine === 'local' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'local' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>📱 Per-companion override</Text>
                  <Text style={styles.radioSub}>Pick a specific voice below for {companion.name}.</Text>
                </View>
              </TouchableOpacity>
            </View>

            {vcEngine === 'local' && (
              <>
                <SubTitle>Local voice (piper on the desktop)</SubTitle>
                <Hint>Picked voice drives the desktop's piper synthesis. The mobile's picker mirrors the desktop dropdown — if the desktop adds a 9th voice, the mobile picks it up on the next refresh.</Hint>
                <View style={{ marginVertical: 6 }}>
                  {(voiceList || LOCAL_VOICES).map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => onPickVoice(v.id)}
                      style={[styles.radioRow, vcLocalId === v.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcLocalId === v.id ? '◉' : '○'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.radioTitle]}>{v.label}</Text>
                        {v.desc && (
                          <Text style={styles.radioSub}>{v.desc}</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
                {voiceList ? null : (
                  <Hint>⏳ Loading voices from desktop...</Hint>
                )}
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
              Currently using: <Text style={{ color: '#10b981', fontWeight: '600' }}>{LOCAL_VOICES.find(v => v.id === effectiveLocalId)?.label || effectiveLocalId}</Text>
              {vcEngine === 'default' && ' (inheriting global)'}
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
  // Defensive re-fetch.
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
        // Fill gaps from listWakeSets.
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
        if (Object.keys(out).length > 0 && !cancelled) setLocalSavedModels(out);
      } catch (_) {}
    };
    fetch();
    // Also re-fetch on focus.
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
      // Prefer the human-friendly displayName for the row's phrase display.
      displayName: merged[c.id].displayName || merged[c.id].phrase,
      savedAt: merged[c.id].savedAt,
    }));

  if (trainedRows.length === 0) {
    // Removed the "No trained wake phrases yet" hardcoded text.
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

// Test voice helpers, moved here from SettingsScreen (the global Voice & Speech section is gone).

/** Test the local Android TTS engine with a fixed phrase. */
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

/** Test the desktop's WebView speechSynthesis with a fixed phrase. */
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

// Animated sprite view window at the top of the settings page.
const VIEW_BOX_W = 240;
const VIEW_BOX_H = 200;
// Same cache-buster as HomeScreen (arena.html doesn't get re-fetched on app upgrade unless we bump the version query param).
const ARENA_HTML_VERSION = '3.10.140';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  // Bumped paddingTop from 16 → 50 on BOTH Android and iOS.
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
  // Animated sprite view window.
  viewWindow: {
    width: VIEW_BOX_W,
    height: VIEW_BOX_H,
    alignSelf: 'center',
    marginVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f7931a',
    overflow: 'hidden',
    backgroundColor: '#0a0a2e',
  },
  // Small label at the bottom of the view window.
  viewWindowLabel: {
    position: 'absolute',
    bottom: 6,
    left: 8,
    right: 8,
    alignItems: 'center',
  },
  viewWindowLabelText: { color: '#aaa', fontSize: 10, fontWeight: '600' },
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
  // "Currently active wake" panel on the Wake sub-page.
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
  // Test-wake button + result styles.
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
  // v3.10.139: Skills section. Mirrors the desktop
  // inspect panel's skill rows (pixel-arena rs-skill-row)
  // but adapted for the mobile dark theme. View-only.
  skillsSection: {
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f7931a',
    padding: 14,
    marginVertical: 6,
  },
  // Tappable header now wraps the whole row (icon + title + xp/desc + chevron).
  skillsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  skillsSectionIcon: { fontSize: 22 },
  skillsSectionTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  // Current XP / XP-to-next-level inline with the title.
  skillsSectionXp: { color: '#f7931a', fontSize: 11, fontWeight: '600' },
  skillsSectionDesc: { color: '#9aa0b4', fontSize: 12, marginTop: 2 },
  // v3.10.175: chevron that rotates 90° when expanded.
  // Same chevron style as the settings cards below for
  // visual consistency.
  skillsSectionChevron: {
    color: '#9aa0b4',
    fontSize: 22,
    marginLeft: 4,
    // Rotate 0° by default (collapsed). transform
    // rotates around the centre of the glyph.
    transform: [{ rotate: '0deg' }],
  },
  skillsSectionChevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  // Character XP bar — always visible, even when the card is collapsed.
  charBar: {
    height: 6,
    backgroundColor: '#222',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 12,
    marginBottom: 4,
  },
  charBarFill: { height: '100%', backgroundColor: '#f7931a' },
  skillsEmpty: {
    backgroundColor: 'rgba(247,147,26,0.08)',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.2)',
    borderStyle: 'dashed',
  },
  skillsEmptyText: { color: '#888', fontSize: 12, fontStyle: 'italic', textAlign: 'center' },
  // Compact 2-col grid replaces the vertical list (skillsList + skillRow*).
  skillsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  skillGridCell: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 6,
  },
  skillGridIcon: { fontSize: 14, width: 18, textAlign: 'center' },
  skillGridRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skillGridName: { color: '#fff', fontSize: 11, flex: 1, marginRight: 4 },
  skillGridLevel: { color: '#f7931a', fontSize: 10, fontWeight: '700' },
  skillGridBar: {
    height: 3,
    backgroundColor: '#222',
    borderRadius: 1.5,
    overflow: 'hidden',
    marginTop: 2,
  },
  skillGridFill: { height: '100%', backgroundColor: '#f7931a' },
  // v3.10.142: behaviour card. Read-only summary of
  // sprite/scale/traits/chattiness with an Edit button
  // that navigates to the existing CompanionEditScreen.
  behaviourCard: {
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f7931a',
    padding: 14,
    marginVertical: 6,
  },
  behaviourHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  behaviourTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  behaviourEditBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#f7931a',
    borderRadius: 6,
  },
  behaviourEditBtnText: { color: '#000', fontSize: 12, fontWeight: '700' },
  // Skills library entry-point card on the companion overview.
  skillsLibraryCard: {
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#3b82f6',
    padding: 14,
    marginVertical: 6,
  },
  skillsLibraryIcon: { fontSize: 22, marginRight: 12 },
  skillsLibraryTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  skillsLibraryDesc: { color: '#9aa0b4', fontSize: 12, marginTop: 2 },
  skillsLibraryChevron: { color: '#9aa0b4', fontSize: 22, marginLeft: 8 },
  behaviourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
  },
  behaviourLabel: { color: '#888', fontSize: 12, width: 90 },
  behaviourValue: { color: '#fff', fontSize: 13, flex: 1 },
  behaviourChattinessBar: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  behaviourChattinessTrack: { flexDirection: 'row', gap: 3, flex: 1 },
  behaviourChattinessTick: {
    flex: 1,
    height: 6,
    backgroundColor: '#222',
    borderRadius: 3,
  },
  behaviourChattinessTickActive: { backgroundColor: '#f7931a' },
  behaviourChattinessNum: { color: '#f7931a', fontSize: 12, fontWeight: '700', minWidth: 16, textAlign: 'right' },
  // Models card bits.
  modelLocalDot: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
  },
  modelDefault: {
    color: '#666',
    fontStyle: 'italic',
  },
  modelFooterHint: {
    color: '#666',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 6,
    lineHeight: 15,
  },
  // Traits as wrap chips.
  traitsChips: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  traitsEmpty: { color: '#666', fontSize: 12, fontStyle: 'italic' },
  traitChip: {
    backgroundColor: 'rgba(247,147,26,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.4)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  traitChipText: { color: '#f7931a', fontSize: 11, fontWeight: '600' },
  // v3.10.142: collapsed settings card. Single row per
  // setting (Wake/Exit/Voice). Shows current value
  // inline + chevron. Tap → existing sub-page.
  settingsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1626',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginVertical: 4,
    gap: 10,
  },
  settingsCardEmoji: { fontSize: 22 },
  settingsCardTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  settingsCardValue: { color: '#10b981', fontSize: 11, marginTop: 2, fontStyle: 'italic' },
  settingsCardArrow: { color: '#888', fontSize: 22, marginLeft: 4 },
  // Visual separator between the "about this companion" sections (view + skills + behaviour) and the "settings" sections (wake/exit/voice).
  overviewSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
    gap: 8,
  },
  overviewSeparatorText: { color: '#666', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
});