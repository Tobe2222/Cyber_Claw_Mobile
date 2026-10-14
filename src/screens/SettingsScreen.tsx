/** SettingsScreen — Mobile companion settings v3.4.7: split "🎤 Voice mode" into two separate Section blocks, each with its own orange… */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Switch, Alert, Platform, PermissionsAndroid, Linking, NativeModules, BackHandler,
  Modal, Pressable, AppState,
} from 'react-native';
const { BackgroundService, WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { audioBuffer, DEFAULT_SETTINGS, AudioBufferSettings } from '../services/AudioBuffer';

import OpenWakeWordTrainer from '../components/OpenWakeWordTrainer';
import ExitPhraseTrainer from '../components/ExitPhraseTrainer';
import WakeSetManagerScreen from '../components/WakeSetManagerScreen';
// Dedicated page for the send word.
import SendWordScreen from '../components/SendWordScreen';
// v3.10.24: shared global speaker-profile bar (full
// variant) at the top of the Voice mode section.
import VoiceEnrollmentBar from '../components/VoiceEnrollmentBar';
// Dedicated page for voice training.
import VoiceTrainingScreen from '../components/VoiceTrainingScreen';
import {
  shouldShowVoiceTrainingCTA,
  deriveSpeakerTier,
} from '../utils/speakerTier';
import { loadSendModelInfo } from '../services/VoiceSettings';
import {
  getPermissions,
  setPermission,
  RemotePermissions,
  RemotePermissionKey,
} from '../services/RemoteToolPermissions';
import { version as APP_VERSION } from '../../package.json';
// v3.10.112: theme system. The toggle in the top header
// drives useTheme(); styles below are built from the same
// theme tokens so each render picks up the right colors.
import { useTheme } from '../theme/ThemeContext';
import type { ThemeName } from '../theme/tokens';
import { Theme } from '../theme/tokens';

const SETTINGS_KEY = 'cyberclaw-mobile-settings';

type PermStatus = 'granted' | 'denied' | 'never_ask_again' | 'unknown';

// Voice catalog is now in src/services/VoiceCatalog.ts so the per-companion voice picker in CompanionSettingsScreen.tsx can reuse it.

export default function SettingsScreen({
  onBack,
  // When the user taps a companion row in the Voice mode list, the detail view is no longer inline — it gets promoted to its own screen via…
  onOpenCompanion,
}: {
  onBack: () => void;
  onOpenCompanion: (companionId: string) => void;
}) {
  // ── Theme (v3.10.112) ───────────────────────────────────────── The toggle in the top header calls setTheme(); useTheme returns the active…
  const { theme, themeName, setTheme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // ── Connection ────────────────────────────────────────────────
  const [hostIp, setHostIp] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  // v3.11.43: drives the pairing box (was keyed on syncClient.connected,
  // which is only true AFTER auth — so the box could never appear).
  const [needsPairing, setNeedsPairing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // ── Permissions ───────────────────────────────────────────────
  const [micPerm, setMicPerm] = useState<PermStatus>('unknown');
  const [notifPerm, setNotifPerm] = useState<PermStatus>('unknown');
  const [wakePerms, setWakePerms] = useState({ canDrawOverlays: false, canUseFullScreenIntent: true });

  // ── Wake Word ─────────────────────────────────────────────────
  const [bgListening, setBgListening] = useState(true);
  // Lightweight native speaker-status subscription for the B-threshold CTA hide/show logic.
  const [speakerSamplesTotal, setSpeakerSamplesTotal] = useState<number>(0);
  const [speakerProfileLocked, setSpeakerProfileLocked] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await WakeWordModule?.getSpeakerStatus?.();
        if (cancelled || !r) return;
        setSpeakerSamplesTotal(r.samplesTotal ?? 0);
        setSpeakerProfileLocked(!!r.profileLocked);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Smart-silence toggle.
  const [smartSilence, setSmartSilence] = useState<boolean>(true);
  // Per-device default quest directory.
  const [defaultQuestDir, setDefaultQuestDir] = useState<string>('');
  // Visual feedback for the Save button.
  const [defaultQuestDirSavedAt, setDefaultQuestDirSavedAt] = useState<number | null>(null);
  // CYBERCLAW.md editor state.
  const [cyberclawContent, setCyberclawContent] = useState<string>('');
  const [cyberclawDefaultContent, setCyberclawDefaultContent] = useState<string>('');
  const [cyberclawPath, setCyberclawPath] = useState<string>('');
  const [cyberclawLoading, setCyberclawLoading] = useState<boolean>(true);
  const [cyberclawSaving, setCyberclawSaving] = useState<boolean>(false);
  const [cyberclawSavedAt, setCyberclawSavedAt] = useState<number | null>(null);
  const [cyberclawResetConfirming, setCyberclawResetConfirming] = useState<boolean>(false);
  // FgThreshold/bgThreshold state + UI removed.
  const [readyPhrase, setReadyPhrase] = useState('Ready to chat');
  const [readyPhraseSavedAt, setReadyPhraseSavedAt] = useState<number | null>(null);
  const readyPhraseSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Exit reply phrase — mirror of the wake greeting.
  const [exitReplyPhrase, setExitReplyPhrase] = useState('Goodbye!');
  const [exitReplySavedAt, setExitReplySavedAt] = useState<number | null>(null);
  const exitReplySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // VoiceSilenceMs state removed.
  const [voiceExitPhrase, setVoiceExitPhrase] = useState('thanks');
  const [voiceExitPhraseSavedAt, setVoiceExitPhraseSavedAt] = useState<number | null>(null);
  // Send word (global, single word).
  const [voiceSendPhrase, setVoiceSendPhrase] = useState('send');
  const [voiceSendPhraseSavedAt, setVoiceSendPhraseSavedAt] = useState<number | null>(null);
  // Your-turn cue sound preference.
  const [voiceTurnCue, setVoiceTurnCue] = useState<string>('off');
  // Working / thinking sound + speech.
  const [voiceWorkingCue, setVoiceWorkingCue] = useState<string>('off');
  const [voiceWorkingSpeech, setVoiceWorkingSpeech] = useState<string>('Working on it...');
  const [voiceWorkingDelayMs, setVoiceWorkingDelayMs] = useState<number>(1500);
  // Trained-model info for the active send word.
  const [sendModelInfo, setSendModelInfo] = useState<{ trainedAt: number; modelPath: string } | null>(null);
  // Reactive load of trained-model info keyed on the *current* send phrase.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const trimmed = voiceSendPhrase.trim().toLowerCase();
      if (!trimmed) {
        setSendModelInfo(null);
        return;
      }
      const info = await loadSendModelInfo(trimmed);
      if (!cancelled) {
        setSendModelInfo(info);
      }
    })();
    return () => { cancelled = true; };
  }, [voiceSendPhrase]);
  // Dedicated page for configuring the send word.
  const [showSendWordScreen, setShowSendWordScreen] = useState(false);
  // Dedicated page for voice training.
  const [showVoiceTraining, setShowVoiceTraining] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioBufferSettings>(DEFAULT_SETTINGS);
  const [audioSettingsSavedAt, setAudioSettingsSavedAt] = useState<number | null>(null);

  // v3.2.0: openWakeWord trainer modal. The legacy DTW-based
  // wake training + tester were removed in v3.2.2 — the
  // openWakeWord pipeline supersedes them.
  const [showOwwTrainer, setShowOwwTrainer] = useState(false);
  // When opening the wake trainer via per-row "Retrain" in the new WakePhrasePicker, the trainer opens pre-loaded with the existing phrase for…
  const [editingWakePhrase, setEditingWakePhrase] = useState<string>('');
  // v3.2.25: exit-phrase trainer modal. Recording 6 samples
  // persists locally; the runtime DTW detector against these
  // samples is wired in v3.2.26.
  const [showExitPhraseTrainer, setShowExitPhraseTrainer] = useState(false);
  // v3.9.0: wake set manager screen — list / activate /
  // rename / delete / pull-from-desktop / push-to-desktop.
  const [showWakeSetManager, setShowWakeSetManager] = useState(false);
  // v3.3.0: pre-fill for the exit trainer when opened
  // from per-row "Retrain" in the ExitPhrasePicker.
  const [editingExitPhrase, setEditingExitPhrase] = useState<string>('');
  // v3.2.1: map of agentId -> {phrase, path, savedAt} for
  // companions that have a saved custom wake model. Used
  // to show "✓ trained" badges in the companion picker.
  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }>>({});
  // SelectedCompanionId / companionViewPhase REMOVED — companion detail view now lives in its own screen (CompanionSettingsScreen) reached via…
  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  // `showCompanionPicker` state + the companion picker Modal are REMOVED.

  // Per-companion wake training.
  const [trainingCompanionId, setTrainingCompanionId] = useState<string | null>(null);
  const [trainingCompanionName, setTrainingCompanionName] = useState<string>('');
  const [availableCompanions, setAvailableCompanions] = useState<Array<{ id: string; name: string; emoji?: string | null; icon?: string | null }>>([]);

  // Hydrate the companion list from local cache on mount.
  // v3.1.67: the wake trainer is per-companion now, so the
  // settings screen needs to know which companions exist.
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
            // Default to the first companion for the trainer
            setTrainingCompanionId(parsed[0].id);
            setTrainingCompanionName(parsed[0].name);
            // Migrate legacy wake-samples keys into the per-companion training entry.
            (async () => {
              try {
                const { migrateLegacyPhraseKeys } = await import('../services/WakeTrainingModel');
                await migrateLegacyPhraseKeys(parsed.map((a: any) => ({ id: a.id, name: a.name })));
              } catch (_) {}
            })();
          }
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate the active-wake-companion preference.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-active-wake-companion');
        if (raw) setActiveWakeCompanionId(raw);
      } catch (_) {}
    })();
  }, []);

  // One-time migration from v3.3.0's global exit storage to per-companion.
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

  // One-time migration from v3.3.0's global exit storage to per-companion.
  useEffect(() => {
    (async () => {
      if (availableCompanions.length === 0) return;
      try {
        const { migrateLegacyExitSamples } = await import('../services/VoiceSettings');
        // Prefer the active wake companion; fall back to
        // the first available companion.
        const targetId = activeWakeCompanionId || availableCompanions[0].id;
        await migrateLegacyExitSamples(targetId);
      } catch (_) {}
    })();
  }, [availableCompanions.length, activeWakeCompanionId]);

  // ── Voice & Speech ──────────────────────────────────────────── v3.10.154: ALL cloud-TTS scaffolding removed.

  // ── Agent Reach ───────────────────────────────────────────────
  const [remotePerms, setRemotePerms] = useState<RemotePermissions>({
    file_read: false,
    file_write: false,
    launch_intent: false,
    get_location: false,
    get_camera: false,
    read_notifications: false,
  });

  // ── Back button: navigate sub-screens first, then exit ─────── Priority (deepest first): 1.
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showOwwTrainer) { setShowOwwTrainer(false); return true; }
      if (showExitPhraseTrainer) { setShowExitPhraseTrainer(false); return true; }
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack, showOwwTrainer, showExitPhraseTrainer]);

  // Stop the bundled pre-trained wake listener while SettingsScreen is mounted.
  useEffect(() => {
    WakeWordModule?.stopOwwListening?.().catch(() => {});
    return () => {
      // v3.2.11: restart the wake listener when the user leaves
      // Settings. The listener's own start() is idempotent
      // (it short-circuits if isListening is already true).
      WakeWordModule?.startOwwListening?.().catch(() => {});
    };
  }, []);

  // Clear pending debounce on unmount
  useEffect(() => () => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
  }, []);

  // Refresh the saved-wake-models map whenever the user opens a companion's detail view (so the Wake phrases list reflects just-completed…
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
        const activeByCompanion: Record<string, string | null> = {};
        await Promise.all(
          availableCompanions.map(async (c: any) => {
            try {
              activeByCompanion[c.id] = await WakeWordModule?.getActiveWakeSet?.(c.id);
            } catch (_) {
              activeByCompanion[c.id] = null;
            }
          }),
        );
        if (cancelled) return;
        const out: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }> = {};
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
        if (allSets && typeof allSets === 'object') {
          for (const c of availableCompanions) {
            if (out[c.id]?.phrase) continue;
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
              out[c.id] = {
                phrase: picked.phrase,
                displayName: picked.displayName || picked.phrase,
                path: picked.path || `wake_models/${picked.setId}/model.tflite`,
                savedAt: picked.createdAt || 0,
              };
            }
          }
        }
        if (!cancelled) setSavedWakeModels(out);
      } catch (_) {
        // best-effort.
      }
    };
    fetch();
    // Also refetch when the screen comes back into focus via the AppState 'active' transition.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [availableCompanions.length]);

  // Hydrate the default quest directory from `cyberclaw-mobile-settings.defaultQuestDir`.
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-mobile-settings').then((raw) => {
      if (!raw) return;
      try {
        const settings = JSON.parse(raw);
        if (typeof settings?.defaultQuestDir === 'string') {
          setDefaultQuestDir(settings.defaultQuestDir);
        }
      } catch { /* malformed — ignore */ }
    });
  }, []);

  // Persist the default quest directory.
  const saveDefaultQuestDir = async () => {
    try {
      const raw = await AsyncStorage.getItem('cyberclaw-mobile-settings');
      const settings = raw ? (JSON.parse(raw) || {}) : {};
      settings.defaultQuestDir = defaultQuestDir.trim();
      await AsyncStorage.setItem(
        'cyberclaw-mobile-settings',
        JSON.stringify(settings),
      );
      setDefaultQuestDirSavedAt(Date.now());
    } catch (e: any) {
      Alert.alert('Save failed', `Could not save default quest directory: ${e?.message || 'unknown error'}`);
    }
  };

  // CYBERCLAW.md (the overarching system prompt) load / save / reset.
  const loadCyberclawSystem = () => {
    setCyberclawLoading(true);
    try {
      syncClient.requestCyberclawSystem?.();
    } catch (e: any) {
      console.warn('[CYBERCLAW] requestCyberclawSystem threw:', e?.message);
      setCyberclawLoading(false);
    }
  };
  const saveCyberclawSystem = async () => {
    setCyberclawSaving(true);
    try {
      await syncClient.saveCyberclawSystem?.(cyberclawContent);
      setCyberclawSavedAt(Date.now());
    } catch (e: any) {
      Alert.alert('Save failed', `Could not save CYBERCLAW.md: ${e?.message || 'unknown error'}`);
    } finally {
      setCyberclawSaving(false);
    }
  };
  const resetCyberclawSystem = async () => {
    if (!cyberclawResetConfirming) {
      setCyberclawResetConfirming(true);
      // Auto-dismiss the confirm prompt after 5 seconds (the user has to tap "Yes, reset" to actually do it).
      setTimeout(() => setCyberclawResetConfirming(false), 5000);
      return;
    }
    setCyberclawResetConfirming(false);
    setCyberclawSaving(true);
    try {
      await syncClient.resetCyberclawSystem?.();
      // The reset event reply carries the new (default) content, which we update via the listener in useEffect.
      setCyberclawSavedAt(Date.now());
    } catch (e: any) {
      Alert.alert('Reset failed', `Could not reset CYBERCLAW.md: ${e?.message || 'unknown error'}`);
    } finally {
      setCyberclawSaving(false);
    }
  };

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    checkPermissions();
    AsyncStorage.getItem('cyberclaw-bg-listening').then(v => { if (v === 'false') setBgListening(false); });
    // v3.10.28: hydrate the smart-silence toggle.
    // Default ON; only the explicit "false" value
    // switches it off.
    AsyncStorage.getItem('cyberclaw-smart-silence').then(v => { if (v === 'false') setSmartSilence(false); });
    // v3.4.7: removed fgThreshold/bgThreshold hydration.
    // Their UI was removed; AsyncStorage keys are still
    // read by HomeScreen/WakeModeScreen with sane defaults.
    AsyncStorage.getItem('cyberclaw-ready-phrase').then(v => { if (v) setReadyPhrase(v); });
    // Hydrate the exit reply phrase (mirror of the wake greeting hydration above).
    AsyncStorage.getItem('cyberclaw-exit-reply-phrase').then(v => { if (v != null) setExitReplyPhrase(v); });
    // Voice-silence-ms hydration removed.
    AsyncStorage.getItem('cyberclaw-voice-exit-phrase').then(v => {
      // v3.2.20 — single phrase. Also migrate from the old
      // array format if present (first phrase wins).
      if (v !== null) {
        setVoiceExitPhrase(v);
      } else {
        AsyncStorage.getItem('cyberclaw-voice-exit-phrases').then(old => {
          if (old) {
            try {
              const arr = JSON.parse(old);
              if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string') {
                setVoiceExitPhrase(arr[0]);
              }
            } catch (_) {}
          }
        });
      }
    });
    // v3.6.0: hydrate the global send word. Default 'send'
    // if no value stored yet (first-time setup).
    AsyncStorage.getItem('cyberclaw-send-phrase').then(v => {
      if (v !== null) {
        const trimmed = v.trim().toLowerCase();
        if (trimmed) setVoiceSendPhrase(trimmed);
      }
    });
    // v3.9.8: hydrate the your-turn cue sound preference.
    // Default 'off' (no sound) for users on older builds
    // who never had this option.
    AsyncStorage.getItem('cyberclaw-voice-turn-cue').then(v => {
      if (v && ['off', 'bird', 'bell', 'ding', 'chime'].includes(v)) {
        setVoiceTurnCue(v);
      }
    });
    // v3.10.34: hydrate the working cue + speech + delay.
    // Each defaults to the matching DEFAULT_* in
    // VoiceSettings.ts if the user has never set a value.
    AsyncStorage.getItem('cyberclaw-voice-working-cue').then(v => {
      if (v && ['off', 'bird', 'bell', 'ding', 'chime'].includes(v)) {
        setVoiceWorkingCue(v);
      }
    });
    AsyncStorage.getItem('cyberclaw-voice-working-speech').then(v => {
      if (v !== null && v.trim() !== '') setVoiceWorkingSpeech(v);
    });
    AsyncStorage.getItem('cyberclaw-voice-working-delay-ms').then(v => {
      const n = v ? parseInt(v, 10) : NaN;
      if (!isNaN(n) && n >= 800 && n <= 5000) setVoiceWorkingDelayMs(n);
    });
    // V3.8.3 → v3.8.7: hydrate the trained-model info.
    AsyncStorage.getItem(SETTINGS_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          if (saved.audioSettings) setAudioSettings(saved.audioSettings);
        } catch {}
      }
    });
    // Optional-chain the .then().catch() chain too.
    const permPromise = NativeModules.NativeBackground?.checkWakePermissions?.();
    permPromise?.then?.((p: any) => setWakePerms(p))?.catch?.(() => {});

    // Voice settings (new in v3.1.13) v3.1.75: cyberclaw-voice-engine replaces cyberclaw-voice-local.

    syncClient.loadSaved().then(({ host }) => { if (host) setHostIp(host); });
    getPermissions().then(p => setRemotePerms(p)).catch(() => {});

    const onStateChange = (data: any) => {
      const s = data.state;
      if (s === 'connected' || s === 'reconnecting') setConnectionStatus('Connected ✓');
      else if (s === 'connecting') setConnectionStatus(prev => prev.includes('not paired') ? prev : 'Connecting...');
      else if (s === 'lost') setConnectionStatus('Connection lost ✕');
      else setConnectionStatus('Disconnected');
    };
    if (syncClient.connected) setConnectionStatus('Connected ✓');
    syncClient.on('state_change', onStateChange);
    const onPairingRequired = (msg: any) => {
      setNeedsPairing(true);
      setConnectionStatus('Connected — not paired');
      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setDebugLog(prev => [...prev, `[${ts}] 🔒 ${msg?.reason === 'token_rejected' ? 'This desktop does not know this phone' : 'Not paired yet'} — enter the pairing code below`]);
    };
    syncClient.on('pairing_required', onPairingRequired);
    syncClient.on('authenticated', () => setNeedsPairing(false));
    syncClient.on('paired', () => {
      setNeedsPairing(false);
      setConnectionStatus('Connected ✓');
      Alert.alert('Paired!', 'Mobile app is now linked to your desktop CyberClaw.');
    });
    syncClient.on('pair_failed', (msg: any) => {
      Alert.alert('Pairing Failed', msg.error || 'Wrong code or expired.');
    });
    // CYBERCLAW.md listener.
    const onCyberclawSystem = (msg: any) => {
      if (!msg || !msg.ok) {
        setCyberclawLoading(false);
        return;
      }
      setCyberclawContent(msg.content || '');
      setCyberclawDefaultContent(msg.defaultContent || '');
      setCyberclawPath(msg.path || '');
      setCyberclawLoading(false);
    };
    syncClient.on('cyberclaw_system', onCyberclawSystem);

    // Also subscribe to agents_list broadcasts and REPLACE the cache + local state with the broadcast's authoritative list.
    const onAgentsList = (msg: any) => {
      if (!msg?.agents || !Array.isArray(msg.agents)) return;
      AsyncStorage.setItem(
        'cyberclaw-agents-cache',
        JSON.stringify(msg.agents),
      ).catch(() => {});
      // Refresh local state so the list of
      // companions in the Settings UI shows the
      // latest names/sprites immediately.
      setAvailableCompanions(msg.agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        emoji: a.emoji || null,
        icon: a.icon || null,
      })));
    };
    syncClient.on('agents_list', onAgentsList);
    // Fire the initial fetch once on mount and again whenever the WS connection comes back.
    const fireFetch = () => loadCyberclawSystem();
    fireFetch();
    return () => {
      syncClient.off('state_change', onStateChange);
      syncClient.off('pairing_required', onPairingRequired);
      syncClient.off('cyberclaw_system', onCyberclawSystem);
      // v3.10.150: cleanup the agents_list listener too.
      syncClient.off('agents_list', onAgentsList);
    };
  }, []);

  // ── Permission helpers ────────────────────────────────────────
  const checkPermissions = async () => {
    if (Platform.OS !== 'android') return;
    try {
      const mic = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      setMicPerm(mic ? 'granted' : 'denied');
      if (Platform.Version >= 33) {
        const notif = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as any);
        setNotifPerm(notif ? 'granted' : 'denied');
      } else {
        setNotifPerm('granted');
      }
    } catch {}
  };

  const requestPermission = async (perm: string) => {
    try {
      const result = await PermissionsAndroid.request(perm as any);
      checkPermissions();
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        Alert.alert('Permission blocked', 'Go to Settings → Apps → CyberClaw → Permissions to enable it.', [
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
          { text: 'Cancel' },
        ]);
      }
    } catch {}
  };

  const openWakePerm = async (settingsFn: string) => {
    await NativeModules.NativeBackground?.[settingsFn]?.();
    setTimeout(async () => {
      // Optional-chain .catch() too.
      const promise = NativeModules.NativeBackground?.checkWakePermissions?.();
      const p = promise ? await promise.catch(() => null) : null;
      if (p) setWakePerms(p);
    }, 1000);
  };

  // ── Connection handlers ──────────────────────────────────────
  const connectToDesktop = async () => {
    const ip = hostIp.trim();
    if (!ip) { Alert.alert('Error', 'Enter your desktop IP address'); return; }

    const log = (msg: string) => {
      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setDebugLog(prev => [...prev, `[${ts}] ${msg}`]);
    };

    const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
    const isIPv6 = /^[0-9a-fA-F:]+$/.test(ip.replace(/^\[|\]$/g, ''));
    const isDomain = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(ip);
    log(`Input: "${ip}"`);
    log(`Type: ${isIPv4 ? 'IPv4' : isIPv6 ? 'IPv6' : isDomain ? 'Domain' : 'Unknown'}`);

    if (!isIPv4 && !isIPv6 && !isDomain) {
      log('❌ Invalid address format');
      Alert.alert('Invalid Address', 'Enter a valid IPv4, IPv6, or hostname.');
      return;
    }
    if (isIPv6) {
      const clean = ip.replace(/^\[|\]$/g, '');
      const groups = clean.split(':').filter(g => g.length > 0);
      if (!clean.includes('::') && groups.length !== 8) {
        log(`❌ Invalid IPv6 (${groups.length} groups)`);
        Alert.alert('Invalid IPv6', `IPv6 needs 8 groups (got ${groups.length}).`);
        return;
      }
    }
    const cleanHost = ip.replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
    const wsHost = cleanHost.includes(':') ? `[${cleanHost}]` : cleanHost;
    log(`Connecting to: ws://${wsHost}:9247`);

    try {
      setConnectionStatus('Connecting...');
      log('⏳ WebSocket connecting...');
      await syncClient.connect(ip);
      log('✅ Connected!');
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      log(`❌ Failed: ${errMsg}`);
      setConnectionStatus('Failed to connect');
      Alert.alert('Connection Failed', `${errMsg}\n\nMake sure:\n• CyberClaw is running on desktop\n• Port 9247 is forwarded on router\n• IP address is correct`);
    }
  };

  const pairDevice = async () => {
    if (!pairingCode.trim() || pairingCode.length !== 6) {
      Alert.alert('Error', 'Enter the 6-digit pairing code from your desktop');
      return;
    }
    // v3.11.43: the desktop drops unpaired sockets after 30s. If that
    // happened while typing the code, reconnect first, then pair.
    try {
      if (!syncClient.socketOpen) {
        const ip = hostIp.trim();
        if (!ip) { Alert.alert('Error', 'Enter your desktop IP address'); return; }
        await syncClient.connect(ip);
      }
      syncClient.pair(pairingCode.trim(), 'Android Phone');
    } catch (e: any) {
      Alert.alert('Pairing Failed', 'Could not reach the desktop: ' + (e?.message || String(e)));
    }
  };

  // ── Settings handlers ────────────────────────────────────────
  const toggleRemotePerm = async (key: RemotePermissionKey, value: boolean) => {
    setRemotePerms(prev => ({ ...prev, [key]: value }));
    await setPermission(key, value);
  };

  const updateAudio = (key: keyof AudioBufferSettings, value: any) => {
    setAudioSettings(prev => ({ ...prev, [key]: value }));
  };

  const saveAudioSettings = async () => {
    const data = { audioSettings };
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    audioBuffer.updateSettings(audioSettings);
    setAudioSettingsSavedAt(Date.now());
  };

  // Update the your-turn cue sound preference.
  const updateVoiceTurnCue = async (cue: string) => {
    setVoiceTurnCue(cue);
    try {
      await AsyncStorage.setItem('cyberclaw-voice-turn-cue', cue);
    } catch (_) {}
  };

  // Working / thinking settings.
  const updateVoiceWorkingCue = async (cue: string) => {
    if (!['off', 'bird', 'bell', 'ding', 'chime'].includes(cue)) return;
    setVoiceWorkingCue(cue);
    try {
      await AsyncStorage.setItem('cyberclaw-voice-working-cue', cue);
    } catch (_) {}
  };
  const saveVoiceWorkingSpeech = async () => {
    const trimmed = voiceWorkingSpeech.trim().slice(0, 60);
    try {
      await AsyncStorage.setItem('cyberclaw-voice-working-speech', trimmed);
    } catch (_) {}
  };
  // Debounced auto-save for the working speech text input.
  const workingSpeechSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [workingSpeechSavedAt, setWorkingSpeechSavedAt] = useState<number | null>(null);
  const persistWorkingSpeech = (v: string) => {
    if (workingSpeechSaveTimer.current) clearTimeout(workingSpeechSaveTimer.current);
    workingSpeechSaveTimer.current = setTimeout(async () => {
      const trimmed = v.trim().slice(0, 60);
      try {
        await AsyncStorage.setItem('cyberclaw-voice-working-speech', trimmed);
        setWorkingSpeechSavedAt(Date.now());
        // Re-warm the piper cache for the new phrase.
        if (trimmed && trimmed !== 'off') {
          try {
            const { ensureWorkingSpeechCached } = require('../services/WorkingSpeechAudioCache');
            // Now async (resolves voice from AsyncStorage internally).
            ensureWorkingSpeechCached(trimmed).catch(() => {});
          } catch (_) {}
        }
      } catch (_) {}
    }, 600);
  };
  const saveVoiceWorkingDelay = async (ms: number) => {
    const clamped = Math.max(800, Math.min(5000, Math.round(ms)));
    setVoiceWorkingDelayMs(clamped);
    try {
      await AsyncStorage.setItem('cyberclaw-voice-working-delay-ms', String(clamped));
    } catch (_) {}
  };

  // Debounced auto-save for wake greeting
  const persistReadyPhrase = (v: string) => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
    readyPhraseSaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-ready-phrase', v);
      setReadyPhraseSavedAt(Date.now());
      // Kick off a desktop synthesis for the new phrase so the next wake event has a cached audio to play.
      if (v && v.trim()) {
        try {
          const { ensureGreetingCached } = require('../services/GreetingAudioCache');
          // v3.10.166: now async; .catch to silence
          // unhandled rejection.
          ensureGreetingCached(v.trim()).catch(() => {});
        } catch (_) {}
      }
    }, 600);
  };

  // Persist the exit reply phrase.
  const persistExitReplyPhrase = (v: string) => {
    if (exitReplySaveTimer.current) clearTimeout(exitReplySaveTimer.current);
    exitReplySaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-exit-reply-phrase', v);
      setExitReplySavedAt(Date.now());
      if (v && v.trim()) {
        try {
          const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
          ensureExitReplyCached(v.trim()).catch(() => {});
        } catch (_) {}
      }
    }, 600);
  };

  // Voice settings (auto-save on change) v3.1.75: removed setVoiceLocalEnabledAndSave.

  // Removed the legacy DTW-based wake training (WakePhraseMenu / TrainingDetailScreen / WakeWordTester).
  if (showOwwTrainer) {
    return (
      <OpenWakeWordTrainer
        companionId={trainingCompanionId || 'unknown'}
        companionName={trainingCompanionName || 'Companion'}
        presetPhrase={editingWakePhrase || undefined}
        onComplete={(ok) => {
          setShowOwwTrainer(false);
          setEditingWakePhrase('');
          // Refresh the saved-models list so the '✓ trained'
          // badges in the companion picker update immediately.
          if (ok) {
            WakeWordModule?.getSavedWakeModels?.()
              .then((models: any) => {
                if (!models) return;
                const out: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }> = {};
                for (const agentId of Object.keys(models)) {
                  const entry = models[agentId];
                  if (entry?.phrase && entry?.path) {
                    out[agentId] = {
                      phrase: entry.phrase,
                      // Include displayName from the native response so the companion list row shows the human-friendly name.
                      displayName: entry.displayName || entry.phrase,
                      path: entry.path,
                      savedAt: entry.savedAt || 0,
                    };
                  }
                }
                setSavedWakeModels(out);
              })
              .catch(() => {});
          }
        }}
        onCancel={() => {
          setShowOwwTrainer(false);
          setEditingWakePhrase('');
        }}
      />
    );
  }

  // v3.2.25 — exit-phrase trainer. Saves 6 audio samples +
  // extracted features to AsyncStorage. Runtime detector
  // against these samples is v3.2.26.
  if (showExitPhraseTrainer) {
    return (
      <ExitPhraseTrainer
        // Trainer writes to per-companion keys.
        companionId={
          activeWakeCompanionId ||
          availableCompanions[0]?.id ||
          'default'
        }
        presetPhrase={editingExitPhrase || undefined}
        onCancel={() => {
          setShowExitPhraseTrainer(false);
          setEditingExitPhrase('');
        }}
        onComplete={() => {
          setShowExitPhraseTrainer(false);
          setEditingExitPhrase('');
        }}
      />
    );
  }

  // Wake set manager.
  if (showWakeSetManager) {
    return (
      <WakeSetManagerScreen
        agentId={
          activeWakeCompanionId ||
          availableCompanions[0]?.id ||
          'clawsuu'
        }
        agentName={
          (() => {
            const id = activeWakeCompanionId || availableCompanions[0]?.id;
            const a = (availableCompanions || []).find((x: any) => x.id === id);
            return a?.name || id || 'Companion';
          })()
        }
        onBack={() => setShowWakeSetManager(false)}
      />
    );
  }

  // Dedicated send-word page.
  if (showSendWordScreen) {
    return (
      <SendWordScreen
        phrase={voiceSendPhrase}
        savedAt={voiceSendPhraseSavedAt}
        modelInfo={sendModelInfo}
        onPhraseChange={(text) => {
          // V3.8.3 reactive load: keep the parent's loadSendModelInfo effect in sync by mirroring the phrase change here.
          setVoiceSendPhrase(text);
        }}
        onSaved={(trimmed) => {
          setVoiceSendPhrase(trimmed);
          setVoiceSendPhraseSavedAt(Date.now());
          // Refresh model info so the badge updates
          // immediately after a successful training run.
          loadSendModelInfo(trimmed).then(info => {
            if (info) setSendModelInfo(info);
          });
        }}
        onBack={() => setShowSendWordScreen(false)}
      />
    );
  }

  // Voice training page.
  if (showVoiceTraining) {
    return (
      <VoiceTrainingScreen
        onBack={() => setShowVoiceTraining(false)}
      />
    );
  }

  // ── Main settings render ───────────────────────────────────── v3.10.36: header (← Back + title) pulled OUT of the ScrollView so it stays…
  return (
    <>
    <View style={styles.fixedTopHeader}>
      <TouchableOpacity onPress={onBack}>
        <Text style={styles.backBtn}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Settings</Text>
      {/* v3.10.119: three-way theme segmented control.
          Replaces the v3.10.112 single-toggle button.
          The order left-to-right matches Tobe's mental
          model (sun → forest → moon). The active theme
          is highlighted with the brand accent + a
          border ring. Each button calls setTheme()
          directly rather than cycling (the v3.10.118
          `toggle` still cycles for backwards compat
          with any other call sites, but the user
          always sees all three options here). */}
      <View style={styles.themeSegControl}>
        {(['light', 'forest', 'dark'] as ThemeName[]).map((id) => {
          const isActive = themeName === id;
          const icon = id === 'light' ? '☀️' : id === 'forest' ? '🌳' : '🌙';
          const label = id === 'light' ? 'Sun' : id === 'forest' ? 'Forest' : 'Moon';
          const a11y = id === 'light' ? 'Sun (light) theme'
                     : id === 'forest' ? 'Forest theme'
                     : 'Moon (dark) theme';
          return (
            <TouchableOpacity
              key={id}
              onPress={() => setTheme(id)}
              style={[styles.themeSegBtn, isActive && styles.themeSegBtnActive]}
              accessibilityRole="button"
              accessibilityLabel={a11y}
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.themeSegIcon, isActive && styles.themeSegIconActive]}>
                {icon}
              </Text>
              <Text style={[styles.themeSegLabel, isActive && styles.themeSegLabelActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* ── 🔗 Connection ────────────────────────────────────── */}
      <Section title="🔗 Connection" desc="Connect to your desktop CyberClaw to sync your companion.">
        <Label>Desktop IP Address</Label>
        <Hint>Same network: use local IP (Settings → 📱 Mobile Companion → Local IP){'\n'}Remote: use your public IP and forward port 9247 on your router</Hint>
        <TextInput
          style={styles.input}
          value={hostIp}
          onChangeText={setHostIp}
          placeholder="192.168.1.100"
          placeholderTextColor="#555"
          keyboardType="default"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.button, connectionStatus.includes('✓') && styles.buttonConnected]}
          onPress={connectionStatus.includes('✓') ? () => { syncClient.disconnect(); setConnectionStatus('Disconnected'); } : connectToDesktop}
        >
          <Text style={[styles.buttonText, connectionStatus.includes('✓') && styles.buttonTextConnected]}>
            {connectionStatus.includes('✓') ? 'Disconnect' : 'Connect'}
          </Text>
        </TouchableOpacity>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot,
            connectionStatus.includes('✓') ? styles.dotGreen :
            connectionStatus.includes('Connecting') ? styles.dotYellow : styles.dotRed]} />
          <Text style={styles.statusText}>{connectionStatus}</Text>
        </View>

        {needsPairing && (
          <>
            <View style={styles.divider} />
            <Label>Pairing Code (from desktop)</Label>
            <TextInput
              style={styles.input}
              value={pairingCode}
              onChangeText={setPairingCode}
              placeholder="123456"
              placeholderTextColor="#555"
              keyboardType="number-pad"
              maxLength={6}
            />
            <TouchableOpacity style={styles.button} onPress={pairDevice}>
              <Text style={styles.buttonText}>Pair</Text>
            </TouchableOpacity>
            <Hint>On your desktop CyberClaw, go to Settings → Mobile → Generate Pairing Code</Hint>
          </>
        )}

        <View style={styles.debugBox}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={styles.debugBoxTitle}>Connection Log</Text>
            {debugLog.length > 0 && (
              <TouchableOpacity onPress={() => setDebugLog([])}>
                <Text style={styles.debugBoxClear}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
          {debugLog.length === 0 ? (
            <Text style={[styles.debugLine, { color: '#444' }]}>No connection attempts yet</Text>
          ) : (
            debugLog.map((line, i) => <Text key={i} style={styles.debugLine}>{line}</Text>)
          )}
        </View>
      </Section>

      {/* ── 🔒 Permissions ───────────────────────────────────── */}
      <Section title="🔒 Permissions" desc="Required for voice, wake word, and background features.">
        {[
          { label: 'Microphone', status: micPerm, perm: PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, desc: 'Voice chat and wake word detection' },
          { label: 'Notifications', status: notifPerm, perm: PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, desc: 'Background service indicator' },
        ].map(({ label, status, perm, desc }) => (
          <View key={label} style={styles.permRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.permLabel}>{status === 'granted' ? '✅' : '❌'} {label}</Text>
              <Text style={styles.permDesc}>{desc}</Text>
            </View>
            {status !== 'granted' && (
              <TouchableOpacity style={styles.permBtn} onPress={() => requestPermission(perm as any)}>
                <Text style={styles.permBtnText}>Grant</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        <SubTitle>Wake word permissions</SubTitle>
        <View style={styles.toggleRow}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>
              {wakePerms.canDrawOverlays ? '✅' : '⚠️'} Draw over other apps
            </Text>
            <Text style={styles.toggleSub}>Required to open the app over the lock screen</Text>
          </View>
          <TouchableOpacity
            onPress={() => openWakePerm('openOverlaySettings')}
            style={[styles.permBtnSmall, { backgroundColor: wakePerms.canDrawOverlays ? '#1a3a1a' : '#3a2a00' }]}
          >
            <Text style={{ color: wakePerms.canDrawOverlays ? '#4caf50' : '#f7931a', fontSize: 12 }}>
              {wakePerms.canDrawOverlays ? 'Granted' : 'Grant'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.toggleRow}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>
              {wakePerms.canUseFullScreenIntent ? '✅' : '⚠️'} Full screen alerts
            </Text>
            <Text style={styles.toggleSub}>Allows wake alert to open app instantly (Android 14+)</Text>
          </View>
          <TouchableOpacity
            onPress={() => openWakePerm('openFullScreenIntentSettings')}
            style={[styles.permBtnSmall, { backgroundColor: wakePerms.canUseFullScreenIntent ? '#1a3a1a' : '#3a2a00' }]}
          >
            <Text style={{ color: wakePerms.canUseFullScreenIntent ? '#4caf50' : '#f7931a', fontSize: 12 }}>
              {wakePerms.canUseFullScreenIntent ? 'Granted' : 'Grant'}
            </Text>
          </TouchableOpacity>
        </View>
      </Section>

      {/* ── 🎤 Wake settings ────────────────────────────────────── */}
      {/* v3.3.0: Settings UI reorganized into two parallel groups
          (Wake + Exit), each with the same internal shape:
            response (top)
            phrases list with active selector + per-row actions
            train-new button
            advanced controls (bottom)
          The flat "Wake Word" section that combined wake and exit
          in one place is gone. v3.4.0 replaces the v3.3.0
          two-section layout with a 3-level hierarchy:
            (top) 🎤 Voice mode — companion list, audio buffer,
                  silence timeout, match thresholds
            (mid) tap a companion → per-companion detail view
                  (greeting, reply, wake phrases, exit phrases,
                  train buttons)
          Wake/Exit are no longer top-level sections; they're
          features of each companion, reachable via the list. */}

      {/* v3.4.4: the per-companion detail view is NO LONGER
          rendered inline here. Tapping a companion in the
          top-level Voice mode list opens it as its own full
          screen via App.tsx (route 'companion' →
          CompanionSettingsScreen). SettingsScreen now just
          shows the top-level Voice mode section always. */}
      <>
          {/* ── 🎧 Wake listening (own Section, orange border) ──
              v3.7.2: renamed from "Companion listening" to
              "Wake listening" — the section now only governs
              the wake-word pipeline (master background-
              listening toggle). The voice-mode silence
              timeout moved to each companion's Voice sub-page
              (it's a per-companion setting: chatty vs terse
              companions can have different silence). "Wake
              listening" makes the section's scope clear and
              is shorter than "Companion listening". */}
          {/* v3.10.47: removed the standalone 🎧 Wake listening
              Section. Tobe asked for the Background listening
              toggle to live at the top of the 🎙️ Voice mode
              section instead — it's a global mic behavior
              control, sits naturally alongside Smart silence
              (also global mic behavior) and the speaker-profile
              bar (global cross-companion). Per-companion
              wake/exit training already lives in the 🐾
              Companions section via the wake/exit cards.

              Removing this section also collapses the
              duplicate "Wake listening" description that
              was confusingly close to the 🎤 Wake settings
              cards just above it (both called themselves
              "wake listening" but meant different things —
              the cards were navigation, the section was the
              master toggle). The toggle is now first under
              🎙️ Voice mode with its hint intact. */}

          {/* v3.4.7: split "Voice mode" into TWO separate
              Sections, each with its own orange border.
              Wake listening (global mic behavior) and
              Companions (per-companion wake/exit training)
              are conceptually different things — keeping
              them in one Section with a divider read as
              "these are sub-parts of one thing" which they
              aren't. Two distinct Section blocks makes the
              visual grouping match the conceptual grouping.
              Tobe's feedback after v3.4.6: the divider was
              still too subtle. */}
          {/*
            v3.10.138: section header emoji now follows the
            active companion's emoji/icon so it visibly
            tracks which companion is active. Tobe's
            feedback after v3.10.137: the static 🐾 header
            didn't update when he switched from Clawsuu (🦌)
            back to a boar companion — it stayed 🦌 (or,
            before this change, the static 🐾 never moved
            at all). Now it resolves to the active
            companion's emoji, falling back to 🐾 if no
            companion is set or none has an emoji/icon yet.
          */}
          <Section
            title={`${
              (() => {
                const activeId = activeWakeCompanionId || availableCompanions[0]?.id;
                const active = availableCompanions.find(c => c.id === activeId);
                return active?.emoji || active?.icon || '🐾';
              })()
            } Companions`}
            desc="Tap a companion to configure their wake phrase, exit phrase, greeting, and reply."
          >
            {availableCompanions.length === 0 ? (
              <View style={styles.trainedPickerHint}>
                <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
                  No companions yet. Connect to the desktop to load your companions.
                </Text>
              </View>
            ) : (
              <View style={styles.companionList}>
                {availableCompanions.map(c => {
                  // Removed the green active indicator from the Settings companion list row.
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.companionListRow}
                      onPress={() => onOpenCompanion(c.id)}
                    >
                      <Text style={styles.companionListEmoji}>{c.emoji || c.icon || '🐾'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.companionListName}>
                          {c.name}
                        </Text>
                      </View>
                      <Text style={styles.companionListArrow}>›</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* v3.6.2: moved here from the Listening settings
                section. The send word is a per-user habit, not
                a per-companion setting (one send word across
                all companions, like the wake word itself), but
                it conceptually belongs with the other "voice
                mode send behaviour" controls that already
                live near the Companion group. Per-companion
                voice settings (engine / voice picker) are
                coming in v3.7.0 — see the 🔊 Voice & Speech
                section below. */}
            {/*
              v3.10.6: Send word + Your-turn cue sound moved
              out of this Section into their own top-level
              "🎙️ Voice mode" Section below (after the
              </Section>). They're universal settings, not
              per-companion, so visually grouping them
              under Companions was misleading.
            */}
          </Section>

          {/*
            v3.10.6: NEW top-level Section for universal
            voice-mode behaviour. See the comment at the
            end of the Companions Section for why this
            was split out.

            The SendPhraseTrainer modal (separate route)
            is unchanged — this is just the placement of
            the settings/shortcuts inside the page.
          */}
          <Section title="🎙️ Voice mode" desc="Voice-mode behaviour shared across every companion. Per-companion settings (engine, voice picker, silence timeout) live in each companion's detail page.">
            {/* v3.10.47: Background listening toggle moved
                to the top of the Voice mode section. Was
                previously in its own 🎧 Wake listening
                section above (between Wake settings
                cards and Companions), which sat close
                enough to the 🎤 Wake settings cards that
                both called themselves "wake listening"
                with different meanings (one was
                navigation, one was the master toggle).
                Tobe: "i think we could put that setting
                in the top of the voice mode section."
                The toggle controls global mic behavior
                so it sits naturally next to the other
                global voice-mode controls (Smart
                silence, VoiceEnrollmentBar). The Hint
                below the toggle is preserved verbatim. */}
            <Toggle
              title="🎧 Background listening"
              sub="Keep the microphone active in the background. The app wakes on your phrase."
              value={bgListening}
              onValueChange={async (val) => {
                setBgListening(val);
                await AsyncStorage.setItem('cyberclaw-bg-listening', String(val));
                if (val) {
                  const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
                  const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey clawsuu') : 'hey clawsuu';
                  try { await BackgroundService?.start?.(phrase); } catch {}
                  Alert.alert('✅ Enabled', 'Background listening is on. App will wake on your phrase.');
                } else {
                  try { await BackgroundService?.stop?.(); } catch {}
                  Alert.alert('🔕 Disabled', 'Background listening is off.');
                }
              }}
            />
            <Hint>When on, the app keeps the microphone active in the background and wakes on your phrase. Per-companion voice settings (engine, voice, silence) live in each companion's detail page.</Hint>

            {/* v3.10.24: global speaker-profile progress
                bar. The bar lives here at the top of the
                Voice mode section because it's a
                cross-companion setting (the user's voice
                is one thing, not N things). The compact
                twin appears at the top of voice-mode
                screens so the user can watch it fill as
                they talk — same colors and animation so
                they read as the same indicator. */}
            {/* v3.10.30: switched to the compact pill
                variant so the bar looks the same in
                settings and in voice mode. The pill
                has the moving internal progress bar
                (the "1/1000 indication" Tobe asked
                for) so the user can see the count
                tick up as they use voice mode. */}
            <VoiceEnrollmentBar variant="compact" />

            {/* v3.10.165: dedicated reset button so the
                user can wipe the speaker profile and the
                20/20 sample count without scrolling for
                the Clear-profile button inside the
                enrollment panel. Tobe hit the locked
                20/20 state on 2026-08-12 and had no
                visible way to start fresh. */}
            <View style={{ marginTop: 8, marginBottom: 4 }}>
              <TouchableOpacity
                style={styles.saveAudioBtn}
                onPress={() => {
                  Alert.alert(
                    'Delete voice samples?',
                    'Wipes the speaker profile + all enrolled samples. The wake word will respond to anyone again until you re-enroll.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          try {
                            // Native clear + ALSO wipe the JS-side active contributions counter so the VoiceEnrollmentBar drops to 0/N.
                            await WakeWordModule?.clearSpeakerEnrollment?.();
                            await AsyncStorage.removeItem('cyberclaw-voice-enrollment-active');
                            console.log('[Settings] Cleared native enrollment + JS active contributions');
                          } catch (e: any) {
                            console.warn('[Settings] clearSpeakerEnrollment failed:', e?.message);
                          }
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={styles.saveAudioBtnText}>🗑️ Delete voice samples & start fresh</Text>
              </TouchableOpacity>
            </View>

            {/*
              v3.10.66: explicit speaker-enrollment panel,
              moved from each companion's wake settings
              (where it was duplicated N times). The
              speaker profile is device-wide (one user's
              voice, one profile), so the panel belongs
              in a single place. The compact bar above
              shows live progress; this card is the
              dedicated 30-second enrollment session.

              Active enrollment holds the mic for 30s.
              While it's running, BG wake listening is
              paused (EnrollmentCoordinator gates the
              AudioRecord). After "Stop early" or the
              natural 30s end, BG listening resumes
              automatically — the panel doesn't need a
              "restart wake" button.

              Strict-mode toggle now lives inside the
              panel (v3.10.62). Toggling it while the
              profile is locked causes BG wake to use
              OWW-TFLite only (Vosk processing skipped).
              Battery saver when you're not expecting
              spontaneous wake fires.

              v3.10.168: pulled this whole block out
              into VoiceTrainingScreen. The Settings
              entry is now a single button that opens
              that screen; the button hides when
              natural accumulation has the user's
              sample count past the B-threshold (20) —
              the explicit 30s pass doesn't add value
              over natural training once we have that
              many samples, so the button is hidden to
              keep the Settings page compact (Tobe's
              2026-08-14 ask).
            */}
            <SubTitle>🗣️ Train my voice</SubTitle>
            <Hint>Lock the speaker profile in ~30 seconds. After it's locked, wake fires are gated to your voice — other speakers won't trigger the app.</Hint>
            {shouldShowVoiceTrainingCTA({
              samplesTotal: speakerSamplesTotal,
              profileLocked: speakerProfileLocked,
            }) ? (
              <TouchableOpacity
                style={[styles.saveAudioBtn, { marginTop: 4 }]}
                onPress={() => setShowVoiceTraining(true)}
              >
                <Text style={styles.saveAudioBtnText}>
                  {speakerProfileLocked
                    ? `🎤 Voice profile locked — Tier ${deriveSpeakerTier({ samplesTotal: speakerSamplesTotal, profileLocked: speakerProfileLocked })} · retrain →`
                    : speakerSamplesTotal > 0
                      ? `🎤 Continue training (${speakerSamplesTotal}/20 samples) →`
                      : '🎤 Start voice training →'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.trainingActiveRow}>
                <Text style={styles.trainingActiveText}>
                  ✓ Voice training active — keep talking. Tier{' '}
                  {deriveSpeakerTier({
                    samplesTotal: speakerSamplesTotal,
                    profileLocked: speakerProfileLocked,
                  })}
                  , {speakerSamplesTotal.toLocaleString()} samples so far. Clear
                  profile to retrain from scratch.
                </Text>
              </View>
            )}

            {/* v3.10.28: smart-silence toggle. The
                noise-aware silence detector calibrates
                the silence threshold from the gap
                between the user's speech level and the
                ambient noise floor, so it works in
                cafés / traffic / HVAC noise where
                ambient RMS exceeds the old hardcoded
                0.005 silence threshold. Default ON. */}
            <Toggle
              title="🤫 Smart silence (noise-aware)"
              sub="Calibrates the silence threshold from the gap between your speech and the ambient noise. Works in cafés, traffic, HVAC. Default ON."
              value={smartSilence}
              onValueChange={async (val) => {
                setSmartSilence(val);
                await AsyncStorage.setItem('cyberclaw-smart-silence', String(val));
              }}
            />

            {/* v3.10.167: send word moved to its own dedicated
                page (SendWordScreen). The Voice mode section
                used to have a 100+ line inline block here
                covering phrase input, save, train button,
                trained-model badge, and classifier test.
                Tobe (2026-08-14): "compact the send word
                and just make a page out of it with a
                button for it in the settings." The page
                owns its own trainer state and re-uses the
                same shared ClassifierTestPanel. */}
            <SubTitle>✉️ Send word</SubTitle>
            <Hint>Backup commit word for voice-mode turns — say it during a turn to commit immediately. Configure the phrase, train a model, and test it on the send-word page.</Hint>
            <TouchableOpacity
              style={[styles.saveAudioBtn, { marginTop: 4 }]}
              onPress={() => setShowSendWordScreen(true)}
            >
              <Text style={styles.saveAudioBtnText}>
                {voiceSendPhraseSavedAt
                  ? `✉️ "${voiceSendPhrase.trim() || 'send'}" — tap to manage`
                  : '✉️ Configure send word →'}
              </Text>
            </TouchableOpacity>
            {sendModelInfo ? (
              <Text style={styles.sendModelSummary}>
                ✓ Trained {new Date(sendModelInfo.trainedAt).toLocaleDateString()} ·{' '}
                {sendModelInfo.modelPath || 'model active'}
              </Text>
            ) : (
              <Text style={styles.sendModelSummaryDim}>
                No trained model yet — open the send-word page to record 6 samples.
              </Text>
            )}

            {/* v3.9.8 — your-turn cue sound. Plays after the
                desktop's audio response finishes and we're
                about to start the next recording window.
                Default is 'off' (no sound) so existing users
                don't get surprised. The four synthesized
                sounds (bird / bell / ding / chime) are bundled
                in android/app/src/main/assets/sounds/. They
                are short, gentle, and designed for repeated
                playback. The setting is global for v3.9.8;
                per-companion cue sounds land in v3.10.0. */}
            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <SubTitle>🔔 Your-turn cue sound</SubTitle>
            <Hint>Plays when the companion finishes talking and it's your turn to speak. Set to "Off" for no sound; choose a tone for an audio cue alongside the visual "YOUR TURN" overlay.</Hint>
            <Label>Sound</Label>
            <View style={styles.optionRow}>
              {['off', 'bird', 'bell', 'ding', 'chime'].map(opt => (
                <OptionBtn
                  key={opt}
                  active={(voiceTurnCue || 'off') === opt}
                  label={opt.charAt(0).toUpperCase() + opt.slice(1)}
                  onPress={() => updateVoiceTurnCue(opt)}
                />
              ))}
            </View>

            {/* v3.10.34 — working / thinking cue + speech.
                Plays while the desktop LLM is processing
                the user's audio (between user-sent-audio
                and the desktop's chat/audio_response event).
                Fills the gap where the user otherwise just
                sees "Thinking..." with no audio feedback.
                Three settings:
                  - workingCue: short non-verbal sound (same
                    WAV options as the your-turn cue).
                    'off' to suppress.
                  - workingSpeech: the verbal phrase TTS-
                    rendered via Android TTS. Configure
                    with whatever words feel natural
                    ("Working on it...", "Let me think...",
                    "Digging...", etc.). Empty disables the
                    speech; the visual 'Thinking' overlay
                    still shows.
                  - workingDelayMs: how long to wait after
                    the user finishes speaking before
                    firing the cue + speech. Default 1500ms
                    so quick responses don't get a working
                    cue interrupting them. The state is
                    ALWAYS shown visually ('Thinking...')
                    on any response that takes > delay. */}
            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <SubTitle>🧠 Working / thinking status</SubTitle>
            <Hint>Audio + visual cue during the gap between you finishing your turn and the LLM responding. Sits above the response audio so you know the desktop is working on a longer answer.</Hint>
            <Label>Working sound</Label>
            <View style={styles.optionRow}>
              {['off', 'bird', 'bell', 'ding', 'chime'].map(opt => (
                <OptionBtn
                  key={opt}
                  active={(voiceWorkingCue || 'off') === opt}
                  label={opt.charAt(0).toUpperCase() + opt.slice(1)}
                  onPress={() => updateVoiceWorkingCue(opt)}
                />
              ))}
            </View>
            <Label>Working speech (TTS-rendered)</Label>
            <Hint>Spoken via Android TTS. Different voice from the companion's. Use whatever phrase feels natural; blank to disable speech (sound + visual still play).</Hint>
            <TextInput
              style={styles.input}
              value={voiceWorkingSpeech}
              onChangeText={(v) => { setVoiceWorkingSpeech(v); persistWorkingSpeech(v); }}
              onBlur={saveVoiceWorkingSpeech}
              placeholder="Working on it..."
              placeholderTextColor="#666"
              maxLength={60}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hintSmall}>
              {workingSpeechSavedAt
                ? `✅ Saved at ${new Date(workingSpeechSavedAt).toLocaleTimeString()}`
                : 'Saves automatically as you type.'}
            </Text>
            <Label>Trigger delay (ms)</Label>
            <Hint>How long to wait after you stop speaking before the working cue + speech fire. Default 1500ms — short enough to feel responsive, long enough that quick responses don't get interrupted. Range 800-5000.</Hint>
            <View style={styles.optionRow}>
              {[800, 1500, 2500, 5000].map(ms => (
                <OptionBtn
                  key={ms}
                  active={(voiceWorkingDelayMs || 1500) === ms}
                  label={`${ms}`}
                  onPress={() => saveVoiceWorkingDelay(ms)}
                />
              ))}
            </View>
          </Section>
      </>

      {/* ── 🎙️ Background recording ─────────────────────────────
          v3.6.2: lifted out of the Listening settings section.
          The "Lookback" setting configures how the rolling audio
          buffer behaves, and that buffer is what the future
          ambient-recording / daily-log feature will use to keep
          a persistent record you can ask the companion to
          analyze. So the setting gets its own Section (with
          a Section border) so it reads as a distinct
          concept — "this is the recording knob" — rather than
          a sub-detail of the microphone toggle. */}
      <Section title="🎙️ Background recording" desc="How much audio the rolling buffer keeps. The companion uses this to hear what you said just before the wake word, and (in a future update) for ambient daily recording.">
        <Label>Audio buffer</Label>
        <Hint>How much audio context to keep so the companion can hear what you said just before the wake word.</Hint>
        <Label>Lookback (minutes)</Label>
        <View style={styles.optionRow}>
          {[5, 10, 30, 60].map(m => (
            <OptionBtn key={m} active={audioSettings.lookbackMinutes === m} label={`${m}`} onPress={() => updateAudio('lookbackMinutes', m)} />
          ))}
        </View>
        {/*
          v3.6.1: removed "Conversation timeout" and "Recording
          retention" controls. Both were write-only — the
          values were saved to AsyncStorage and shown back in
          the UI but no code path actually read them. The
          "Daily audio logs are kept locally…" hint was
          documenting a feature (background daily recording
          + retention) that is not implemented. The audio
          buffer is governed solely by lookbackMinutes.
        */}
        <TouchableOpacity style={styles.saveAudioBtn} onPress={saveAudioSettings}>
          <Text style={styles.saveAudioBtnText}>
            {audioSettingsSavedAt
              ? `✅ Saved at ${new Date(audioSettingsSavedAt).toLocaleTimeString()}`
              : '💾 Save audio settings'}
          </Text>
        </TouchableOpacity>
      </Section>

      {/* ── 🤖 Agent Reach ───────────────────────────────────── */}
      <Section title="🤖 Agent Reach" desc="Allow the AI companion to interact with this device remotely.">
        <SubTitle>📁 File system</SubTitle>
        <Toggle title="Read files" sub="Browse and read file content" value={remotePerms.file_read} onValueChange={v => toggleRemotePerm('file_read', v)} />
        <Toggle title="Write / create files" sub="Create, write, and mkdir" value={remotePerms.file_write} onValueChange={v => toggleRemotePerm('file_write', v)} />

        <SubTitle>📱 App control</SubTitle>
        <Toggle title="Launch apps & intents" sub="Open URLs and Android intents" value={remotePerms.launch_intent} onValueChange={v => toggleRemotePerm('launch_intent', v)} />

        <SubTitle>📍 Location</SubTitle>
        <Toggle title="Location" sub="Share GPS coordinates with agent" value={remotePerms.get_location} onValueChange={v => toggleRemotePerm('get_location', v)} />

        <SubTitle>📷 Camera</SubTitle>
        <Toggle title="Camera" sub="Take photos on agent request" value={remotePerms.get_camera} onValueChange={v => toggleRemotePerm('get_camera', v)} />

        <SubTitle>🔔 Notifications</SubTitle>
        <View style={[styles.toggleRow, { opacity: 0.4 }]}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>Notifications</Text>
            <Text style={styles.toggleSub}>Not yet supported</Text>
          </View>
          <Switch value={false} disabled trackColor={{ false: '#333', true: '#f7931a' }} thumbColor={'#666'} />
        </View>
      </Section>

      {/* v3.10.154: 🔑 API keys section removed entirely.
          ElevenLabs / Google Cloud TTS were decorative —
          the desktop never honored them, they shipped
          broken. Voice selection now happens per-companion
          in CompanionSettingsScreen against the device's
          Android TextToSpeech engine (Google TTS, RHVoice,
          eSpeak NG, Samsung TTS, etc.). The migration
          migrateV3_10_154_dropCloudTts() runs on App.tsx
          mount and clears any leftover API-key AsyncStorage
          values, so users who had keys saved don't end up
          with secrets lingering on disk. */}
      {/* v3.10.134: per-device default quest
          directory. When the user creates a new
          quest from the Quests screen, the editor
          pre-fills the suggested path as
          `<defaultDir>/<sanitized-quest-name>`
          (computed in QuestsScreen). The user can
          accept, edit, or clear. Tobe 2026-08-04
          13:58: 'Perhaps we should add a quest
          directory in the settings, and when a new
          quest is created the user creates a new
          directory within the specified quest
          directory, with the name of the quest,
          or the user can select an existing
          directory.' Mobile-only — the desktop
          doesn't need to know this value.

          Stored under cyberclaw-mobile-settings
          alongside the other tuning. Not validated
          on save (the path might not exist on this
          device yet; that's the desktop's job to
          mkdir when the quest lands).
          SettingsScreen is a top-level page on
          App.tsx so this lives here, not in
          CompanionSettingsScreen. */}
      <Section title="Quests" desc="Default paths for new quests created on this phone.">
        <Label>📁 Default quest directory</Label>
        {/* v3.10.136: example moved ABOVE the input field so
            the user sees the convention first, types after.
            Tobe 2026-08-04 17:31: 'it should be better,
            suggestions and example right above.' The path
            shown below is generic (`/path/to/your/projects`)
            rather than a real example of Tobe's actual disk
            layout — Tobe also said 'dont use my directory
            as text example' on 2026-08-04 17:31. The
            concrete suggested pre-fill (with ↳ examples)
            still happens in the quest editor, not here. */}
        <Hint>
          💡 <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>/path/to/your/projects/</Text>
          {'\n'}    ↳ seed-signer/
          {'\n'}    ↳ cyber-music-v2/
          {'\n\n'}
          Tip: when you tap + New, the editor will
          auto-pre-fill
          <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}> &lt;your-dir&gt;/&lt;quest-name&gt;</Text>
          {' '}as the suggestion.
        </Hint>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
          <TextInput
            style={{
              flex: 1,
              backgroundColor: theme.bg.secondary,
              color: theme.text.primary,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.border.mid,
              padding: 10,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 13,
            }}
            value={defaultQuestDir}
            onChangeText={setDefaultQuestDir}
            placeholder="/path/to/your/projects"
            placeholderTextColor={theme.text.dim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={{
              marginLeft: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
              backgroundColor: theme.brand.accent,
              borderRadius: 6,
            }}
            onPress={saveDefaultQuestDir}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
        {/* v3.10.136: visible save feedback. Renders "✓ Saved"
            for 2 seconds after a successful save. Driven by
            the defaultQuestDirSavedAt timestamp state — no
            setTimeout, just a derived value from the current
            Date.now(). If the user types more characters
            after saving, the badge fades naturally because
            the time delta crosses the 2-second threshold. */}
        {defaultQuestDirSavedAt !== null && (Date.now() - defaultQuestDirSavedAt) < 2000 && (
          <Text style={{ color: theme.brand.accentBright, fontSize: 12, marginTop: 4, fontWeight: '600' }}>
            ✓ Saved
          </Text>
        )}
        <Hint>
          Where new projects get rooted. Leave empty to skip
          the suggestion when creating a quest. Path is
          used as a suggestion only — the desktop (or the
          quest editor) decides what actually gets created.
        </Hint>
      </Section>

      {/* v3.10.136: CYBERCLAW.md editor. The
          overarching system prompt lives on the desktop
          at `~/.openclaw/cyberclaw/CYBERCLAW.md`. This
          section lets the user:
            - read the current content (in a scrollable
              multiline input)
            - save their own edits (button writes back to
              the desktop via WS round-trip)
            - reset to the default (button unlinks the
              user's file so the desktop reads the
              shipped default on next save)
          With a prominent warning that mistuned text
          can break companion behavior — the prompt is
          the foundation of how the companion reasons.
          Tobe 2026-08-04 17:31: "did we have a
          cyberclaw md also, outside of companions?
          If not we should have it in the settings
          (editable with a warning that this might
          break the companions behaviour), this
          tells the agent that we are talking within
          cyberclaw, what cyberclaw is and how to
          behave/response/do things, like, - we create
          a quest like this: create a directory with
          quest instructions etc. - Pictures are seen
          like this, - check quest directory
          conversation file, memory, before reply -
          always reply on cyberclaw if spoken to here.
          These are just examples but in theory should
          be correct and aligned with what i want."

          Behaviour notes:
            - The desktop is the source of truth. The
              mobile's textbox is a working copy; Save
              pushes back. On mount we fetch once; on
              WS reconnect we re-fetch.
            - Saving does NOT restart the desktop. The
              new content takes effect on the NEXT
              chat send because assembleContext() reads
              the file every time.
            - Reset to default removes the user's file
              and shows the shipped default in the
              textbox. The user can then save (writes
              the default in place of nothing) or just
              close the modal (the default sticks
              because nothing in the FS). */}
      <Section
        title="CYBERCLAW.md"
        desc="The overarching system prompt. Read by every companion on every chat send."
      >
        {/* Warning box. v3.10.136 — rendered as a
            red-bordered sub-section so the user
            can't miss it before editing. */}
        <View style={{
          backgroundColor: 'rgba(255,80,80,0.12)',
          borderColor: '#cc4444',
          borderWidth: 1,
          borderRadius: 6,
          padding: 10,
          marginBottom: 12,
        }}>
          <Text style={{ color: '#ff8888', fontSize: 13, fontWeight: '700', marginBottom: 4 }}>
            ⚠️ Editing this changes how every companion thinks
          </Text>
          <Text style={{ color: '#ffaaaa', fontSize: 12, lineHeight: 16 }}>
            The desktop reads CYBERCLAW.md on every chat send
            and injects it as the first block of system context.
            A mistuned prompt can break companion behaviour
            (lost tone, broken tool use, ignored instructions).
            Reset to the shipped default if you get lost.
          </Text>
        </View>
        {cyberclawPath ? (
          <Text style={{
            color: theme.text.dim,
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            fontSize: 11,
            marginBottom: 8,
          }} selectable>
            📄 {cyberclawPath}
          </Text>
        ) : null}
        {cyberclawLoading ? (
          <Text style={{ color: theme.text.dim, fontStyle: 'italic', marginVertical: 12 }}>
            Loading CYBERCLAW.md…
          </Text>
        ) : (
          <TextInput
            style={{
              backgroundColor: theme.bg.secondary,
              color: theme.text.primary,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.border.mid,
              padding: 12,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 12,
              minHeight: 280,
              textAlignVertical: 'top',
            }}
            value={cyberclawContent}
            onChangeText={setCyberclawContent}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            editable={!cyberclawSaving}
            placeholder="CYBERCLAW.md content…"
            placeholderTextColor={theme.text.dim}
          />
        )}
        <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
          <TouchableOpacity
            style={{
              flex: 1,
              paddingVertical: 10,
              backgroundColor: cyberclawSaving ? theme.text.dim : theme.brand.accent,
              borderRadius: 6,
              opacity: cyberclawSaving ? 0.6 : 1,
            }}
            disabled={cyberclawSaving || cyberclawLoading}
            onPress={saveCyberclawSystem}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', textAlign: 'center' }}>
              {cyberclawSaving ? 'Saving…' : '💾 Save'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              flex: 1,
              paddingVertical: 10,
              backgroundColor: cyberclawResetConfirming ? '#cc4444' : '#3a3a4f',
              borderRadius: 6,
            }}
            disabled={cyberclawSaving || cyberclawLoading}
            onPress={resetCyberclawSystem}
          >
            <Text style={{
              color: cyberclawResetConfirming ? '#fff' : '#ffaaaa',
              fontSize: 13,
              fontWeight: '700',
              textAlign: 'center',
            }}>
              {cyberclawResetConfirming ? '⚠️ Tap again to confirm' : '↺  Reset to default'}
            </Text>
          </TouchableOpacity>
        </View>
        {cyberclawSavedAt !== null && (Date.now() - cyberclawSavedAt) < 2000 && (
          <Text style={{ color: theme.brand.accentBright, fontSize: 12, marginTop: 6, fontWeight: '600' }}>
            ✓ Saved
          </Text>
        )}
        <Hint>
          The content here tells the companion that we're
          talking inside CyberClaw. Suggested topics Tobe
          (2026-08-04 17:31):
          {'\n'}- How to create a quest (mkdir + INSTRUCTIONS.md + CONVERSATION.md)
          {'\n'}- How pictures are seen (data URI, attached file, etc.)
          {'\n'}- Check the quest directory files (INSTRUCTIONS.md, CONVERSATION.md, memory) before replying
          {'\n'}- Always reply on CyberClaw if spoken to
        </Hint>
      </Section>

      {/* ── About footer ──────────────────────────────────────── */}
      <View style={styles.aboutFooter}>
        <Text style={styles.aboutVersion}>CyberClaw Mobile v{APP_VERSION}</Text>
        <Text style={styles.aboutLink}>github.com/Tobe2222/Cyber_Claw_Mobile</Text>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>

    {/* v3.1.68: companion picker modal (replaces the native
        Alert.alert that was here). Each row shows the
        companion's sprite icon next to its name so the user
        can pick the right one to train the wake word for.
        v3.4.2: ENTIRE PICKER MODAL REMOVED. Its sole caller
        (the top-level "Train wake phrase for new companion"
        button) was removed because Tobe wants training to
        happen exclusively inside each companion's detail
        view. Tap companion → detail → Train button there.
        No more "pick which companion to train" step from
        the top level. */}
  </>
  );
}

// ── Inline section components ──────────────────────────────── v3.10.112: each helper calls useTheme() and builds its own style object from…

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  const { theme: t } = useTheme();
  const styles = {
    section: { backgroundColor: t.bg.tertiary, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: t.brand.accent },
    title: { color: t.brand.accent, fontSize: 18, fontWeight: 'bold' as const, marginBottom: 4 },
    desc: { color: t.text.muted, fontSize: 13, marginBottom: 16, lineHeight: 18 },
  };
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{title}</Text>
      {desc ? <Text style={styles.desc}>{desc}</Text> : null}
      {children}
    </View>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  const { theme: t } = useTheme();
  return <Text style={{ color: t.text.muted, fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12, letterSpacing: 0.5 }}>{children}</Text>;
}

// Bigger title for major groups within a Section block.

function Label({ children }: { children: React.ReactNode }) {
  const { theme: t } = useTheme();
  return <Text style={{ color: t.text.secondary, fontSize: 14, marginBottom: 6, marginTop: 8 }}>{children}</Text>;
}

function Hint({ children }: { children: React.ReactNode }) {
  const { theme: t } = useTheme();
  return <Text style={{ color: t.text.dim, fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 }}>{children}</Text>;
}

function Toggle({ title, sub, value, onValueChange }: { title: string; sub: string; value: boolean; onValueChange: (v: boolean) => void }) {
  const { theme: t } = useTheme();
  const styles = {
    row: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingVertical: 8 },
    info: { flex: 1 },
    title: { color: t.text.primary, fontSize: 14, fontWeight: '600' as const },
    sub: { color: t.text.muted, fontSize: 12, marginTop: 2 },
  };
  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#333', true: '#f7931a' }}
        thumbColor={value ? '#fff' : '#666'}
      />
    </View>
  );
}

function OptionBtn({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const { theme: t } = useTheme();
  const styles = {
    btn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: t.border.mid, backgroundColor: t.bg.secondary },
    active: { backgroundColor: t.brand.accent, borderColor: t.brand.accent },
    text: { color: t.text.primary, fontSize: 13, fontWeight: '600' as const },
    textActive: { color: t.text.inverse },
  };
  return (
    <TouchableOpacity style={[styles.btn, active && styles.active]} onPress={onPress}>
      <Text style={[styles.text, active && styles.textActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.bg.primary },
  // Bumped paddingTop from 16 → 50 on BOTH Android and iOS.
  content: { padding: 16, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, paddingTop: Platform.OS === 'android' ? 34 : 10 },
  // Pinned header above the ScrollView so the back button + title stay in place while the user scrolls the long settings content below.
  fixedTopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'android' ? 34 : 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: t.bg.primary,
    borderBottomWidth: 1,
    borderBottomColor: t.border.subtle,
  },
  backBtn: { color: t.brand.accent, fontSize: 16 },
  title: { color: t.text.primary, fontSize: 20, fontWeight: 'bold', marginLeft: 16 },
  // Sun/moon theme toggle.
  themeSegControl: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  themeSegBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: t.border.subtle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'transparent',
  },
  themeSegBtnActive: {
    borderColor: t.brand.accent,
    backgroundColor: t.brand.accentGlow,
  },
  themeSegIcon: { fontSize: 14 },
  themeSegIconActive: {},
  themeSegLabel: { fontSize: 11, color: t.text.muted, fontWeight: '600' },
  themeSegLabelActive: { color: t.brand.accent },
  // Orange section border for better visual distinction (was #222 — almost invisible against the #111 background).
  section: { backgroundColor: t.bg.tertiary, borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: t.brand.accent },
  sectionTitle: { color: t.brand.accent, fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  sectionDesc: { color: t.text.muted, fontSize: 13, marginBottom: 16, lineHeight: 18 },
  subGroupTitle: { color: t.text.muted, fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12, letterSpacing: 0.5 },
  // v3.4.7: groupTitle + groupDivider styles REMOVED.
  // Listening settings and Companions are now separate
  // Section blocks (each with its own orange border).
  label: { color: t.text.secondary, fontSize: 14, marginBottom: 6, marginTop: 8 },
  hint: { color: t.text.dim, fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 },
  hintSmall: { color: t.brand.success, fontSize: 11, marginTop: 4, fontStyle: 'italic' },
  savedHint: { color: t.brand.success, fontSize: 12, marginTop: 6 },
  input: { backgroundColor: t.bg.tertiary, color: t.text.primary, borderRadius: 8, padding: 12, fontSize: 16, borderWidth: 1, borderColor: t.border.mid },
  button: { backgroundColor: t.brand.accent, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  buttonText: { color: t.text.inverse, fontSize: 16, fontWeight: 'bold' },
  buttonConnected: { backgroundColor: t.border.mid, borderWidth: 1, borderColor: t.brand.success },
  buttonTextConnected: { color: t.brand.success },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  dotGreen: { backgroundColor: t.brand.success },
  dotYellow: { backgroundColor: t.brand.warning },
  dotRed: { backgroundColor: t.text.dim },
  statusText: { color: t.text.secondary, fontSize: 14 },
  divider: { height: 1, backgroundColor: t.bg.tertiary, marginVertical: 12 },
  permRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.bg.tertiary },
  permLabel: { color: t.text.primary, fontSize: 14, fontWeight: 'bold' },
  permDesc: { color: t.text.muted, fontSize: 11, marginTop: 2 },
  permBtn: { backgroundColor: t.brand.accent, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  permBtnText: { color: t.text.inverse, fontSize: 12, fontWeight: 'bold' },
  permBtnSmall: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: t.bg.tertiary, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: t.bg.tertiary },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleTitle: { color: t.text.primary, fontSize: 14, fontWeight: '600' },
  toggleSub: { color: t.text.dim, fontSize: 12, marginTop: 2 },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  optionBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: t.bg.tertiary, borderWidth: 1, borderColor: t.border.mid },
  optionActive: { backgroundColor: 'rgba(247,147,26,0.2)', borderColor: t.brand.accent },
  optionText: { color: t.text.muted, fontSize: 13 },
  optionTextActive: { color: t.brand.accent, fontWeight: 'bold' },
  // v3.2.27 — trained-phrase picker rows
  trainedPicker: { marginTop: 8 },
  trainedPickerHint: { marginTop: 8, paddingVertical: 8 },
  trainedPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: t.bg.tertiary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.mid,
    marginBottom: 6,
  },
  trainedPickerRowActive: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: t.brand.success,
  },
  trainedPickerRadio: { color: t.text.dim, fontSize: 18, marginRight: 10 },
  trainedPickerRadioActive: { color: t.brand.success },
  trainedPickerLabel: { color: t.text.primary, fontSize: 14, flex: 1 },
  trainedPickerLabelActive: { fontWeight: '700' },
  trainedPickerBadge: {
    color: t.brand.success,
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(16,185,129,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  // Per-row action group on the right edge of each trained-phrase / wake-phrase row.
  trainedPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
  },
  // Companion list rows on the top-level Voice mode section.
  companionList: {
    marginTop: 8,
  },
  companionListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: t.bg.tertiary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.border.mid,
    marginBottom: 6,
  },
  companionListRowActive: {
    backgroundColor: 'rgba(16,185,129,0.10)',
    borderColor: t.brand.success,
  },
  companionListEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  companionListName: {
    color: t.text.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  companionListDetail: {
    color: t.text.muted,
    fontSize: 12,
    marginTop: 2,
    fontStyle: 'italic',
  },
  companionListActive: {
    color: t.brand.success,
    fontSize: 18,
    marginHorizontal: 8,
    fontWeight: 'bold',
  },
  companionListArrow: {
    color: t.text.muted,
    fontSize: 22,
    marginLeft: 4,
  },
  // Drill-down card inside the companion overview.
  phaseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.bg.secondary,
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginVertical: 6,
    gap: 12,
  },
  phaseCardEmoji: {
    fontSize: 28,
  },
  phaseCardTitle: {
    color: t.text.primary,
    fontSize: 16,
    fontWeight: '600',
  },
  phaseCardSub: {
    color: t.text.muted,
    fontSize: 12,
    marginTop: 3,
  },
  phaseCardArrow: {
    color: t.text.muted,
    fontSize: 24,
    marginLeft: 4,
  },
  // v3.4.0: per-companion detail screen header. Back button
  // on the left, companion emoji+name centered, spacer on
  // the right so the title is centered visually.
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailBackBtn: {
    paddingVertical: 4,
    paddingRight: 12,
  },
  detailBackBtnText: {
    color: t.brand.accent,
    fontSize: 16,
  },
  detailHeader: {
    color: t.text.primary,
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
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
  trainedPickerActionIcon: {
    fontSize: 16,
  },
  // v3.3.0: wake row shows companion emoji + name + phrase.
  // Phrase is rendered smaller and dimmer below the name so
  // both fit cleanly in one row.
  trainedPickerCompanionEmoji: {
    fontSize: 22,
    marginRight: 10,
  },
  trainedPickerPhrase: {
    color: t.text.muted,
    fontSize: 12,
    marginTop: 1,
    fontStyle: 'italic',
  },
  trainedPickerClear: {
    paddingVertical: 6,
    alignItems: 'center',
  },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  thresholdEdge: { color: t.text.muted, fontSize: 12, width: 32, textAlign: 'center' },
  thresholdCell: { flex: 1, height: 28, justifyContent: 'center', alignItems: 'center', borderRadius: 4, marginHorizontal: 1 },
  thresholdCellActive: { backgroundColor: t.brand.accent },
  thresholdCellPast: { backgroundColor: t.brand.warning },
  thresholdCellFuture: { backgroundColor: t.bg.tertiary },
  thresholdCellText: { color: t.text.dim, fontSize: 9 },
  debugBox: { backgroundColor: t.bg.secondary, borderRadius: 8, padding: 10, marginTop: 12, borderWidth: 1, borderColor: t.bg.tertiary },
  debugBoxTitle: { color: t.brand.accent, fontSize: 11, fontWeight: 'bold' },
  debugBoxClear: { color: t.text.dim, fontSize: 11 },
  debugLine: { color: t.brand.success, fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  trainBtn: { backgroundColor: t.bg.tertiary, borderRadius: 10, padding: 14, marginTop: 8, borderWidth: 1, borderColor: t.brand.accent, borderStyle: 'dashed', alignItems: 'center' },
  trainBtnText: { color: t.text.primary, fontSize: 15, fontWeight: 'bold' },
  trainBtnSub: { color: t.text.muted, fontSize: 12, marginTop: 2 },
  testBtn: { backgroundColor: 'rgba(247,147,26,0.15)', borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: t.brand.accent, marginTop: 8 },
  testBtnText: { color: t.brand.accent, fontSize: 14, fontWeight: '600' },
  saveAudioBtn: { backgroundColor: t.brand.success, borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  saveAudioBtnText: { color: t.text.inverse, fontSize: 15, fontWeight: 'bold' },
  // Send-trained-model badge styles.
  sendModelBadge: {
    backgroundColor: 'rgba(156, 163, 175, 0.10)',
    borderColor: 'rgba(156, 163, 175, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sendModelBadgeIcon: {
    color: t.brand.success,
    fontSize: 18,
    fontWeight: '700',
    marginRight: 10,
  },
  sendModelBadgeTextWrap: { flex: 1 },
  sendModelBadgeText: { color: t.text.primary, fontSize: 14, fontWeight: '600' },
  sendModelBadgeMeta: { color: t.text.muted, fontSize: 12, marginTop: 2 },
  // Compact one-line summary shown in the Voice mode section's send-word row.
  sendModelSummary: { color: t.brand.success, fontSize: 12, marginTop: 6 },
  sendModelSummaryDim: { color: t.text.dim, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  // Collapsed training-active row shown in place of the "🎤 Start voice training" button once the user is past the B-threshold (samplesTotal…
  trainingActiveRow: {
    marginTop: 8,
    padding: 10,
    borderRadius: 6,
    backgroundColor: 'rgba(34, 197, 94, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.25)',
  },
  trainingActiveText: { color: t.brand.success, fontSize: 12, lineHeight: 17 },
  aboutFooter: { alignItems: 'center', marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: t.bg.tertiary },
  aboutVersion: { color: t.text.dim, fontSize: 12 },
  aboutLink: { color: t.border.strong, fontSize: 11, marginTop: 4 },
  // Wake-training companion picker modal.
  pickerOverlay: {
    flex: 1,
    backgroundColor: t.bg.scrim,
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: t.bg.tertiary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: Platform.OS === 'android' ? 24 : 16,
    borderTopWidth: 1,
    borderColor: t.bg.tertiary,
  },
  pickerTitle: {
    color: t.text.primary,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  pickerSub: {
    color: t.text.muted,
    fontSize: 12,
    marginBottom: 12,
  },
  pickerList: {
    maxHeight: 360,
  },
  pickerListContent: {
    paddingBottom: 4,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.bg.tertiary,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: t.border.mid,
  },
  pickerRowIcon: {
    fontSize: 24,
    width: 36,
    textAlign: 'center',
    marginRight: 12,
  },
  pickerRowName: {
    color: t.text.primary,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  pickerRowHint: {
    color: t.brand.accent,
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },
  pickerRowBadge: {
    color: t.brand.success,
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: '#10b98122',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
    overflow: 'hidden',
  },
  pickerCancel: {
    backgroundColor: t.bg.tertiary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  pickerCancelText: {
    color: t.text.secondary,
    fontSize: 15,
    fontWeight: '600',
  },
});
