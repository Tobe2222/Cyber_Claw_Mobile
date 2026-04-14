/**
 * SettingsScreen — Connection, audio buffer, and always-listening settings
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { audioBuffer, DEFAULT_SETTINGS, AudioBufferSettings } from '../services/AudioBuffer';
import WakeWordTrainer from '../components/WakeWordTrainer';

const SETTINGS_KEY = 'cyberclaw-mobile-settings';

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [hostIp, setHostIp] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [audioSettings, setAudioSettings] = useState<AudioBufferSettings>(DEFAULT_SETTINGS);
  const [showTrainer, setShowTrainer] = useState(false);
  const [wakeTrained, setWakeTrained] = useState(false);

  useEffect(() => {
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
    const updateStatus = () => {
      if (syncClient.authenticated) setConnectionStatus('Connected ✓');
      else if (syncClient.connected) setConnectionStatus('Connected, not paired');
      else setConnectionStatus('Disconnected');
    };
    updateStatus();

    syncClient.on('connected', updateStatus);
    syncClient.on('disconnected', updateStatus);
    syncClient.on('authenticated', updateStatus);
    syncClient.on('paired', () => {
      updateStatus();
      Alert.alert('Paired!', 'Mobile app is now linked to your desktop CyberClaw.');
    });
    syncClient.on('pair_failed', (msg: any) => {
      Alert.alert('Pairing Failed', msg.error || 'Wrong code or expired.');
    });

    return () => {
      syncClient.off('connected', updateStatus);
      syncClient.off('disconnected', updateStatus);
      syncClient.off('authenticated', updateStatus);
    };
  }, []);

  const saveSettings = async () => {
    const data = { audioSettings };
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    audioBuffer.updateSettings(audioSettings);
  };

  const connectToDesktop = async () => {
    if (!hostIp.trim()) {
      Alert.alert('Error', 'Enter your desktop IP address');
      return;
    }
    try {
      setConnectionStatus('Connecting...');
      await syncClient.connect(hostIp.trim());
    } catch (e: any) {
      setConnectionStatus('Failed to connect');
      Alert.alert('Connection Failed', 'Check the IP and make sure CyberClaw is running on your desktop.');
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
        <TouchableOpacity style={styles.button} onPress={connectToDesktop}>
          <Text style={styles.buttonText}>Connect</Text>
        </TouchableOpacity>

        <View style={styles.statusRow}>
          <View style={[styles.statusDot, 
            connectionStatus.includes('✓') ? styles.dotGreen : 
            connectionStatus.includes('Connecting') ? styles.dotYellow : styles.dotRed
          ]} />
          <Text style={styles.statusText}>{connectionStatus}</Text>
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

      {/* Always Listening */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🎙️ Always Listening</Text>
        <Text style={styles.sectionDesc}>
          Keep the microphone active in the background. Your companion wakes up when you say the wake word.
        </Text>

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Enable Always Listening</Text>
          <Switch
            value={audioSettings.enabled}
            onValueChange={v => updateAudio('enabled', v)}
            trackColor={{ false: '#333', true: '#f7931a' }}
            thumbColor={audioSettings.enabled ? '#fff' : '#666'}
          />
        </View>

        <Text style={styles.label}>Wake Word</Text>
        <TextInput
          style={styles.input}
          value={audioSettings.wakeWord}
          onChangeText={v => { updateAudio('wakeWord', v); setWakeTrained(false); }}
          placeholder="Hey CyberClaw"
          placeholderTextColor="#555"
        />

        {/* Train wake phrase button */}
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

        {showTrainer && (
          <WakeWordTrainer
            wakePhrase={audioSettings.wakeWord}
            onComplete={(paths) => {
              setWakeTrained(true);
              setShowTrainer(false);
              Alert.alert('Done!', `Wake phrase "${audioSettings.wakeWord}" trained with ${paths.length} samples.`);
            }}
          />
        )}

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
    paddingTop: 10,
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
});
