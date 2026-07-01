/**
 * SettingsScreen — Mobile companion settings
 *
 * v3.4.0: 3-level hierarchy replaces the v3.3.0 flat two-section
 * (Wake + Exit) layout. Tobe complained that "Wake settings" and
 * "Exit settings" each contained unrelated controls (audio buffer,
 * match thresholds, silence timeout) which made both sections
 * feel like grab-bags. The new structure is:
 *
 *   (1) 🎤 Voice mode (top-level)
 *       - Background listening
 *       - Audio buffer
 *       - Companions list (NEW): each companion shows their
 *         currently-active wake phrase; tap to open detail
 *       - Train-new companion's wake button
 *       - Silence timeout (voice mode close)
 *       - Match thresholds (foreground / background)
 *
 *   (2) Per-companion detail view (tap a companion to enter)
 *       - Back button + companion header
 *       - Wake greeting TextInput (top, single TextInput —
 *         global semantics but reachable from any companion
 *         for consistent layout)
 *       - Exit reply TextInput (same)
 *       - Wake phrases for this companion (uses the existing
 *         WakePhrasePicker, scoped to one companion)
 *       - Train-new wake phrase for this companion
 *       - Exit phrases for this companion (uses the new
 *         PerCompanionExitPicker, scoped to one companion)
 *       - Train-new exit phrase for this companion
 *
 *   (3) 🔊 Voice & Speech / 🤖 Agent Reach (unchanged)
 *
 * Storage model change: exit phrases are now per-companion
 * (cyberclaw-exit-samples-<companionId>-<phrase> vs the
 * v3.3.0 global cyberclaw-exit-samples-<phrase>). The
 * active exit phrase is also per-companion
 * (cyberclaw-exit-phrase-<companionId>). A one-time
 * migration runs on first launch of v3.4.0 to copy the
 * legacy keys under the active companion's namespace.
 *
 * Sections (top to bottom):
 *   1. 🔗 Connection       — Desktop IP, connect, status, log, pairing
 *   2. 🔒 Permissions      — Runtime perms (mic/notif) + wake perms
 *   3. 🎤 Voice mode       — Top-level: companion list + global
 *                            audio settings (see above)
 *      ⟶ tap a companion → per-companion detail (see above)
 *   4. 🔊 Voice & Speech   — Local TTS (free) + Premium API placeholder
 *   5. 🤖 Agent Reach      — Remote permissions (file/app/location/camera)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Switch, Alert, Platform, PermissionsAndroid, Linking, NativeModules, BackHandler,
  Modal, Pressable,
} from 'react-native';
const { BackgroundService, WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { audioBuffer, DEFAULT_SETTINGS, AudioBufferSettings } from '../services/AudioBuffer';

import OpenWakeWordTrainer from '../components/OpenWakeWordTrainer';
import ExitPhraseTrainer from '../components/ExitPhraseTrainer';
import {
  getPermissions,
  setPermission,
  RemotePermissions,
  RemotePermissionKey,
} from '../services/RemoteToolPermissions';
import { version as APP_VERSION } from '../../package.json';

const SETTINGS_KEY = 'cyberclaw-mobile-settings';

type PermStatus = 'granted' | 'denied' | 'never_ask_again' | 'unknown';

// Android on-device TTS voices. These are device-language aliases — the
// actual voice comes from the user's installed TTS engine.
const LOCAL_VOICES = [
  { id: 'default', label: '🎙️ System Default' },
  { id: 'male', label: '👨 Male' },
  { id: 'female', label: '👩 Female' },
];

// Premium API providers (placeholder — the desktop doesn't consume
// these yet, so the section is read-only-ish until the bridge is wired)
const PREMIUM_PROVIDERS = [
  { id: 'elevenlabs', label: 'ElevenLabs', voices: [
    { id: 'nova', label: '✨ Nova (Female — bright)' },
    { id: 'alloy', label: '🎙️ Alloy (Male — friendly)' },
    { id: 'echo', label: '🌊 Echo (Male — deep)' },
    { id: 'fable', label: '📖 Fable (Female — storyteller)' },
    { id: 'onyx', label: '⚫ Onyx (Male — smooth)' },
    { id: 'shimmer', label: '✨ Shimmer (Female — warm)' },
  ]},
  { id: 'google', label: 'Google Cloud TTS', voices: [
    { id: 'en-US-Neural2-A', label: '🗣️ A (Female)' },
    { id: 'en-US-Neural2-C', label: '🗣️ C (Female)' },
    { id: 'en-US-Neural2-E', label: '🗣️ E (Male)' },
  ]},
];

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  // ── Connection ────────────────────────────────────────────────
  const [hostIp, setHostIp] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // ── Permissions ───────────────────────────────────────────────
  const [micPerm, setMicPerm] = useState<PermStatus>('unknown');
  const [notifPerm, setNotifPerm] = useState<PermStatus>('unknown');
  const [wakePerms, setWakePerms] = useState({ canDrawOverlays: false, canUseFullScreenIntent: true });

  // ── Wake Word ─────────────────────────────────────────────────
  const [bgListening, setBgListening] = useState(true);
  // v3.1.49: foreground threshold (separate from background). The
  // user was getting accidental wake matches — both background
  // audio (TV, podcast, other voices) AND foreground false-positives.
  // Making both thresholds adjustable gives the user a way to tune
  // wake detection without retraining. Default FG: 55% (matches
  // SAMPLE_MATCH_THRESHOLD_FG in HomeScreen/WakeModeScreen).
  const [fgThreshold, setFgThreshold] = useState(55);
  const [bgThreshold, setBgThreshold] = useState(65);
  const [readyPhrase, setReadyPhrase] = useState('Ready to chat');
  const [readyPhraseSavedAt, setReadyPhraseSavedAt] = useState<number | null>(null);
  const readyPhraseSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v3.2.29: exit reply phrase — mirror of the wake
  // greeting. The companion speaks this on voice-mode
  // close (silence timeout, exit phrase match, or
  // trainer-cancel). Same flow: type → save → desktop
  // synthesizes via piper TTS → cache WAV → play on
  // close. Empty = silent close (no audio, no log spam).
  const [exitReplyPhrase, setExitReplyPhrase] = useState('Goodbye!');
  const [exitReplySavedAt, setExitReplySavedAt] = useState<number | null>(null);
  const exitReplySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // v3.2.17 — multi-turn voice loop settings.
  const [voiceSilenceMs, setVoiceSilenceMs] = useState(5000);
  // v3.2.20 — single exit phrase (was array). Default
  // 'thanks' matches the most common natural exit phrase
  // Tobe uses after a command. Empty string disables.
  const [voiceExitPhrase, setVoiceExitPhrase] = useState('thanks');
  const [voiceExitPhraseSavedAt, setVoiceExitPhraseSavedAt] = useState<number | null>(null);
  const [audioSettings, setAudioSettings] = useState<AudioBufferSettings>(DEFAULT_SETTINGS);
  const [audioSettingsSavedAt, setAudioSettingsSavedAt] = useState<number | null>(null);

  // v3.2.0: openWakeWord trainer modal. The legacy DTW-based
  // wake training + tester were removed in v3.2.2 — the
  // openWakeWord pipeline supersedes them.
  const [showOwwTrainer, setShowOwwTrainer] = useState(false);
  // v3.3.0: when opening the wake trainer via per-row
  // "Retrain" in the new WakePhrasePicker, the trainer
  // opens pre-loaded with the existing phrase for that
  // companion. Stored in this state so the trainer
  // modal knows what to pre-fill. Cleared on close.
  const [editingWakePhrase, setEditingWakePhrase] = useState<string>('');
  // v3.2.25: exit-phrase trainer modal. Recording 6 samples
  // persists locally; the runtime DTW detector against these
  // samples is wired in v3.2.26.
  const [showExitPhraseTrainer, setShowExitPhraseTrainer] = useState(false);
  // v3.3.0: pre-fill for the exit trainer when opened
  // from per-row "Retrain" in the ExitPhrasePicker.
  const [editingExitPhrase, setEditingExitPhrase] = useState<string>('');
  // v3.2.1: map of agentId -> {phrase, path, savedAt} for
  // companions that have a saved custom wake model. Used
  // to show "✓ trained" badges in the companion picker.
  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number }>>({});
  // v3.4.0: which companion's detail screen is open.
  // When null, the user sees the top-level Voice mode
  // section with the companion list. When set, they see
  // the per-companion detail view (greeting, reply, wake
  // phrases, exit phrases, train buttons).
  const [selectedCompanionId, setSelectedCompanionId] = useState<string | null>(null);
  // v3.3.0: which companionId the OWW detector is
  // currently set to. Persisted to AsyncStorage so a
  // cold restart lands on the right wake phrase. Today
  // this is implicit ("whatever was last trained") —
  // this state makes it explicit and user-routable
  // from the new WakePhrasePicker.
  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);
  // v3.1.68: companion picker is a proper modal sheet now (not a
  // system Alert). State holds the open/close flag.
  const [showCompanionPicker, setShowCompanionPicker] = useState(false);

  // v3.1.67: per-companion wake training. Each companion has
  // its own wake word. The trainer takes a companionId +
  // companionName. The user picks which companion to train
  // for. Companion list is loaded from the local cache (the
  // same one HomeScreen writes) so we don't need to be
  // connected to the desktop to open the trainer.
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
            // v3.1.77: migrate legacy wake-samples keys into the
            // per-companion training entry. Idempotent — only
            // runs once per device (companions with new-shape
            // data are skipped).
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

  // v3.3.0: hydrate the active-wake-companion preference.
  // First-time launches have no preference set; the picker
  // will show all rows inactive until the user picks one.
  // Existing on-disk preference is honored so a Settings
  // restart returns to the user's last-active wake.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-active-wake-companion');
        if (raw) setActiveWakeCompanionId(raw);
      } catch (_) {}
    })();
  }, []);

  // v3.4.0: one-time migration from v3.3.0's global exit
  // storage to per-companion. Reads the legacy keys and
  // writes them under the FIRST known companion's
  // namespace. Idempotent (no-op if already migrated or
  // if no legacy keys exist). Called once when both
  // availableCompanions and activeWakeCompanionId have
  // been hydrated — we need at least one companionId to
  // know where to attach the migrated samples.
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

  // v3.4.0: per-companion detail view. Reached by tapping
  // a companion in the top-level Voice mode list. Shows
  // the companion's greeting, reply, wake phrases, exit
  // phrases, and train buttons. Returns to the top-level
  // list via the back button.
  function renderCompanionDetail() {
    const cid = selectedCompanionId;
    if (!cid) return null;
    const companion = availableCompanions.find(c => c.id === cid);
    if (!companion) {
      // Companion was deleted from the cache while we
      // were in this view. Auto-back out.
      setSelectedCompanionId(null);
      return null;
    }
    return (
      <>
        {/* Per-companion header with back button */}
        <View style={[styles.section, styles.detailHeaderRow]}>
          <TouchableOpacity onPress={() => setSelectedCompanionId(null)} style={styles.detailBackBtn}>
            <Text style={styles.detailBackBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.detailHeader}>
            {companion.emoji || companion.icon || '🐾'}  {companion.name}
          </Text>
          <View style={{ width: 60 }} />
        </View>

        <Section title={`${companion.name} settings`} desc={`Wake word, exit phrase, greeting, and reply for ${companion.name}.`}>
          {/* Wake greeting — global semantics, but reachable
              from any companion's detail view for consistency
              with the per-companion wake/exit layout. */}
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

          {/* Exit reply — same global semantics, per-companion layout */}
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

          {/* Wake phrases for this companion */}
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
              setTrainingCompanionId(cid);
              setTrainingCompanionName(companion.name);
              setEditingWakePhrase('');
              setShowOwwTrainer(true);
            }}
          >
            <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>🎤 Train new wake phrase for {companion.name}</Text>
            <Text style={styles.trainBtnSub}>Record 6 samples — desktop trains a custom neural wake word</Text>
          </TouchableOpacity>

          {/* Exit phrases for this companion (NEW v3.4.0 per-companion) */}
          <SubTitle>Exit phrases</SubTitle>
          <Hint>Trained phrases that close voice mode when {companion.name} hears them. Tap 🎙 to retrain, 🗑 to delete.</Hint>
          <PerCompanionExitPicker
            companionId={cid}
            activePhrase={voiceExitPhrase}
            onSelect={async (p) => {
              setVoiceExitPhrase(p);
              const { saveExitPhrase } = await import('../services/VoiceSettings');
              await saveExitPhrase(cid, p);
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
                      await clearExitSamples(cid, p);
                      if (voiceExitPhrase.toLowerCase() === p.toLowerCase()) {
                        setVoiceExitPhrase('');
                        await saveExitPhrase(cid, '');
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
        </Section>
      </>
    );
  }

  // v3.4.0: one-time migration from v3.3.0's global exit
  // storage to per-companion. Reads the legacy keys and
  // writes them under the FIRST known companion's
  // namespace. Idempotent (no-op if already migrated or
  // if no legacy keys exist). Called once when both
  // availableCompanions and activeWakeCompanionId have
  // been hydrated — we need at least one companionId to
  // know where to attach the migrated samples.
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

  // ── Voice & Speech ────────────────────────────────────────────
  // v3.1.75: single engine toggle (local vs premium API) replaces
  // the two-always-visible sub-sections. Local TTS uses Android's
  // built-in Text-to-Speech engine (free, works offline). Premium
  // API is a placeholder for the upcoming desktop bridge.
  const [voiceEngine, setVoiceEngine] = useState<'local' | 'api'>('local');
  const [voiceLocalId, setVoiceLocalId] = useState('default');
  // Premium API settings (placeholder — not yet wired to the desktop)
  const [voiceApiProvider, setVoiceApiProvider] = useState('elevenlabs');
  const [voiceApiKey, setVoiceApiKey] = useState('');
  const [voiceApiVoice, setVoiceApiVoice] = useState('nova');

  // ── Agent Reach ───────────────────────────────────────────────
  const [remotePerms, setRemotePerms] = useState<RemotePermissions>({
    file_read: false,
    file_write: false,
    launch_intent: false,
    get_location: false,
    get_camera: false,
    read_notifications: false,
  });

  // ── Back button: navigate sub-screens first, then exit ───────
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showOwwTrainer) { setShowOwwTrainer(false); return true; }
      if (showExitPhraseTrainer) { setShowExitPhraseTrainer(false); return true; }
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack, showOwwTrainer]);

  // v3.2.11: stop the bundled pre-trained wake listener while
  // SettingsScreen is mounted. Settings includes a "Train wake
  // word" button; while the user is reading the screen or
  // configuring a companion, the bundled "hey jarvis" listener
  // from HomeScreen is still running, and the wake notification
  // would fire on a false match and interrupt the UI. The
  // trainer sub-screen stops it again explicitly on mount (this
  // covers the case where the user is just looking at settings
  // without entering the trainer).
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

  // v3.2.0: refresh the saved-wake-models map whenever the
  // companion picker opens or a training completes. The
  // Kotlin side keeps this in SharedPreferences — the query
  // is sync-ish (single SharedPreferences read) so it's safe
  // to fire on every picker open.
  useEffect(() => {
    if (!showCompanionPicker) return;
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (!models) return;
        // models is a JS Map<string, {agentId, phrase, path, savedAt}>
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
  }, [showCompanionPicker]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    checkPermissions();
    AsyncStorage.getItem('cyberclaw-bg-listening').then(v => { if (v === 'false') setBgListening(false); });
    AsyncStorage.getItem('cyberclaw-wake-bg-threshold').then(v => { if (v) setBgThreshold(Math.round(parseFloat(v) * 100)); });
    AsyncStorage.getItem('cyberclaw-wake-fg-threshold').then(v => { if (v) setFgThreshold(Math.round(parseFloat(v) * 100)); });
    AsyncStorage.getItem('cyberclaw-ready-phrase').then(v => { if (v) setReadyPhrase(v); });
    // v3.2.29: hydrate the exit reply phrase (mirror of
    // the wake greeting hydration above). Empty string
    // means "silent close" — no audio played, no log
    // spam, just drop back to passive wake listening.
    AsyncStorage.getItem('cyberclaw-exit-reply-phrase').then(v => { if (v != null) setExitReplyPhrase(v); });
    // v3.2.17 — hydrate voice-mode loop settings.
    AsyncStorage.getItem('cyberclaw-voice-silence-ms').then(v => {
      if (v) {
        const n = parseInt(v, 10);
        if (!isNaN(n)) setVoiceSilenceMs(Math.max(2000, Math.min(10000, n)));
      }
    });
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
    AsyncStorage.getItem(SETTINGS_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          if (saved.audioSettings) setAudioSettings(saved.audioSettings);
        } catch {}
      }
    });
    NativeModules.NativeBackground?.checkWakePermissions?.()
      .then((p: any) => setWakePerms(p))
      .catch(() => {});

    // Voice settings (new in v3.1.13)
    // v3.1.75: cyberclaw-voice-engine replaces cyberclaw-voice-local.
    // On first load, migrate: if voice-engine isn't set but the old
    // voice-local key is, derive engine from it (true → local, false → api).
    AsyncStorage.getItem('cyberclaw-voice-engine').then(v => {
      if (v === 'local' || v === 'api') { setVoiceEngine(v); return; }
      AsyncStorage.getItem('cyberclaw-voice-local').then(old => {
        setVoiceEngine(old === 'false' ? 'api' : 'local');
      });
    });
    AsyncStorage.getItem('cyberclaw-voice-local-id').then(v => { if (v) setVoiceLocalId(v); });
    AsyncStorage.getItem('cyberclaw-voice-api-provider').then(v => { if (v) setVoiceApiProvider(v); });
    AsyncStorage.getItem('cyberclaw-voice-api-key').then(v => { if (v) setVoiceApiKey(v); });
    AsyncStorage.getItem('cyberclaw-voice-api-voice').then(v => { if (v) setVoiceApiVoice(v); });

    syncClient.loadSaved().then(({ host }) => { if (host) setHostIp(host); });
    getPermissions().then(p => setRemotePerms(p)).catch(() => {});

    const onStateChange = (data: any) => {
      const s = data.state;
      if (s === 'connected' || s === 'reconnecting') setConnectionStatus('Connected ✓');
      else if (s === 'connecting') setConnectionStatus('Connecting...');
      else if (s === 'lost') setConnectionStatus('Connection lost ✕');
      else setConnectionStatus('Disconnected');
    };
    if (syncClient.connected) setConnectionStatus('Connected ✓');
    syncClient.on('state_change', onStateChange);
    syncClient.on('paired', () => {
      setConnectionStatus('Connected ✓');
      Alert.alert('Paired!', 'Mobile app is now linked to your desktop CyberClaw.');
    });
    syncClient.on('pair_failed', (msg: any) => {
      Alert.alert('Pairing Failed', msg.error || 'Wrong code or expired.');
    });
    return () => { syncClient.off('state_change', onStateChange); };
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
      const p = await NativeModules.NativeBackground?.checkWakePermissions?.().catch(() => null);
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

  const pairDevice = () => {
    if (!pairingCode.trim() || pairingCode.length !== 6) {
      Alert.alert('Error', 'Enter the 6-digit pairing code from your desktop');
      return;
    }
    syncClient.pair(pairingCode, 'Android Phone');
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

  // Debounced auto-save for wake greeting
  const persistReadyPhrase = (v: string) => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
    readyPhraseSaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-ready-phrase', v);
      setReadyPhraseSavedAt(Date.now());
      // v3.1.91: kick off a desktop synthesis for the new
      // phrase so the next wake event has a cached audio
      // to play. Fire-and-forget — the greeting_audio
      // listener in WakeModeScreen saves the result when
      // it arrives (the listener is only mounted in Wake
      // Mode, so the audio response might arrive while
      // Settings is showing — that's fine, the cache
      // write is the important bit, not the listening).
      if (v && v.trim()) {
        try {
          const { ensureGreetingCached } = require('../services/GreetingAudioCache');
          ensureGreetingCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // v3.2.29: persist the exit reply phrase. Mirror of
  // persistReadyPhrase — debounced 600ms, then save
  // + kick off desktop synthesis. Empty string = silent
  // close (no synthesis, no audio).
  const persistExitReplyPhrase = (v: string) => {
    if (exitReplySaveTimer.current) clearTimeout(exitReplySaveTimer.current);
    exitReplySaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-exit-reply-phrase', v);
      setExitReplySavedAt(Date.now());
      if (v && v.trim()) {
        try {
          const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
          ensureExitReplyCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // Voice settings (auto-save on change)
  // v3.1.75: removed setVoiceLocalEnabledAndSave. The old "Use local
  // voice" boolean is now derived from voiceEngine: local enabled iff
  // voiceEngine === 'local'. The old cyberclaw-voice-local key is
  // read on first load as a migration fallback (see the useEffect
  // below) but never written again.
  const setVoiceEngineAndSave = async (v: 'local' | 'api') => {
    setVoiceEngine(v);
    await AsyncStorage.setItem('cyberclaw-voice-engine', v);
  };
  const setVoiceLocalIdAndSave = async (v: string) => {
    setVoiceLocalId(v);
    await AsyncStorage.setItem('cyberclaw-voice-local-id', v);
  };
  const setVoiceApiProviderAndSave = async (v: string) => {
    setVoiceApiProvider(v);
    await AsyncStorage.setItem('cyberclaw-voice-api-provider', v);
    // Reset voice to first available for this provider
    const firstVoice = PREMIUM_PROVIDERS.find(p => p.id === v)?.voices[0].id;
    if (firstVoice) {
      setVoiceApiVoice(firstVoice);
      await AsyncStorage.setItem('cyberclaw-voice-api-voice', firstVoice);
    }
  };
  const setVoiceApiKeyAndSave = async (v: string) => {
    setVoiceApiKey(v);
    await AsyncStorage.setItem('cyberclaw-voice-api-key', v);
  };
  const setVoiceApiVoiceAndSave = async (v: string) => {
    setVoiceApiVoice(v);
    await AsyncStorage.setItem('cyberclaw-voice-api-voice', v);
  };

  // Test voice on mobile (local Android TTS)
  const testLocalVoice = () => {
    const phrase = 'Ready to chat. The boar is happy.';
    if (!WakeWordModule?.speakText) {
      Alert.alert('TTS unavailable', 'WakeWordModule not available.');
      return;
    }
    // v3.1.90: probe whether the device has any TTS engine
    // installed before attempting to speak. If not, offer
    // to launch the system install dialog so the user can
    // install Google TTS / eSpeak NG.
    const tryInstall = () => {
      if (WakeWordModule?.installTtsData) {
        WakeWordModule.installTtsData().catch(() => {});
      }
    };
    if (WakeWordModule?.hasTtsEngine) {
      WakeWordModule.hasTtsEngine()
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
          WakeWordModule.speakText(phrase).catch(() => {
            Alert.alert('TTS init failed', 'Engine is installed but failed to initialise. Try installing voice data in Android Settings → Accessibility → Text-to-speech output.');
          });
        })
        .catch(() => {
          // hasTtsEngine probe failed; just try speak anyway.
          WakeWordModule.speakText(phrase).catch(() => {
            Alert.alert('TTS unavailable', 'Your device has no Text-to-Speech engine installed.');
          });
        });
    } else {
      WakeWordModule.speakText(phrase).catch(() => {
        Alert.alert('TTS unavailable', 'Your device has no Text-to-Speech engine installed.');
      });
    }
  };

  // Test voice on desktop (sends a speak action via the WebView)
  const testDesktopVoice = () => {
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
  };

  // v3.2.2: removed the legacy DTW-based wake training
  // (WakePhraseMenu / TrainingDetailScreen / WakeWordTester).
  // The openWakeWord pipeline supersedes them — it produces
  // a proper TFLite model trained on the desktop GPU instead
  // of a DTW sample matcher that triggered on any
  // consonant-vowel speech pattern. The new trainer is below.
  // v3.2.0: the openWakeWord trainer UI. Sends the user's
  // recorded samples to the desktop for actual openWakeWord
  // training (Piper TTS synthesis + DNN training), then
  // hot-swaps the trained .tflite into the running
  // OpenWakeWordDetector. See OpenWakeWordTrainer.tsx.
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
        // v3.4.0: trainer writes to per-companion keys.
        // Use active companion; fall back to first
        // available; fall back to 'default' for first-time
        // launch with no cached companions yet.
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

  // ── Main settings render ─────────────────────────────────────
  return (
    <>
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
      </View>

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

        {syncClient.connected && !syncClient.authenticated && (
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

      {/* v3.4.0: when a companion is selected, the entire
          🎤 Voice mode section is replaced by a per-companion
          detail view. The user returns to the top-level list
          via a back button at the top of the detail view. */}
      {selectedCompanionId ? (
        renderCompanionDetail()
      ) : (
        <>
          {/* ── 🎤 Voice mode (top-level, with companion list) ── */}
          <Section title="🎤 Voice mode" desc="Configure how voice mode works for each companion. Tap a companion to customize their wake phrase, exit phrase, greeting, and reply.">

            {/* Background listening (existing toggle, unchanged) */}
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

            {/* ── Companions list (NEW v3.4.0) ── */}
            <SubTitle>Companions</SubTitle>
            <Hint>Tap a companion to configure their wake phrase, exit phrase, greeting, and reply.</Hint>
            {availableCompanions.length === 0 ? (
              <View style={styles.trainedPickerHint}>
                <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
                  No companions yet. Connect to the desktop to load your companions.
                </Text>
              </View>
            ) : (
              <View style={styles.companionList}>
                {availableCompanions.map(c => {
                  const isActive = activeWakeCompanionId === c.id;
                  const savedModel = savedWakeModels[c.id];
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={[
                        styles.companionListRow,
                        isActive && styles.companionListRowActive,
                      ]}
                      onPress={() => setSelectedCompanionId(c.id)}
                    >
                      <Text style={styles.companionListEmoji}>{c.emoji || c.icon || '🐾'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.companionListName, isActive && { color: '#10b981' }]}>
                          {c.name}
                        </Text>
                        <Text style={styles.companionListDetail}>
                          {savedModel?.phrase ? `wake: "${savedModel.phrase}"` : 'no wake word yet'}
                        </Text>
                      </View>
                      {isActive ? (
                        <Text style={styles.companionListActive}>◉</Text>
                      ) : null}
                      <Text style={styles.companionListArrow}>›</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Train-new companion button — opens the existing
                companion picker modal which then opens the
                trainer. Same UX as v3.3.0. */}
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6' }]}
              onPress={() => {
                if (availableCompanions.length === 0) {
                  Alert.alert(
                    'No companions yet',
                    'Connect to the desktop and load at least one companion before training the wake word.',
                  );
                  return;
                }
                setShowCompanionPicker(true);
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>🧠 Train wake phrase for new companion</Text>
              <Text style={styles.trainBtnSub}>Record 6 samples — desktop trains a custom neural wake word for that companion</Text>
            </TouchableOpacity>

            {/* Audio buffer (existing, unchanged) */}
            <SubTitle>Audio buffer</SubTitle>
            <Hint>How much audio context to keep so the companion can hear what you said just before the wake word.</Hint>
            <Label>Lookback (minutes)</Label>
            <View style={styles.optionRow}>
              {[5, 10, 30, 60].map(m => (
                <OptionBtn key={m} active={audioSettings.lookbackMinutes === m} label={`${m}`} onPress={() => updateAudio('lookbackMinutes', m)} />
              ))}
            </View>
            <Label>Conversation timeout (minutes)</Label>
            <Hint>After this much silence, the companion returns to passive wake word detection.</Hint>
            <View style={styles.optionRow}>
              {[1, 2, 5].map(m => (
                <OptionBtn key={m} active={audioSettings.conversationTimeoutMinutes === m} label={`${m}`} onPress={() => updateAudio('conversationTimeoutMinutes', m)} />
              ))}
            </View>
            <Label>Recording retention (days)</Label>
            <Hint>Daily audio logs are kept locally for this many days, then auto-deleted.</Hint>
            <View style={styles.optionRow}>
              {[1, 7, 14, 30].map(d => (
                <OptionBtn key={d} active={audioSettings.retentionDays === d} label={`${d}`} onPress={() => updateAudio('retentionDays', d)} />
              ))}
            </View>
            <TouchableOpacity style={styles.saveAudioBtn} onPress={saveAudioSettings}>
              <Text style={styles.saveAudioBtnText}>
                {audioSettingsSavedAt
                  ? `✅ Saved at ${new Date(audioSettingsSavedAt).toLocaleTimeString()}`
                  : '💾 Save audio settings'}
              </Text>
            </TouchableOpacity>

            {/* Voice mode close — silence timeout (existing, unchanged) */}
            <SubTitle>Silence to end turn: {voiceSilenceMs / 1000}s</SubTitle>
            <Hint>Voice mode stays open in a multi-turn loop. After this much silence, the turn ends.</Hint>
            <View style={styles.optionRow}>
              {[2, 3, 5, 7, 10].map(s => (
                <OptionBtn
                  key={s}
                  active={voiceSilenceMs === s * 1000}
                  label={`${s}s`}
                  onPress={() => {
                    setVoiceSilenceMs(s * 1000);
                    AsyncStorage.setItem('cyberclaw-voice-silence-ms', String(s * 1000));
                  }}
                />
              ))}
            </View>

            {/* Match thresholds (existing, unchanged) */}
            <SubTitle>Match thresholds</SubTitle>
            <Hint>Detector sensitivity. Higher = stricter (fewer false wakes). Tune if you're getting accidental triggers.</Hint>
            <Label>Foreground: {fgThreshold}%</Label>
            <View style={styles.thresholdRow}>
              <Text style={styles.thresholdEdge}>40%</Text>
              <View style={{ flex: 1, flexDirection: 'row' }}>
                {[40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90].map(v => (
                  <TouchableOpacity
                    key={v}
                    onPress={async () => {
                      setFgThreshold(v);
                      await AsyncStorage.setItem('cyberclaw-wake-fg-threshold', String(v / 100));
                    }}
                    style={[
                      styles.thresholdCell,
                      fgThreshold === v ? styles.thresholdCellActive :
                      fgThreshold > v ? styles.thresholdCellPast : styles.thresholdCellFuture,
                    ]}
                  >
                    <Text style={[styles.thresholdCellText, fgThreshold === v && { color: '#fff' }]}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.thresholdEdge}>90%</Text>
            </View>

            <Label>Background: {bgThreshold}%</Label>
            <View style={styles.thresholdRow}>
              <Text style={styles.thresholdEdge}>40%</Text>
              <View style={{ flex: 1, flexDirection: 'row' }}>
                {[40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90].map(v => (
                  <TouchableOpacity
                    key={v}
                    onPress={async () => {
                      setBgThreshold(v);
                      await AsyncStorage.setItem('cyberclaw-wake-bg-threshold', String(v / 100));
                    }}
                    style={[
                      styles.thresholdCell,
                      bgThreshold === v ? styles.thresholdCellActive :
                      bgThreshold > v ? styles.thresholdCellPast : styles.thresholdCellFuture,
                    ]}
                  >
                    <Text style={[styles.thresholdCellText, bgThreshold === v && { color: '#fff' }]}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.thresholdEdge}>90%</Text>
            </View>
          </Section>
        </>
      )}

      {/* ── 🔊 Voice & Speech ────────────────────────────────── */}
      <Section title="🔊 Voice & Speech" desc="How your companion speaks back to you.">
        {/* v3.1.75: single engine toggle (local vs premium API) at
            the top, settings below swap based on which is selected.
            Replaces the v3.1.13 layout that always showed both
            Local and Premium sub-sections in sequence — too noisy. */}
        <Label>Engine</Label>
        <View style={styles.optionRow}>
          <OptionBtn active={voiceEngine === 'local'} label="📱 Local (free)" onPress={() => setVoiceEngineAndSave('local')} />
          <OptionBtn active={voiceEngine === 'api'} label="✨ Premium API" onPress={() => setVoiceEngineAndSave('api')} />
        </View>

        {voiceEngine === 'local' ? (
          <>
            <SubTitle>Local voice (free)</SubTitle>
            <Hint>Uses your Android device's built-in Text-to-Speech engine. Works offline.</Hint>
            <Label>Voice</Label>
            <View style={styles.optionRow}>
              {LOCAL_VOICES.map(v => (
                <OptionBtn key={v.id} active={voiceLocalId === v.id} label={v.label} onPress={() => setVoiceLocalIdAndSave(v.id)} />
              ))}
            </View>
            <TouchableOpacity style={styles.testBtn} onPress={testLocalVoice}>
              <Text style={styles.testBtnText}>🔊 Test local voice on phone</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.testBtn, { marginTop: 8 }]} onPress={testDesktopVoice}>
              <Text style={styles.testBtnText}>🖥️ Test voice on desktop</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <SubTitle>Premium voice API (coming soon)</SubTitle>
            <Hint>Cloud voices with higher quality. The desktop bridge to use these for synthesis is planned — the key is stored locally so it'll be picked up when the bridge lands.</Hint>
            <Label>Provider</Label>
            <View style={styles.optionRow}>
              {PREMIUM_PROVIDERS.map(p => (
                <OptionBtn key={p.id} active={voiceApiProvider === p.id} label={p.label} onPress={() => setVoiceApiProviderAndSave(p.id)} />
              ))}
            </View>
            <Label>API key</Label>
            <TextInput
              style={styles.input}
              value={voiceApiKey}
              onChangeText={setVoiceApiKeyAndSave}
              placeholder="Paste your API key"
              placeholderTextColor="#555"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Label>Voice</Label>
            <View style={styles.optionRow}>
              {PREMIUM_PROVIDERS.find(p => p.id === voiceApiProvider)?.voices.map(v => (
                <OptionBtn key={v.id} active={voiceApiVoice === v.id} label={v.label} onPress={() => setVoiceApiVoiceAndSave(v.id)} />
              ))}
            </View>
          </>
        )}
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
        can pick the right one to train the wake word for. */}
    <Modal
      visible={showCompanionPicker}
      transparent
      animationType="fade"
      onRequestClose={() => setShowCompanionPicker(false)}
    >
      <Pressable
        style={styles.pickerOverlay}
        onPress={() => setShowCompanionPicker(false)}
      >
        <Pressable style={styles.pickerSheet} onPress={() => { /* swallow */ }}>
          <Text style={styles.pickerTitle}>Train wake word for…</Text>
          <Text style={styles.pickerSub}>Each companion has its own wake word.</Text>
          <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
            {availableCompanions.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={styles.pickerRow}
                onPress={() => {
                  setTrainingCompanionId(c.id);
                  setTrainingCompanionName(c.name);
                  setShowCompanionPicker(false);
                  // v3.2.2: the picker is now only used for the
                  // openWakeWord trainer. The legacy DTW-based
                  // Wake Phrases menu is gone.
                  setShowOwwTrainer(true);
                }}
              >
                <Text style={styles.pickerRowIcon}>{c.emoji || c.icon || '🐾'}</Text>
                <Text style={styles.pickerRowName} numberOfLines={1}>{c.name}</Text>
                {savedWakeModels[c.id] ? (
                  <Text style={styles.pickerRowBadge}>✓ trained</Text>
                ) : null}
                <Text style={styles.pickerRowHint}>train →</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity
            style={styles.pickerCancel}
            onPress={() => setShowCompanionPicker(false)}
          >
            <Text style={styles.pickerCancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  </>
  );
}

// ── Inline section components ────────────────────────────────
function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {desc ? <Text style={styles.sectionDesc}>{desc}</Text> : null}
      {children}
    </View>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.subGroupTitle}>{children}</Text>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

function Toggle({ title, sub, value, onValueChange }: { title: string; sub: string; value: boolean; onValueChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleInfo}>
        <Text style={styles.toggleTitle}>{title}</Text>
        <Text style={styles.toggleSub}>{sub}</Text>
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
  return (
    <TouchableOpacity style={[styles.optionBtn, active && styles.optionActive]} onPress={onPress}>
      <Text style={[styles.optionText, active && styles.optionTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * v3.2.27 — List of trained exit phrases with radio buttons.
 * v3.3.0 — Added per-row actions (🎙 retrain, 🗑 delete) since
 * the Wake/Exit layout puts the trainer *below* the list now
 * (was: the list is below the trainer card). Both taps call
 * back to the parent so the parent can open the trainer with
 * the right preset phrase. onClear stays for the
 * "disable all" link at the bottom.
 *
 * Reads AsyncStorage for keys matching
 * `cyberclaw-exit-samples-*`. Each entry becomes a row; the
 * active one (matches `activePhrase`) gets the green ring.
 * If no phrases are trained, shows a hint pointing to the
 * trainer card below.
 */
function TrainedPhrasePicker({ activePhrase, onSelect, onClear, onRetrain, onDelete }: {
  activePhrase: string;
  onSelect: (p: string) => void;
  onClear: () => void;
  // v3.3.0: optional retrain/delete handlers. When
  // provided, the row shows 🎙 and 🗑 buttons on the
  // right edge; tapping them calls back to the parent
  // (which opens the trainer modal / shows the delete
  // confirm). When omitted, the row is read-only
  // (preserves v3.2.27 behavior).
  onRetrain?: (p: string) => void;
  onDelete?: (p: string) => void;
}) {
  const [phrases, setPhrases] = useState<string[]>([]);
  const reload = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const exitKeys = keys.filter(k => k.startsWith('cyberclaw-exit-samples-'));
      // Normalize key suffix back to the phrase. The trainer
      // stores phrases as the suffix with hyphens replacing
      // spaces; reverse that here.
      const list = exitKeys.map(k =>
        k.replace('cyberclaw-exit-samples-', '').replace(/-/g, ' ')
      );
      setPhrases(list);
    } catch (_) {}
  }, []);
  useEffect(() => { reload(); }, [reload, activePhrase]);

  if (phrases.length === 0) {
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          No trained exit phrases yet. Tap "Train exit phrase"
          below to record 6 samples.
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
            {onRetrain || onDelete ? (
              // v3.3.0: small action icon group on the
              // right. Same row press still selects the
              // active phrase — these icons are touch-
              // targets that stop propagation via the
              // inner TouchableOpacity.
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
            ) : (
              <Text style={styles.trainedPickerBadge}>✓ trained</Text>
            )}
          </TouchableOpacity>
        );
      })}
      {activePhrase && (
        <TouchableOpacity onPress={onClear} style={styles.trainedPickerClear}>
          <Text style={{ color: '#dc2626', fontSize: 12 }}>Disable exit phrase</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * v3.3.0 — List of trained wake phrases, one per companion.
 * Mirrors TrainedPhrasePicker but reads from the wake
 * training data (WakeTrainingModel + native .tflite saved
 * models) instead of the per-phrase exit samples.
 *
 * Each row shows the companion's emoji, name, and the
 * trained wake phrase. Tap a row to make that companion's
 * model the active wake (which the HomeScreen's OWW
 * listener picks up via cyberclaw-audio-settings.wakeWord).
 * Tap 🎙 to retrain (opens the trainer modal pre-loaded
 * with that companion's phrase); tap 🗑 to delete the
 * trained model for that companion.
 *
 * Empty state: shows a hint pointing to the train-new
 * button below.
 */
function WakePhrasePicker({
  companions,
  savedModels,
  activeCompanionId,
  onSelect,
  onRetrain,
  onDelete,
}: {
  companions: Array<{ id: string; name: string; emoji?: string | null; icon?: string | null }>;
  savedModels: Record<string, { phrase: string; path: string; savedAt: number }>;
  activeCompanionId: string | null;
  onSelect: (companionId: string) => void;
  onRetrain: (companionId: string, phrase: string) => void;
  onDelete: (companionId: string) => void;
}) {
  // Build the list: only companions that have a saved
  // wake model. Show them in the same order they appear
  // in the cached agents list (which mirrors the
  // desktop's arena order).
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
          No trained wake phrases yet. Tap "Train wake phrase for new companion"
          below to record 6 samples for one of your companions.
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
      {/* v3.3.0: row showing the currently-active wake
          model if none of the listed companions is set
          as active. Without this, the user might train a
          wake word, have it become active by default,
          then look at the picker and see no active badge
          — confusing. Shows "..." if there's a saved
          model for some companionId not in the current
          agents list (cached stale). */}
      {!activeCompanionId && trainedRows.length > 0 ? (
        <Text style={[styles.trainedPickerBadge, { marginTop: 6, alignSelf: 'flex-start' }]}>
          Tap a row to activate
        </Text>
      ) : null}
    </View>
  );
}

/**
 * v3.4.0: per-companion exit-phrase picker. Reads
 * AsyncStorage for keys matching
 * `cyberclaw-exit-samples-<companionId>-*` and renders
 * each as a row with active selector + 🎙 retrain + 🗑
 * delete. Mirrors TrainedPhrasePicker but the storage
 * namespace is per-companion (the v3.4.0 storage model
 * move; legacy global keys are migrated by
 * `migrateLegacyExitSamples` on first launch of v3.4.0
 * and then ignored).
 */
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
          No trained exit phrases yet. Tap "Train new exit phrase"
          below to record 6 samples.
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, paddingTop: Platform.OS === 'android' ? 34 : 10 },
  backBtn: { color: '#f7931a', fontSize: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginLeft: 16 },
  // v3.1.75: orange section border for better visual distinction
  // (was #222 — almost invisible against the #111 background).
  // Uses the same #f7931a brand orange as the active option pills
  // and the test buttons, so the whole settings page reads as
  // one consistent colour system.
  section: { backgroundColor: '#111', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#f7931a' },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  sectionDesc: { color: '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  subGroupTitle: { color: '#aaa', fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12, letterSpacing: 0.5 },
  label: { color: '#ccc', fontSize: 14, marginBottom: 6, marginTop: 8 },
  hint: { color: '#666', fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 },
  savedHint: { color: '#4caf50', fontSize: 12, marginTop: 6 },
  input: { backgroundColor: '#1a1a2e', color: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 16, borderWidth: 1, borderColor: '#333' },
  button: { backgroundColor: '#f7931a', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  buttonText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  buttonConnected: { backgroundColor: '#333', borderWidth: 1, borderColor: '#4ade80' },
  buttonTextConnected: { color: '#4ade80' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  dotGreen: { backgroundColor: '#4ade80' },
  dotYellow: { backgroundColor: '#eab308' },
  dotRed: { backgroundColor: '#666' },
  statusText: { color: '#ccc', fontSize: 14 },
  divider: { height: 1, backgroundColor: '#222', marginVertical: 12 },
  permRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#1a1a2e' },
  permLabel: { color: '#ddd', fontSize: 14, fontWeight: 'bold' },
  permDesc: { color: '#777', fontSize: 11, marginTop: 2 },
  permBtn: { backgroundColor: '#f7931a', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  permBtnText: { color: '#000', fontSize: 12, fontWeight: 'bold' },
  permBtnSmall: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#111', borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#222' },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleTitle: { color: '#eee', fontSize: 14, fontWeight: '600' },
  toggleSub: { color: '#666', fontSize: 12, marginTop: 2 },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  optionBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#333' },
  optionActive: { backgroundColor: 'rgba(247,147,26,0.2)', borderColor: '#f7931a' },
  optionText: { color: '#888', fontSize: 13 },
  optionTextActive: { color: '#f7931a', fontWeight: 'bold' },
  // v3.2.27 — trained-phrase picker rows
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
  // v3.3.0: per-row action group on the right edge of
  // each trained-phrase / wake-phrase row. Each action
  // (🎙 retrain, 🗑 delete) is its own touch target with
  // its own hitSlop so the user can tap them precisely
  // without accidentally selecting the row.
  trainedPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
  },
  // v3.4.0: companion list rows on the top-level Voice
  // mode section. Each row shows emoji + name + a one-line
  // summary of the active wake phrase + a chevron indicating
  // it's tappable. The active-wake row gets a green border
  // to mirror the existing trainedPickerActive visual.
  companionList: {
    marginTop: 8,
  },
  companionListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 6,
  },
  companionListRowActive: {
    backgroundColor: 'rgba(16,185,129,0.10)',
    borderColor: '#10b981',
  },
  companionListEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  companionListName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  companionListDetail: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
    fontStyle: 'italic',
  },
  companionListActive: {
    color: '#10b981',
    fontSize: 18,
    marginHorizontal: 8,
    fontWeight: 'bold',
  },
  companionListArrow: {
    color: '#888',
    fontSize: 22,
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
    color: '#f7931a',
    fontSize: 16,
  },
  detailHeader: {
    color: '#fff',
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
    color: '#aaa',
    fontSize: 12,
    marginTop: 1,
    fontStyle: 'italic',
  },
  trainedPickerClear: {
    paddingVertical: 6,
    alignItems: 'center',
  },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  thresholdEdge: { color: '#888', fontSize: 12, width: 32, textAlign: 'center' },
  thresholdCell: { flex: 1, height: 28, justifyContent: 'center', alignItems: 'center', borderRadius: 4, marginHorizontal: 1 },
  thresholdCellActive: { backgroundColor: '#f7931a' },
  thresholdCellPast: { backgroundColor: '#3a2a00' },
  thresholdCellFuture: { backgroundColor: '#1a1a1a' },
  thresholdCellText: { color: '#666', fontSize: 9 },
  debugBox: { backgroundColor: '#0a0a1a', borderRadius: 8, padding: 10, marginTop: 12, borderWidth: 1, borderColor: '#222' },
  debugBoxTitle: { color: '#f7931a', fontSize: 11, fontWeight: 'bold' },
  debugBoxClear: { color: '#666', fontSize: 11 },
  debugLine: { color: '#8a8', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  trainBtn: { backgroundColor: '#1a1a2e', borderRadius: 10, padding: 14, marginTop: 8, borderWidth: 1, borderColor: '#f7931a', borderStyle: 'dashed', alignItems: 'center' },
  trainBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  trainBtnSub: { color: '#888', fontSize: 12, marginTop: 2 },
  testBtn: { backgroundColor: 'rgba(247,147,26,0.15)', borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#f7931a', marginTop: 8 },
  testBtnText: { color: '#f7931a', fontSize: 14, fontWeight: '600' },
  saveAudioBtn: { backgroundColor: '#22c55e', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  saveAudioBtnText: { color: '#000', fontSize: 15, fontWeight: 'bold' },
  aboutFooter: { alignItems: 'center', marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#222' },
  aboutVersion: { color: '#666', fontSize: 12 },
  aboutLink: { color: '#444', fontSize: 11, marginTop: 4 },
  // v3.1.68: wake-training companion picker modal. Bottom
  // sheet style with a dimmed backdrop. The backdrop
  // Pressable closes the modal; the inner Pressable
  // swallows taps so clicking a row or the Cancel button
  // doesn't bubble up and close the sheet.
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: Platform.OS === 'android' ? 24 : 16,
    borderTopWidth: 1,
    borderColor: '#222',
  },
  pickerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  pickerSub: {
    color: '#888',
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
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  pickerRowIcon: {
    fontSize: 24,
    width: 36,
    textAlign: 'center',
    marginRight: 12,
  },
  pickerRowName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  pickerRowHint: {
    color: '#f7931a',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },
  pickerRowBadge: {
    color: '#10b981',
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
    backgroundColor: '#222',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  pickerCancelText: {
    color: '#ccc',
    fontSize: 15,
    fontWeight: '600',
  },
});
