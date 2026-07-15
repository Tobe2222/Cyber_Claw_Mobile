/**
 * SettingsScreen — Mobile companion settings
 *
 * v3.4.7: split "🎤 Voice mode" into two separate Section
 * blocks, each with its own orange border:
 *   - 🎧 Wake listening (global mic behavior)
 *       * Background listening toggle (master on/off)
 *       * Audio buffer (lookback)
 *       * Silence timeout (voice mode close)
 *   - 🐾 Companions (per-companion list; tap → CompanionSettingsScreen)
 *       * Companion rows: each shows their trained wake phrase
 *
 * Previously these were one Section with an in-section divider
 * (v3.4.5 GroupTitle + GroupDivider). Tobe's v3.4.6 feedback:
 * the divider still didn't read as "these are two different
 * concepts" — a separate Section block is the right grouping.
 *
 * v3.4.7: also removed the Match Thresholds UI (foreground /
 * background % sensitivity). The thresholds are still respected
 * by the wake detector (HomeScreen/WakeModeScreen read them
 * from AsyncStorage) but the UI control was redundant — the
 * v3.1.95 openWakeWord TFLite ML detector is ~95% accurate out
 * of the box and rarely needs tuning.
 *
 * v3.4.0: 3-level hierarchy replaces the v3.3.0 flat two-section
 * (Wake + Exit) layout. Tobe complained that "Wake settings" and
 * "Exit settings" each contained unrelated controls (audio buffer,
 * match thresholds, silence timeout) which made both sections
 * feel like grab-bags.

 *       v3.4.1 layout: the three "details" controls were
 *       physically moved up to sit immediately under the
 *       master toggle, so they read as one block. Previously
 *       they were loose siblings separated by the Companions
 *       list + train-new button, which felt like a grab-bag.
 *       v3.4.2: the top-level train-new-wake button (and its
 *       companion picker modal) was removed. Training lives
 *       exclusively inside each companion's detail view —
 *       tap companion → detail → Train button there.
 *       v3.4.4: companion detail view is NO LONGER rendered
 *       inline in this file. It's been extracted to its own
 *       screen (CompanionSettingsScreen.tsx) reached via
 *       App.tsx's 'companion' route. Tap companion →
 *       App.tsx swaps to CompanionSettingsScreen → back
 *       returns to SettingsScreen. SettingsScreen now just
 *       owns the top-level Voice mode list and the rest of
 *       the settings sections (Voice & Speech, Agent Reach,
 *       Connection, About).
 *
 *   (2) Per-companion detail view (tap a companion to enter).
 *       v3.4.3: 5-level hierarchy. The detail view is now
 *       two levels, not one flat page.
 *
 *       (2a) <Companion> settings (overview page)
 *            - Back button + companion header
 *            - 🎤 Wake settings card  → tap → (2b) wake sub-page
 *            - 🚪 Exit settings card  → tap → (2c) exit sub-page
 *
 *       (2b) Wake settings (sub-page for one companion)
 *            - Back button → returns to (2a) overview
 *            - Wake greeting TextInput
 *            - Wake phrases for this companion (WakePhrasePicker)
 *            - Train-new wake phrase for this companion
 *
 *       (2c) Exit settings (sub-page for one companion)
 *            - Back button → returns to (2a) overview
 *            - Exit reply TextInput
 *            - Exit phrases for this companion (PerCompanionExitPicker)
 *            - Train-new exit phrase for this companion
 *
 *       v3.4.3 rationale: v3.4.2 put all per-companion
 *       controls on one scroll page; Tobe said it was
 *       confusing and asked for a dedicated detail page
 *       that drills into wake / exit sub-pages. The
 *       detail view became a navigation surface, not a
 *       control dump.
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
 *   3. 🎧 Wake listening    — Master background-listening toggle
 *                            (per-companion silence timeout lives in
 *                            each companion's Voice sub-page)
 *   4. 🐾 Companions       — Per-companion list (tap → detail). Also
 *                            hosts the global "send word" trainer at
 *                            the bottom (shared across companions).
 *                            Each companion's detail page (v3.7.0) has
 *                            Wake / Exit / Voice sub-pages.
 *   5. 🎙️ Background recording — Rolling audio buffer (lookback
 *                            minutes). Powers the wake-word context
 *                            today; ambient daily recording in a
 *                            future release.
 *   6. 🤖 Agent Reach      — Remote permissions (file/app/location/camera)
 *   8. 🔑 API keys         — Global API keys (ElevenLabs) + the
 *                            master "✨ API speech" toggle that
 *                            gates per-companion engine selection
 *                            in v3.7.0.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import SendPhraseTrainer from '../components/SendPhraseTrainer';
import WakeSetManagerScreen from '../components/WakeSetManagerScreen';
// v3.10.24: shared global speaker-profile bar (full
// variant) at the top of the Voice mode section.
import VoiceEnrollmentBar from '../components/VoiceEnrollmentBar';
// v3.10.25: shared "Test send" panel. Same hook + UI
// as wake/exit — Send lives in the global Voice mode
// section here, so its test button does too.
// v3.10.26: NAMED import, not default. The component
// is `export function ClassifierTestPanel(...)` with
// no default export. Importing as default gets
// undefined, which renders as "Element type is
// invalid: ... but got: undefined" — the crash Tobe
// hit on Settings screen open in v3.10.26.
import { ClassifierTestPanel } from '../components/ClassifierTest';
import { saveSendPhrase, loadSendModelInfo } from '../services/VoiceSettings';
import {
  getPermissions,
  setPermission,
  RemotePermissions,
  RemotePermissionKey,
} from '../services/RemoteToolPermissions';
import { version as APP_VERSION } from '../../package.json';

const SETTINGS_KEY = 'cyberclaw-mobile-settings';

type PermStatus = 'granted' | 'denied' | 'never_ask_again' | 'unknown';

// v3.7.0: voice catalog is now in src/services/VoiceCatalog.ts
// so the per-companion voice picker in CompanionSettingsScreen.tsx
// can reuse it. This screen imports the same list.
// v3.7.1: LOCAL_VOICES removed from this import. The local
// voice picker now lives in CompanionSettingsScreen (per-
// companion). This screen keeps PREMIUM_PROVIDERS because
// the 🔑 API keys section still has the global provider +
// default-voice pickers (used as fallbacks for companions
// that have no per-companion override).
import { PREMIUM_PROVIDERS } from '../services/VoiceCatalog';

export default function SettingsScreen({
  onBack,
  // v3.4.4: when the user taps a companion row in the Voice
  // mode list, the detail view is no longer inline — it gets
  // promoted to its own screen via App.tsx. App.tsx listens
  // for this callback, sets the route to 'companion', and
  // mounts <CompanionSettingsScreen companionId={id} />.
  onOpenCompanion,
}: {
  onBack: () => void;
  onOpenCompanion: (companionId: string) => void;
}) {
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
  // v3.4.7: fgThreshold/bgThreshold state + UI removed.
  // The Match Thresholds UI control was a low-level knob for
  // the v3.1 sample-matching wake detector. Since v3.1.95 we
  // use the openWakeWord TFLite ML detector, which is ~95%
  // accurate out of the box and rarely needs tuning. Tobe
  // asked to drop the UI; existing user-tuned thresholds in
  // AsyncStorage ('cyberclaw-wake-fg-threshold' / '-bg-')
  // are still read by HomeScreen/WakeModeScreen with sane
  // defaults (0.55 FG / 0.65 BG) when missing, so no
  // regression for users who never touched the threshold.
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

  // v3.7.2: voiceSilenceMs state removed. The silence
  // timeout is now per-companion, owned by each companion's
  // Voice sub-page in CompanionSettingsScreen. The
  // 'cyberclaw-voice-silence-ms' AsyncStorage key is
  // read-only fallback for v3.7.1 users (their global
  // setting becomes the default for any companion that
  // hasn't been overridden). saveSilenceMs(companionId, ms)
  // in VoiceSettings.ts writes the per-companion key.
  //
  // v3.2.20 — single exit phrase (was array). Default
  // 'thanks' matches the most common natural exit phrase
  // Tobe uses after a command. Empty string disables.
  const [voiceExitPhrase, setVoiceExitPhrase] = useState('thanks');
  const [voiceExitPhraseSavedAt, setVoiceExitPhraseSavedAt] = useState<number | null>(null);
  // v3.6.0: send word (global, single word). Default
  // 'send'. The send word is the explicit end-of-utterance
  // cue — saying it during a recording turn commits the
  // turn immediately. Empty string disables the feature.
  const [voiceSendPhrase, setVoiceSendPhrase] = useState('send');
  const [voiceSendPhraseSavedAt, setVoiceSendPhraseSavedAt] = useState<number | null>(null);
  // v3.9.8: your-turn cue sound preference. 'off' = silent
  // (default; preserves existing behavior). 'bird' / 'bell' /
  // 'ding' / 'chime' play the corresponding synthesized WAV
  // after the desktop finishes its response. State only —
  // persisted to AsyncStorage via updateVoiceTurnCue().
  const [voiceTurnCue, setVoiceTurnCue] = useState<string>('off');
  // v3.8.3: trained-model info for the active send word.
  // Mirrors the wake trainer's getSavedWakeModels badge —
  // shows the user that a .tflite is actually installed on
  // the device, when it was trained, and which file. Without
  // this the user has no way to tell whether the trainer
  // succeeded and the model is hot, since voiceSendPhrase
  // alone is just the user's typed-in string.
  const [sendModelInfo, setSendModelInfo] = useState<{ trainedAt: number; modelPath: string } | null>(null);
  // v3.8.7: reactive load of trained-model info keyed on
  // the *current* send phrase. The v3.8.4 mount-time
  // hydration ran `loadSendModelInfo(voiceSendPhrase)`
  // with the stale initial value ('send' before the
  // AsyncStorage hydrate resolved 'send magicly'), so
  // a freshly-opened Settings screen always started
  // with the gray "no model" badge even when a trained
  // .tflite for the actual phrase existed on disk.
  // This effect re-runs whenever voiceSendPhrase
  // changes (mount with the hydrated value, every
  // keystroke in the TextInput, after trainer
  // onComplete), so the badge always reflects the
  // currently-displayed phrase. No condition on
  // "is this a fresh mount" — the AsyncStorage read
  // is cheap and idempotent.
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
  // v3.6.0: send-phrase trainer modal. Mirror of
  // showExitPhraseTrainer but for the send word.
  const [showSendPhraseTrainer, setShowSendPhraseTrainer] = useState(false);
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
  // v3.4.4: selectedCompanionId / companionViewPhase
  // REMOVED — companion detail view now lives in its own
  // screen (CompanionSettingsScreen) reached via App.tsx's
  // 'companion' route. SettingsScreen keeps the wake
  // picker UI (selecting which companion's trained wake
  // word is active) but no longer renders the detail
  // view inline.
  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  // v3.4.2: `showCompanionPicker` state + the companion
  // picker Modal are REMOVED. Training lives exclusively
  // inside each companion's detail view now — no global
  // "pick which companion to train" step.

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
  // v3.7.1: voiceLocalId state removed. With per-companion
  // voice pickers in CompanionSettingsScreen, the local-voice
  // choice lives per-companion (vcLocalId in the voice sub-page).
  // The global 'cyberclaw-voice-local' AsyncStorage key is still
  // read by loadVoiceFor() as a fallback when a companion has no
  // per-companion override — we just don't surface it in this
  // screen's UI anymore.
  //
  // Premium API settings below remain global (one key, one
  // provider default, one default API voice — see the 🔑 API
  // keys section). They serve as fallbacks for per-companion
  // overrides.
  const [voiceEngine, setVoiceEngine] = useState<'local' | 'api'>('local');
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
  // Priority (deepest first):
  //   1. open trainer modal (open wake-word or exit-phrase trainer)
  //   2. companion drill-down sub-page (wake / exit) → back to overview
  //   3. companion detail overview → back to top-level Voice mode list
  //   4. top-level Voice mode → back to chat (exit Settings)
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showOwwTrainer) { setShowOwwTrainer(false); return true; }
      if (showExitPhraseTrainer) { setShowExitPhraseTrainer(false); return true; }
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack, showOwwTrainer, showExitPhraseTrainer]);

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
  // user opens a companion's detail view (so the Wake phrases
  // list reflects just-completed training). The Kotlin side
  // keeps this in SharedPreferences — the query is sync-ish
  // (single SharedPreferences read) so it's safe to fire on
  // every detail-view open.
  // v3.4.2: previously gated on companion-picker open. The
  // picker is gone; the trigger is now onOpenCompanion(id)
  // from the list row (handled by App.tsx route swap), so we just
  // refresh on mount + whenever availableCompanions grows.
  //
  // v3.10.4: same bulletproof merge as CompanionSettingsScreen.
  // Calls both `getSavedWakeModels` (active-only) and
  // `listWakeSets` (all sets), filling gaps in one with the
  // other. The Settings screen row is no longer
  // user-facing for wake info (v3.10.3 stripped the
  // "no wake yet" hint), but the per-companion
  // `WakePhrasePicker` (rendered on CompanionSettingsScreen)
  // reads its own `savedWakeModels`, so this state still
  // needs to populate correctly for picker consistency.
  // The Settings-side state remains here for any
  // forward-compat per-row wake pickers we may re-add.
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
    // v3.10.1: also refetch when the screen comes back
    // into focus via the AppState 'active' transition.
    // Tobe hit a v3.9.9-vintage symptom: the Settings
    // companion list showed "no wake word yet" even
    // though the manager (separate code path, same
    // `getSavedWakeModels` source) showed a trained
    // set. Root cause was a stale JS-side cache that
    // didn't refetch after returning from the wake
    // trainer. The useEffect with deps
    // [availableCompanions.length] doesn't fire on
    // remount if the agents cache is still warm AND
    // a fresh training was completed in another
    // route. Re-fetching on every focus brings the
    // two views back into agreement.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetch();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [availableCompanions.length]);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    checkPermissions();
    AsyncStorage.getItem('cyberclaw-bg-listening').then(v => { if (v === 'false') setBgListening(false); });
    // v3.4.7: removed fgThreshold/bgThreshold hydration.
    // Their UI was removed; AsyncStorage keys are still
    // read by HomeScreen/WakeModeScreen with sane defaults.
    AsyncStorage.getItem('cyberclaw-ready-phrase').then(v => { if (v) setReadyPhrase(v); });
    // v3.2.29: hydrate the exit reply phrase (mirror of
    // the wake greeting hydration above). Empty string
    // means "silent close" — no audio played, no log
    // spam, just drop back to passive wake listening.
    AsyncStorage.getItem('cyberclaw-exit-reply-phrase').then(v => { if (v != null) setExitReplyPhrase(v); });
    // v3.7.2: voice-silence-ms hydration removed. Silence
    // is per-companion now; CompanionSettingsScreen handles
    // per-companion hydration. The global
    // 'cyberclaw-voice-silence-ms' key is still read by
    // VoiceSettings.loadVoiceSettings() as a fallback for
    // companions without a per-companion override.
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
    // v3.8.3 → v3.8.7: hydrate the trained-model info.
    // The original (v3.8.3) version called loadSendModelInfo
    // inline here with the stale initial voiceSendPhrase
    // ('send', before AsyncStorage had a chance to hydrate
    // 'send magicly'). That meant the badge always started
    // as "no model" on a freshly-opened Settings screen.
    // v3.8.7 replaces this with a reactive
    // useEffect([voiceSendPhrase]) that re-runs whenever
    // the phrase changes (mount with hydrated value, every
    // keystroke, trainer onComplete).
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

  // v3.9.8: update the your-turn cue sound preference.
  // Single-purpose so the UI can call it from the
  // OptionBtn onPress without rebuilding the save
  // pipeline. Persists to AsyncStorage immediately (no
  // separate save button needed) so the next voice-mode
  // session picks up the new value without waiting for
  // the user to back out of Settings.
  const updateVoiceTurnCue = async (cue: string) => {
    setVoiceTurnCue(cue);
    try {
      await AsyncStorage.setItem('cyberclaw-voice-turn-cue', cue);
    } catch (_) {}
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
  // v3.7.1: setVoiceLocalIdAndSave removed. Local-voice
  // choice is now per-companion (handled in CompanionSettingsScreen
  // via saveVoiceFor). The global 'cyberclaw-voice-local'
  // AsyncStorage key is still read by loadVoiceFor() as a
  // fallback for companions with no per-companion override,
  // but we no longer write it from this screen.
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

  // v3.7.1: testLocalVoice + testDesktopVoice moved out of
  // this screen. The global Voice & Speech section is gone
  // (per-companion voice pickers in CompanionSettingsScreen
  // are now the UI for choosing voices); the Test buttons
  // live alongside those per-companion pickers. See the
  // helpers in CompanionSettingsScreen.tsx.

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
                const out: Record<string, { phrase: string; path: string; savedAt: number; displayName?: string }> = {};
                for (const agentId of Object.keys(models)) {
                  const entry = models[agentId];
                  if (entry?.phrase && entry?.path) {
                    out[agentId] = {
                      phrase: entry.phrase,
                      // v3.10.1: include displayName from
                      // the native response so the
                      // companion list row shows the
                      // human-friendly name.
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

  // v3.9.0: wake set manager. Lists every wake .tflite
  // for the active companion (and other companions the
  // user has trained), with activate / rename / delete /
  // push-to-desktop buttons. The "+ Pull from desktop"
  // button opens a sheet listing the desktop's wake-training
  // cache so a phone wipe can restore old sets.
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

  // v3.8.3: send-phrase trainer. Mirror of the exit
  // trainer but for the global send word. No companionId
  // needed — the send word is shared across all
  // companions. v3.8.3 fix: when the trainer completes
  // successfully, bump `voiceSendPhraseSavedAt` and persist
  // the trained phrase so the settings UI immediately
  // reflects "✅ Saved" — previously the trainer just
  // closed and the user had to manually re-save the
  // phrase to see the saved indicator. Also stash the
  // trained timestamp + model path in
  // getSendSamplesKey(...) so VoiceSettings can read it.
  if (showSendPhraseTrainer) {
    return (
      <SendPhraseTrainer
        presetPhrase={voiceSendPhrase || undefined}
        onCancel={() => setShowSendPhraseTrainer(false)}
        onComplete={async (ok) => {
          if (ok) {
            const trimmed = voiceSendPhrase.trim().toLowerCase();
            if (trimmed) {
              try {
                await saveSendPhrase(trimmed);
              } catch (_) {}
              setVoiceSendPhrase(trimmed);
              setVoiceSendPhraseSavedAt(Date.now());
              // v3.8.3: refresh the trained-model badge so
              // the user sees the new model + timestamp
              // immediately on returning to settings, not
              // after a screen remount.
              const info = await loadSendModelInfo(trimmed);
              if (info) setSendModelInfo(info);
            }
          }
          setShowSendPhraseTrainer(false);
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
          <Section title="🎧 Wake listening" desc="The master background-listening toggle for the wake word. Per-companion voice settings (engine, voice, silence) live in each companion's detail page.">

            {/* Master Background listening toggle. The
                grouped sub-controls below (audio buffer,
                silence timeout) only do anything when this
                is on; they configure HOW background
                listening works. v3.4.7: match thresholds
                UI removed (the TFLite ML detector doesn't
                need user tuning). */}
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

            {/* v3.4.5: the redundant "Background listening —
                details" SubTitle was removed. Now that the
                group has its own "🎧 Wake listening"
                GroupTitle above, the controls below read as
                naturally belonging to the same group without
                needing a second header. Kept the Hint.

                v3.7.2: the silence timeout was removed from
                this section. It's now per-companion, in
                each companion's Voice sub-page
                (CompanionSettingsScreen). This section is
                now just the master toggle. */}
            <Hint>When on, the app keeps the microphone active in the background and wakes on your phrase. Per-companion voice settings (engine, voice, silence) live in each companion's detail page.</Hint>

            {/* v3.6.0: send word was added here, and v3.6.2
                moved it to the bottom of the 🐾 Companions
                section. Send is per-user (one send word
                across all companions, like the wake word),
                not per-companion — but it conceptually
                belongs with the other "voice mode send
                behaviour" controls in the Companions group
                rather than with the microphone listening
                group. See the new "Send word" block inside
                the 🐾 Companions Section.

                v3.4.7: removed the Match Thresholds UI.
                The fgThreshold/bgThreshold sliders were a
                v3.1 sample-matching detector knob. Since
                v3.1.95 we use the openWakeWord TFLite ML
                detector (~95% accurate out of the box);
                Tobe confirmed the threshold UI is no longer
                needed. Existing user-tuned values in
                AsyncStorage are still respected by the
                detector (HomeScreen/WakeModeScreen read
                them directly). New users get the defaults
                (0.55 FG / 0.65 BG). */}
          </Section>

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
          <Section title="🐾 Companions" desc="Tap a companion to configure their wake phrase, exit phrase, greeting, and reply.">
            {availableCompanions.length === 0 ? (
              <View style={styles.trainedPickerHint}>
                <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
                  No companions yet. Connect to the desktop to load your companions.
                </Text>
              </View>
            ) : (
              <View style={styles.companionList}>
                {availableCompanions.map(c => {
                  // v3.10.2: removed the green active
                  // indicator from the Settings
                  // companion list row. Tobe:
                  // "clawsuu in my case is green in
                  // the settings, like its active,
                  // No need for that." The green
                  // border + name tint + ◉ dot
                  // conveyed which companion has the
                  // active wake — useful when the
                  // list also showed wake-status
                  // text, but redundant now that the
                  // status moved to the per-
                  // companion page. The list is now
                  // visually uniform across all
                  // companions; the active state is
                  // visible only by drilling into the
                  // companion's Wake Settings.
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
            {/* v3.10.24: global speaker-profile progress
                bar. The bar lives here at the top of the
                Voice mode section because it's a
                cross-companion setting (the user's voice
                is one thing, not N things). The compact
                twin appears at the top of voice-mode
                screens so the user can watch it fill as
                they talk — same colors and animation so
                they read as the same indicator. */}
            <VoiceEnrollmentBar variant="full" />
            <SubTitle>✉️ Manual send voice message</SubTitle>
            <Hint>Backup commit word for voice-mode turns. The primary trigger is silence-detection (the VAD's silence countdown) or gibberish-detection (VAD noise floor). When those miss — e.g. the silence threshold doesn't trip because the audio cuts off mid-word, or the VAD reads low noise as speech — saying this word commits the turn to the LLM by hand. Independent of the exit phrase — send keeps the conversation going, exit closes voice mode. Shared across all companions.</Hint>
            <Label>Send word</Label>
            <View style={styles.optionRow}>
              <TextInput
                value={voiceSendPhrase}
                onChangeText={(text) => {
                  setVoiceSendPhrase(text);
                  // v3.8.3: refresh the trained-model badge
                  // for the newly-typed phrase. Cheap (single
                  // AsyncStorage read) and means switching
                  // between 'send' and 'magicly' (for example)
                  // shows the right model timestamp without
                  // requiring the user to retrain or remount.
                  const trimmed = text.trim().toLowerCase();
                  if (trimmed) {
                    loadSendModelInfo(trimmed).then(info => {
                      setSendModelInfo(info);
                    });
                  } else {
                    setSendModelInfo(null);
                  }
                }}
                editable={true}
                style={[styles.input, { flex: 1 }]}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={40}
                placeholder="send"
                placeholderTextColor="#666"
              />
              <TouchableOpacity
                style={[styles.saveAudioBtn, { marginLeft: 8 }]}
                onPress={async () => {
                  const trimmed = voiceSendPhrase.trim().toLowerCase();
                  if (!trimmed) {
                    Alert.alert('Invalid', 'Send word cannot be empty. Clear it via "Clear" to disable.');
                    return;
                  }
                  await saveSendPhrase(trimmed);
                  setVoiceSendPhrase(trimmed);
                  setVoiceSendPhraseSavedAt(Date.now());
                }}
              >
                <Text style={styles.saveAudioBtnText}>
                  {voiceSendPhraseSavedAt
                    ? `✅ Saved`
                    : '💾 Save'}
                </Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.saveAudioBtn, { marginTop: 8 }]}
              onPress={() => {
                setShowSendPhraseTrainer(true);
              }}
            >
              <Text style={styles.saveAudioBtnText}>🎙️ Train send word (6 samples)</Text>
            </TouchableOpacity>

            {/* v3.8.3: trained-model status badge for the send
                word. Mirrors the wake trainer's "Listening for:
                <phrase>" badge so the user can see whether a
                model is actually installed, when it was
                trained, and which file. Critical for send —
                the user typed 'magicly' as the word, then trained
                it, then looked at settings and had no idea if
                the model was hot. With this badge, the answer is
                obvious. */}
            {sendModelInfo ? (
              <View style={styles.sendModelBadge}>
                <Text style={styles.sendModelBadgeIcon}>✓</Text>
                <View style={styles.sendModelBadgeTextWrap}>
                  <Text style={styles.sendModelBadgeText}>
                    Listening for "{voiceSendPhrase.trim().toLowerCase()}"
                  </Text>
                  <Text style={styles.sendModelBadgeMeta} numberOfLines={1}>
                    Trained {new Date(sendModelInfo.trainedAt).toLocaleString()}
                    {sendModelInfo.modelPath ? ` · ${sendModelInfo.modelPath}` : ''}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.sendModelBadge}>
                <Text style={styles.sendModelBadgeText}>
                  No trained send model yet — tap "Train send word" to record 6 samples and hot-swap one in.
                </Text>
              </View>
            )}

            {/* v3.10.25: per-page classifier test. Send
                lives in the global Voice mode section
                (shared across companions), so its test
                button sits here too. Tap "✉️ Test send",
                say the trained send word, see the peak
                score. Same shared ClassifierTestPanel
                as wake + exit. */}
            <ClassifierTestPanel kind="send" />

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

      {/* ── 🔑 API keys ─────────────────────────────────────────
          v3.6.2: lifted out of the Voice & Speech section.
          API keys are GLOBAL — one key covers the device,
          and any companion that has API voice selected
          (v3.7.0) uses the same key. The "✨ API speech"
          master toggle below gates whether the v3.7.0
          per-companion engine picker will even offer the
          "Premium API" option. Today the toggle is
          informational — the bridge that consumes the key
          on the desktop side is still pending — but the
          key is stored locally so it'll be picked up the
          moment the bridge lands. */}
      <Section title="🔑 API keys" desc="Global keys. One key covers all companions that use the matching service.">
        <SubTitle>ElevenLabs (premium TTS)</SubTitle>
        <Hint>Used for cloud TTS when a companion has Premium API voice selected. Stored locally in AsyncStorage; never leaves the device except as a request to ElevenLabs.</Hint>
        <Label>ElevenLabs API key</Label>
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
        <SubTitle>✨ API speech (master toggle)</SubTitle>
        <Toggle
          title="Enable API speech"
          sub="When on, companions can be configured to use premium API voices (v3.7.0). When off, all companions are restricted to the local Android TTS engine."
          value={voiceEngine === 'api'}
          onValueChange={(v) => setVoiceEngineAndSave(v ? 'api' : 'local')}
        />
        <SubTitle>Provider</SubTitle>
        <Hint>Which cloud TTS provider the API key above is for. (Selection is persisted today; the desktop bridge that consumes it ships with v3.7.0.)</Hint>
        <View style={styles.optionRow}>
          {PREMIUM_PROVIDERS.map(p => (
            <OptionBtn key={p.id} active={voiceApiProvider === p.id} label={p.label} onPress={() => setVoiceApiProviderAndSave(p.id)} />
          ))}
        </View>
        <Label>Default API voice</Label>
        <Hint>Used as the default voice for new companions that pick Premium API. Each companion can override this in their settings page (v3.7.0).</Hint>
        <View style={styles.optionRow}>
          {PREMIUM_PROVIDERS.find(p => p.id === voiceApiProvider)?.voices.map(v => (
            <OptionBtn key={v.id} active={voiceApiVoice === v.id} label={v.label} onPress={() => setVoiceApiVoiceAndSave(v.id)} />
          ))}
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

// v3.4.5: bigger title for major groups within a
// Section block. Used for "Listening settings" and
// "Companions" inside the Voice mode Section.
// v3.4.7: GroupTitle + GroupDivider helpers + their
// styles REMOVED. Listening settings and Companions are
// now separate Section blocks (each with its own orange
// border), so the in-Section group divider is no longer
// needed.

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
  // v3.4.5: bumped paddingTop from 16 → 50 on BOTH Android
  // and iOS. Tobe's screenshot showed the section still
  // flush against the status bar even after the first
  // bump — the device was actually an iPhone (Dynamic
  // Island in the status bar) so the iOS=10 path was
  // insufficient. 50pt clears both Android status bars
  // (~30-40dp) and iOS Dynamic Island (~30pt + safe area).
  // The old v3.1.91 header block had paddingTop:34 on
  // Android but that header was removed in v3.4.x and the
  // padding was lost on the new section-based layout.
  content: { padding: 16, paddingTop: 50 },
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
  // v3.4.7: groupTitle + groupDivider styles REMOVED.
  // Listening settings and Companions are now separate
  // Section blocks (each with its own orange border).
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
  // v3.4.3: drill-down card inside the companion
  // overview. Two cards (Wake / Exit), tap to drill in.
  // Mirrors the companionListRow styling but is a card,
  // not a list row (more vertical padding, border).
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
  phaseCardEmoji: {
    fontSize: 28,
  },
  phaseCardTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  phaseCardSub: {
    color: '#9aa0b4',
    fontSize: 12,
    marginTop: 3,
  },
  phaseCardArrow: {
    color: '#888',
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
  // v3.8.3: send-trained-model badge styles. Same shape as
  // the wake trainer's getSavedWakeModels badge but tinted
  // green for the 'trained' state and gray for 'no model'.
  // The badge sits below the "Train send word" button so the
  // user can see at a glance whether the model is installed.
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
    color: '#22c55e',
    fontSize: 18,
    fontWeight: '700',
    marginRight: 10,
  },
  sendModelBadgeTextWrap: { flex: 1 },
  sendModelBadgeText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  sendModelBadgeMeta: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
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
