/**
 * SettingsScreen — Connection, audio buffer, and always-listening settings
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Switch, Alert, Platform, PermissionsAndroid, Linking, NativeModules, BackHandler,
} from 'react-native';
const { BackgroundService } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { audioBuffer, DEFAULT_SETTINGS, AudioBufferSettings } from '../services/AudioBuffer';
import WakeWordTrainer from '../components/WakeWordTrainer';
import WakeWordTrainerV2 from '../components/WakeWordTrainerV2';
import TrainingManager from '../components/TrainingManager';
import WakePhraseMenu from '../components/WakePhraseMenu';
import TrainingDetailScreen from '../components/TrainingDetailScreen';
import WakeWordTester from '../components/WakeWordTester';

const SETTINGS_KEY = 'cyberclaw-mobile-settings';

type PermStatus = 'granted' | 'denied' | 'never_ask_again' | 'unknown';

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  // Handle Android back button
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack]);

  const [hostIp, setHostIp] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [audioSettings, setAudioSettings] = useState<AudioBufferSettings>(DEFAULT_SETTINGS);
  const [showTrainer, setShowTrainer] = useState(false);
  const [showTrainerV2, setShowTrainerV2] = useState(false);
  const [showTrainingManager, setShowTrainingManager] = useState(false);
  const [showWakePhraseMenu, setShowWakePhraseMenu] = useState(false);
  const [showTrainingDetail, setShowTrainingDetail] = useState(false);
  const [showTester, setShowTester] = useState(false);
  const [selectedWakePhrase, setSelectedWakePhrase] = useState('hey clawsuu');
  const [wakePhrase, setWakePhrase] = useState('hey clawsuu');
  const [wakeTrained, setWakeTrained] = useState(false);
  const [micPerm, setMicPerm] = useState<PermStatus>('unknown');
  const [notifPerm, setNotifPerm] = useState<PermStatus>('unknown');
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ppnPath, setPpnPath] = useState<string>('');
  const [wakeMode, setWakeMode] = useState<'vosk' | 'porcupine'>('vosk');
  const [bgListening, setBgListening] = useState(true);
  const [testVoiceIndex, setTestVoiceIndex] = useState(0);

  const availableVoices = [
    { key: 'en-US', label: 'English (US)' },
    { key: 'en-GB', label: 'English (UK)' },
  ];

  const runVoiceTest = () => {
    const phrase = 'Tobe is the coolest and most handsome man on the planet';
    const voice = availableVoices[testVoiceIndex % availableVoices.length];

    Alert.alert('Test Voice', `Testing voice: ${voice.label}`);

    const escaped = phrase.replace(/'/g, "\\'");
    const voiceScript = `
      if ('speechSynthesis' in window) {
        const allVoices = window.speechSynthesis.getVoices();
        const selected = allVoices.find(v => v.lang === '${voice.key}') || allVoices[0];
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('${escaped}');
        if (selected) u.voice = selected;
        u.rate = 0.95;
        u.pitch = 1.0;
        window.speechSynthesis.speak(u);
      }
      true;
    `;

    syncClient.sendCompanionAction({
      type: 'eval_js',
      script: voiceScript,
    });

    setTestVoiceIndex((prev) => (prev + 1) % availableVoices.length);
  };

  const checkPermissions = async () => {
    if (Platform.OS !== 'android') return;
    try {
      const mic = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      setMicPerm(mic ? 'granted' : 'denied');
      if (Platform.Version >= 33) {
        const notif = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as any);
        setNotifPerm(notif ? 'granted' : 'denied');
      } else {
        setNotifPerm('granted'); // always granted < API 33
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

  useEffect(() => {
    checkPermissions();
    AsyncStorage.getItem('cyberclaw-tts-enabled').then(v => { if (v !== null) setTtsEnabled(v === 'true'); });
    AsyncStorage.getItem('cyberclaw-ppn-path').then(v => { if (v) setPpnPath(v); });
    AsyncStorage.getItem('cyberclaw-wake-mode').then(v => { if (v === 'porcupine') setWakeMode('porcupine'); });
    AsyncStorage.getItem('cyberclaw-bg-listening').then(v => { if (v === 'false') setBgListening(false); });
    // Load saved settings
    AsyncStorage.getItem(SETTINGS_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          if (saved.audioSettings) setAudioSettings(saved.audioSettings);
        } catch {}
      }
    });

    syncClient.loadSaved().then(({ host }) => {
      if (host) setHostIp(host);
    });

    // Check if wake word was already trained
    AsyncStorage.getItem('cyberclaw-wake-samples').then(raw => {
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data.samplePaths && data.samplePaths.length >= 3) {
            setWakeTrained(true);
          }
        } catch {}
      }
    });

    // Update connection status
    const onStateChange = (data: any) => {
      const s = data.state;
      if (s === 'connected') setConnectionStatus('Connected ✓');
      else if (s === 'reconnecting') setConnectionStatus('Connected ✓');
      else if (s === 'connecting') setConnectionStatus('Connecting...');
      else if (s === 'lost') setConnectionStatus('Connection lost ✕');
      else setConnectionStatus('Disconnected');
    };
    // Set initial
    if (syncClient.connected) setConnectionStatus('Connected ✓');

    syncClient.on('state_change', onStateChange);
    syncClient.on('paired', () => {
      setConnectionStatus('Connected ✓');
      Alert.alert('Paired!', 'Mobile app is now linked to your desktop CyberClaw.');
    });
    syncClient.on('pair_failed', (msg: any) => {
      Alert.alert('Pairing Failed', msg.error || 'Wrong code or expired.');
    });

    return () => {
      syncClient.off('state_change', onStateChange);
    };
  }, []);

  const saveSettings = async () => {
    const data = { audioSettings };
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    audioBuffer.updateSettings(audioSettings);
    Alert.alert('Saved ✓', 'Settings have been saved.');
  };

  const connectToDesktop = async () => {
    const ip = hostIp.trim();
    if (!ip) {
      Alert.alert('Error', 'Enter your desktop IP address');
      return;
    }

    const log = (msg: string) => {
      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setDebugLog(prev => [...prev, `[${ts}] ${msg}`]);
    };

    // Validate IP format
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
      const hasShorthand = clean.includes('::');
      log(`IPv6 groups: ${groups.length}/8, shorthand: ${hasShorthand}`);
      if (!hasShorthand && groups.length !== 8) {
        log('❌ Invalid IPv6 (wrong group count)');
        Alert.alert('Invalid IPv6', `IPv6 needs 8 groups (got ${groups.length}).`);
        return;
      }
    }

    // Build the URL that will be used
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

  const updateAudio = (key: keyof AudioBufferSettings, value: any) => {
    setAudioSettings(prev => {
      const updated = { ...prev, [key]: value };
      return updated;
    });
  };

  // Show V2 trainer if active
  if (showTrainingDetail) {
    return (
      <TrainingDetailScreen
        phrase={selectedWakePhrase}
        onBack={() => {
          setShowTrainingDetail(false);
          setShowWakePhraseMenu(true);
        }}
        onAddTraining={() => {
          setShowTrainingDetail(false);
          setShowTrainerV2(true);
        }}
      />
    );
  }

  if (showWakePhraseMenu) {
    return (
      <WakePhraseMenu
        onSelectPhrase={(phrase) => {
          setSelectedWakePhrase(phrase);
          setShowWakePhraseMenu(false);
          setShowTrainingDetail(true);
        }}
        onClose={() => setShowWakePhraseMenu(false)}
      />
    );
  }

  if (showTrainingManager) {
    return (
      <TrainingManager
        onStartTraining={() => {
          setShowTrainingManager(false);
          setShowTrainerV2(true);
        }}
        onClose={() => setShowTrainingManager(false)}
      />
    );
  }

  if (showTrainerV2) {
    return (
      <WakeWordTrainerV2
        wakePhrase={selectedWakePhrase}
        onComplete={(success) => {
          setShowTrainerV2(false);
          setShowWakePhraseMenu(true);
          if (success) {
            Alert.alert('Success', 'Wake word trained and ready!');
          }
        }}
        onCancel={() => {
          setShowTrainerV2(false);
          setShowTrainingDetail(true);
        }}
      />
    );
  }

  // Show tester if active
  if (showTester) {
    return (
      <WakeWordTester
        phrase={wakePhrase}
        onClose={() => setShowTester(false)}
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* Connection */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🔗 Desktop Connection</Text>
        <Text style={styles.sectionDesc}>
          Connect to your desktop CyberClaw to sync your companion.
        </Text>

        <Text style={styles.label}>Desktop IP Address</Text>
        <Text style={styles.hint}>
          Same network: use local IP (Settings → 📱 Mobile Companion → Local IP){'\n'}
          Remote: use your public IP and forward port 9247 on your router
        </Text>
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
            connectionStatus.includes('Connecting') ? styles.dotYellow : styles.dotRed
          ]} />
          <Text style={styles.statusText}>{connectionStatus}</Text>
        </View>

        {/* Connection log — always visible */}
        <View style={styles.debugBox}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={{ color: '#f7931a', fontSize: 11, fontWeight: 'bold' }}>Connection Log</Text>
            {debugLog.length > 0 && (
              <TouchableOpacity onPress={() => setDebugLog([])}>
                <Text style={{ color: '#666', fontSize: 11 }}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
          {debugLog.length === 0 ? (
            <Text style={[styles.debugLine, { color: '#444' }]}>No connection attempts yet</Text>
          ) : (
            debugLog.map((line, i) => (
              <Text key={i} style={styles.debugLine}>{line}</Text>
            ))
          )}
        </View>

        {syncClient.connected && !syncClient.authenticated && (
          <View style={styles.pairingSection}>
            <Text style={styles.label}>Pairing Code (from desktop)</Text>
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
            <Text style={styles.hint}>
              On your desktop CyberClaw, go to Settings → Mobile → Generate Pairing Code
            </Text>
          </View>
        )}
      </View>

      {/* Permissions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🔒 Permissions</Text>
        <Text style={styles.sectionDesc}>These permissions are required for voice and background features.</Text>
        {[
          { label: 'Microphone', status: micPerm, perm: 'android.permission.RECORD_AUDIO', desc: 'Required for voice chat and wake word detection' },
          { label: 'Notifications', status: notifPerm, perm: 'android.permission.POST_NOTIFICATIONS', desc: 'Required for background service indicator' },
        ].map(({ label, status, perm, desc }) => (
          <View key={label} style={styles.permRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.permLabel}>
                {status === 'granted' ? '✅' : '❌'} {label}
              </Text>
              <Text style={styles.permDesc}>{desc}</Text>
            </View>
            {status !== 'granted' && (
              <TouchableOpacity style={styles.permBtn} onPress={() => requestPermission(perm)}>
                <Text style={styles.permBtnText}>Grant</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>

      {/* TTS */}
      {/* Voice Response - Always Enabled (no toggle needed) */}

      {/* Always Listening */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🎙️ Always Listening</Text>
        <Text style={styles.sectionDesc}>
          Keep the microphone active in the background. Your companion wakes up when you say the wake word.
        </Text>

        {/* Single toggle for background listening */}
        <View style={styles.toggleRow}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>🎧 Background Listening</Text>
            <Text style={styles.toggleSub}>Keep microphone active in background - wake on phrase</Text>
          </View>
          <Switch
            value={bgListening}
            onValueChange={async (val) => {
              setBgListening(val);
              await AsyncStorage.setItem('cyberclaw-bg-listening', String(val));
              if (val) {
                try { await BackgroundService?.start?.(); } catch {}
                Alert.alert('✅ Enabled', 'Background listening is on. App will wake on your phrase.');
              } else {
                try { await BackgroundService?.stop?.(); } catch {}
                Alert.alert('🔕 Disabled', 'Background listening is off.');
              }
            }}
            trackColor={{ false: '#333', true: '#f7931a' }}
            thumbColor={bgListening ? '#fff' : '#666'}
          />
        </View>


        {/* DEPRECATED: Old trainer - use V2 below instead */}
        {/* 
        <TouchableOpacity
          style={[styles.trainBtn, wakeTrained && styles.trainBtnDone]}
          onPress={() => setShowTrainer(!showTrainer)}
        >
          <Text style={styles.trainBtnText}>
            {wakeTrained ? '✅ Wake phrase trained' : '🎤 Train wake phrase'}
          </Text>
          <Text style={styles.trainBtnSub}>
            {wakeTrained ? 'Tap to retrain' : 'Record 3 voice samples'}
          </Text>
        </TouchableOpacity>
        */}

        {/* V2 Trainer with Quality Feedback */}
        <TouchableOpacity
          style={[styles.trainBtn, { marginTop: 8, borderColor: '#10b981' }]}
          onPress={() => setShowWakePhraseMenu(true)}
        >
          <Text style={[styles.trainBtnText, { color: '#10b981' }]}>
            🎤 Wake Training
          </Text>
        </TouchableOpacity>


        {/* Test Wake Word Button */}
        <TouchableOpacity
          style={[styles.button, { marginTop: 12, backgroundColor: 'rgba(16, 185, 129, 0.2)', borderColor: '#10b981', borderWidth: 1 }]}
          onPress={() => setShowTester(true)}
        >
          <Text style={[styles.buttonText, { color: '#10b981' }]}>🎤 Test Wake Detection</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>
          Listen in real-time to see what the app hears. Helps debug wake word recognition.
        </Text>


        <Text style={styles.label}>Audio Lookback (minutes)</Text>
        <View style={styles.optionRow}>
          {[5, 10, 30, 60].map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.optionBtn, audioSettings.lookbackMinutes === m && styles.optionActive]}
              onPress={() => updateAudio('lookbackMinutes', m)}
            >
              <Text style={[styles.optionText, audioSettings.lookbackMinutes === m && styles.optionTextActive]}>
                {m}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          How many minutes of audio to keep in the rolling buffer. When you say the wake word, 
          this context is transcribed and sent to your companion.
        </Text>

        <Text style={styles.label}>Conversation Timeout (minutes)</Text>
        <View style={styles.optionRow}>
          {[1, 2, 5].map(m => (
            <TouchableOpacity
              key={m}
              style={[styles.optionBtn, audioSettings.conversationTimeoutMinutes === m && styles.optionActive]}
              onPress={() => updateAudio('conversationTimeoutMinutes', m)}
            >
              <Text style={[styles.optionText, audioSettings.conversationTimeoutMinutes === m && styles.optionTextActive]}>
                {m}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          After this many minutes of silence, the companion stops actively listening 
          and returns to passive wake word detection.
        </Text>

        <Text style={styles.label}>Recording Retention (days)</Text>
        <View style={styles.optionRow}>
          {[1, 7, 14, 30].map(d => (
            <TouchableOpacity
              key={d}
              style={[styles.optionBtn, audioSettings.retentionDays === d && styles.optionActive]}
              onPress={() => updateAudio('retentionDays', d)}
            >
              <Text style={[styles.optionText, audioSettings.retentionDays === d && styles.optionTextActive]}>
                {d}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>
          Daily audio logs are kept locally for this many days, then auto-deleted.
        </Text>
      </View>

      {/* Save */}
      <TouchableOpacity style={[styles.button, styles.saveButton]} onPress={saveSettings}>
        <Text style={styles.buttonText}>Save Settings</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingTop: Platform.OS === 'android' ? 34 : 10,
  },
  backBtn: { color: '#f7931a', fontSize: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginLeft: 16 },
  section: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#222',
  },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  permRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#1a1a2e' },
  permLabel: { color: '#ddd', fontSize: 14, fontWeight: 'bold' },
  permDesc: { color: '#777', fontSize: 11, marginTop: 2 },
  permBtn: { backgroundColor: '#f7931a', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  permBtnText: { color: '#000', fontSize: 12, fontWeight: 'bold' },
  sectionDesc: { color: '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  label: { color: '#ccc', fontSize: 14, marginBottom: 6, marginTop: 12 },
  input: {
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  button: {
    backgroundColor: '#f7931a',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  buttonConnected: { backgroundColor: '#333', borderWidth: 1, borderColor: '#4ade80' },
  buttonTextConnected: { color: '#4ade80' },
  saveButton: { marginTop: 8, backgroundColor: '#22c55e' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  dotGreen: { backgroundColor: '#4ade80' },
  dotYellow: { backgroundColor: '#eab308' },
  dotRed: { backgroundColor: '#666' },
  statusText: { color: '#ccc', fontSize: 14 },
  pairingSection: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#222' },
  hint: { color: '#666', fontSize: 12, marginTop: 6, lineHeight: 16 },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  switchLabel: { color: '#ccc', fontSize: 15 },
  optionRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  optionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
  },
  optionActive: {
    backgroundColor: 'rgba(247,147,26,0.2)',
    borderColor: '#f7931a',
  },
  optionText: { color: '#888', fontSize: 14 },
  optionTextActive: { color: '#f7931a', fontWeight: 'bold' },
  debugBox: {
    backgroundColor: '#0a0a1a',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#222',
  },
  debugLine: {
    color: '#8a8',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  trainBtn: {
    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#f7931a',
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  trainBtnDone: {
    borderColor: '#22c55e',
    borderStyle: 'solid',
  },
  trainBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  trainBtnSub: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#111', borderRadius: 10, padding: 12, marginBottom: 12,
    borderWidth: 1, borderColor: '#222',
  },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleTitle: { color: '#eee', fontSize: 14, fontWeight: '600' },
  toggleSub: { color: '#666', fontSize: 12, marginTop: 2 },
  porcupineBox: {    backgroundColor: '#1a1a2e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  porcupineTitle: {
    color: '#f7931a',
    fontSize: 15,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  porcupineSub: {
    color: '#aaa',
    fontSize: 12,
    marginBottom: 10,
  },
  porcupineSteps: {
    color: '#888',
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 10,
    lineHeight: 18,
  },
  guideBtn: {
    backgroundColor: '#0d47a1',
    borderRadius: 6,
    padding: 8,
    marginBottom: 10,
    alignItems: 'center',
  },
  guideBtnText: {
    color: '#64b5f6',
    fontSize: 13,
    fontWeight: '600',
  },
  modeToggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  modeBtn: {
    flex: 1,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#444',
    alignItems: 'center',
  },
  modeBtnActive: {
    borderColor: '#f7931a',
    backgroundColor: '#2a1a00',
  },
  modeBtnText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
  },
  modeBtnTextActive: {
    color: '#f7931a',
  },
});
