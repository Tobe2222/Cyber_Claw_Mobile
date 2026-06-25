/**
 * SettingsScreen — Mobile companion settings
 *
 * v3.1.13: Reorganized into 5 clear categories, voice settings restored,
 * and dead state removed.
 *
 * Sections (top to bottom):
 *   1. 🔗 Connection       — Desktop IP, connect, status, log, pairing
 *   2. 🔒 Permissions      — Runtime perms (mic/notif) + wake perms
 *   3. 🎤 Wake Word        — Background listening, threshold, training,
 *                            wake greeting, audio buffer settings
 *   4. 🔊 Voice & Speech   — Local TTS (free) + Premium API placeholder
 *   5. 🤖 Agent Reach      — Remote permissions (file/app/location/camera)
 *
 * Each section is a self-contained card with a title, optional
 * description, and a list of controls. Most settings auto-save; the
 * audio buffer settings (lookback/timeout/retention) are batched into
 * a "Save Audio Settings" button.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Switch, Alert, Platform, PermissionsAndroid, Linking, NativeModules, BackHandler,
  Modal, Pressable,
} from 'react-native';
const { BackgroundService, WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { audioBuffer, DEFAULT_SETTINGS, AudioBufferSettings } from '../services/AudioBuffer';

import WakePhraseMenu from '../components/WakePhraseMenu';
import TrainingDetailScreen from '../components/TrainingDetailScreen';
import WakeWordTester from '../components/WakeWordTester';
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
  const [audioSettings, setAudioSettings] = useState<AudioBufferSettings>(DEFAULT_SETTINGS);
  const [audioSettingsSavedAt, setAudioSettingsSavedAt] = useState<number | null>(null);

  // Wake training sub-screens (full-screen modals)
  
  const [showWakePhraseMenu, setShowWakePhraseMenu] = useState(false);
  const [showTrainingDetail, setShowTrainingDetail] = useState(false);
  const [showTester, setShowTester] = useState(false);
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
  const [selectedWakePhrase, setSelectedWakePhrase] = useState('hey clawsuu');

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
      if (showTrainingDetail) { setShowTrainingDetail(false); setShowWakePhraseMenu(true); return true; }
      if (showWakePhraseMenu) { setShowWakePhraseMenu(false); return true; }
      if (showTester) { setShowTester(false); return true; }
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack, showTrainingDetail, showWakePhraseMenu, showTester]);

  // Clear pending debounce on unmount
  useEffect(() => () => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
  }, []);

  // ── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    checkPermissions();
    AsyncStorage.getItem('cyberclaw-bg-listening').then(v => { if (v === 'false') setBgListening(false); });
    AsyncStorage.getItem('cyberclaw-wake-bg-threshold').then(v => { if (v) setBgThreshold(Math.round(parseFloat(v) * 100)); });
    AsyncStorage.getItem('cyberclaw-wake-fg-threshold').then(v => { if (v) setFgThreshold(Math.round(parseFloat(v) * 100)); });
    AsyncStorage.getItem('cyberclaw-ready-phrase').then(v => { if (v) setReadyPhrase(v); });
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

  // v3.1.77: TrainingDetailScreen now handles per-phrase
  // style-tagged sample capture internally (it mounts
  // SampleTrainer for each style row). The previous
  // onAddTraining → setShowTrainerV2 path is gone — the
  // recording happens inside the detail screen.
  if (showTrainingDetail) {
    return (
      <TrainingDetailScreen
        companionId={trainingCompanionId || 'unknown'}
        companionName={trainingCompanionName || 'Companion'}
        phrase={selectedWakePhrase}
        onBack={() => { setShowTrainingDetail(false); setShowWakePhraseMenu(true); }}
      />
    );
  }
  if (showWakePhraseMenu) {
    return (
      <WakePhraseMenu
        companionId={trainingCompanionId || 'unknown'}
        companionName={trainingCompanionName || 'Companion'}
        onSelectPhrase={(phrase) => {
          setSelectedWakePhrase(phrase);
          setShowWakePhraseMenu(false);
          setShowTrainingDetail(true);
        }}
        onClose={() => setShowWakePhraseMenu(false)}
      />
    );
  }
  if (showTester) {
    return (
      <WakeWordTester
        phrase={selectedWakePhrase}
        onClose={() => setShowTester(false)}
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

      {/* ── 🎤 Wake Word ─────────────────────────────────────── */}
      <Section title="🎤 Wake Word" desc="Train and tune the wake phrase that wakes your companion in the background.">
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

        {/* v3.1.49: foreground threshold (was previously hardcoded to 55%).
            Adjustable so the user can tighten wake detection without
            retraining. */}
        <Label>Foreground match threshold: {fgThreshold}%</Label>
        <Hint>Minimum match score to trigger the wake word when the app is in the foreground. Higher = stricter.</Hint>
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

        <Label>Background match threshold: {bgThreshold}%</Label>
        <Hint>Minimum match score to trigger the wake word in the background. Higher = stricter.</Hint>
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

        <SubTitle>Training</SubTitle>
        <TouchableOpacity style={styles.trainBtn} onPress={() => {
          // v3.1.67: open the companion picker first (each
          // companion has its own wake word). After the
          // user picks a companion, show the trainer.
          // v3.1.68: replaced the native Alert with a proper
          // modal sheet (CompanionPickerModal) that shows each
          // companion with its sprite icon.
          if (availableCompanions.length === 0) {
            Alert.alert(
              'No companions yet',
              'Connect to the desktop and load at least one companion before training the wake word.',
            );
            return;
          }
          if (availableCompanions.length === 1) {
            // Only one companion — skip the picker and go straight
            // to that companion's Wake Phrases menu.
            setTrainingCompanionId(availableCompanions[0].id);
            setTrainingCompanionName(availableCompanions[0].name);
            setShowWakePhraseMenu(true);
            return;
          }
          // Multiple companions — open the custom modal picker.
          setShowCompanionPicker(true);
        }}>
          <Text style={[styles.trainBtnText, { color: '#10b981' }]}>🎤 Wake training</Text>
          <Text style={styles.trainBtnSub}>
            {trainingCompanionId
              ? `Train ${trainingCompanionName}'s wake phrase(s) — Normal / Loud / Whisper / Short / Elongated`
              : 'Loading companions…'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.trainBtn, { borderColor: '#10b981' }]} onPress={() => setShowTester(true)}>
          <Text style={[styles.trainBtnText, { color: '#10b981' }]}>🎤 Test wake detection</Text>
          <Text style={styles.trainBtnSub}>Listen in real-time to see what the app hears</Text>
        </TouchableOpacity>

        <SubTitle>Wake greeting</SubTitle>
        <Hint>Phrase spoken when the wake word is detected. Auto-saves as you type.</Hint>
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
      </Section>

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
                  // v3.1.76: take the user to the Wake Phrases menu
                  // first (a per-companion list of trained phrases),
                  // not directly into the recording screen. The user
                  // can then see what's already trained, add a new
                  // phrase, or pick an existing phrase to add more
                  // samples to. The recording screen is one click
                  // away from there. The previous flow skipped the
                  // "what phrases are trained?" context and dropped
                  // the user straight into recording a default
                  // phrase.
                  setShowWakePhraseMenu(true);
                }}
              >
                <Text style={styles.pickerRowIcon}>{c.emoji || c.icon || '🐾'}</Text>
                <Text style={styles.pickerRowName} numberOfLines={1}>{c.name}</Text>
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
