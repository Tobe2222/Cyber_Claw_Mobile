/**
 * ArenaSettingsScreen — Companion arena appearance and TTS voice
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Alert,
  Switch, SafeAreaView, BackHandler, TextInput,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
import { addLogEntry } from './HomeScreen';

interface ArenaSettingsScreenProps {
  onBack: () => void;
}

// Match desktop background IDs exactly
const BG_OPTIONS = [
  { id: 'meadow', label: '🌞 Summer Meadow' },
  { id: 'grove', label: '🌲 Forest Edge' },
  { id: 'forest', label: '🌙 Dark Forest' },
];

const COMPANION_OPTIONS = [
  { id: 'fox', label: '🦊 Fox' },
  { id: 'boar', label: '🐗 Boar' },
  { id: 'deer', label: '🦌 Deer' },
  { id: 'hare', label: '🐰 Hare' },
  { id: 'black_grouse', label: '🐦 Black Grouse' },
];

// Local Android voices (free) - will be fetched from device
const LOCAL_VOICES_DEFAULTS = [
  { id: 'default', label: '🎙️ System Default' },
  { id: 'female', label: '👩 Female' },
  { id: 'male', label: '👨 Male' },
];

// This will be populated from device voices
let AVAILABLE_DEVICE_VOICES: Array<{ id: string; label: string }> = LOCAL_VOICES_DEFAULTS;

// 3rd party API voices (paid)
const THIRTHPARTY_APIS = [
  { id: 'elevenlabs', label: 'ElevenLabs', voices: [
    { id: 'nova', label: '✨ Nova (Female - Bright)' },
    { id: 'alloy', label: '🎙️ Alloy (Male - Friendly)' },
    { id: 'echo', label: '🌊 Echo (Male - Deep)' },
    { id: 'fable', label: '📖 Fable (Female - Storyteller)' },
    { id: 'onyx', label: '⚫ Onyx (Male - Smooth)' },
    { id: 'shimmer', label: '✨ Shimmer (Female - Warm)' },
  ]},
  { id: 'google', label: 'Google Cloud TTS', voices: [
    { id: 'en-US-Neural2-A', label: '🗣️ A (Female)' },
    { id: 'en-US-Neural2-C', label: '🗣️ C (Female)' },
    { id: 'en-US-Neural2-E', label: '🗣️ E (Male)' },
  ]},
];

export default function ArenaSettingsScreen({ onBack }: ArenaSettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const [bgId, setBgId] = useState('forest');
  const [companionId, setCompanionId] = useState('boar');
  
  // Voice settings
  const [useLocalVoice, setUseLocalVoice] = useState(true);
  const [localVoice, setLocalVoice] = useState('default');
  const [apiProvider, setApiProvider] = useState('elevenlabs');
  const [apiKey, setApiKey] = useState('');
  const [apiVoice, setApiVoice] = useState('nova');
  const [deviceVoices, setDeviceVoices] = useState(LOCAL_VOICES_DEFAULTS);

  // Device voices are now: default, male, female
  // Queried from device TTS capabilities
  useEffect(() => {
    // Set available voices based on Android capabilities
    const voices = [
      { id: 'default', label: '🎙️ System Default' },
      { id: 'male', label: '👨 Male Voice' },
      { id: 'female', label: '👩 Female Voice' },
    ];
    setDeviceVoices(voices);
    AVAILABLE_DEVICE_VOICES = voices;
  }, []);

  // Handle Android back button
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => backHandler.remove();
  }, [onBack]);

  useEffect(() => {
    // Load saved settings on mount
    const loadSettings = async () => {
      const bg = await AsyncStorage.getItem('cyberclaw-arena-bg');
      if (bg) setBgId(bg);
      
      const comp = await AsyncStorage.getItem('cyberclaw-arena-comp');
      if (comp) setCompanionId(comp);
      
      const useLocal = await AsyncStorage.getItem('cyberclaw-voice-local');
      if (useLocal !== null) setUseLocalVoice(useLocal === 'true');
      
      const local = await AsyncStorage.getItem('cyberclaw-voice-local-id');
      if (local) setLocalVoice(local);
      
      const api = await AsyncStorage.getItem('cyberclaw-voice-api-provider');
      if (api) setApiProvider(api);
      
      const key = await AsyncStorage.getItem('cyberclaw-voice-api-key');
      if (key) setApiKey(key);
      
      const voice = await AsyncStorage.getItem('cyberclaw-voice-api-voice');
      if (voice) setApiVoice(voice);
    };
    loadSettings();
  }, []);

  const saveBg = (id: string) => {
    try {
      setBgId(id);
      AsyncStorage.setItem('cyberclaw-arena-bg', id).catch(() => {});
    } catch (e) {
      // Silently fail
    }
  };

  const saveCompanion = async (id: string) => {
    try {
      try { addLogEntry('📱 → 🖥️ Requesting companion change to ' + id + ' on desktop', 'info'); } catch {}
      syncClient.setCompanionId(id);
      setCompanionId(id);
      await AsyncStorage.setItem('cyberclaw-arena-comp', id);
      try { addLogEntry('✅ Companion saved and sent to desktop', 'info'); } catch {}
    } catch (e) {
      try { addLogEntry('❌ Error changing companion: ' + String(e), 'error'); } catch {}
    }
  };

  const toggleVoiceMode = async (local: boolean) => {
    try {
      setUseLocalVoice(local);
      await AsyncStorage.setItem('cyberclaw-voice-local', local.toString());
      try { addLogEntry(`🎤 Voice: ${local ? 'Local (Free)' : 'API (Premium)'}`, 'info'); } catch {}
    } catch (e) {
      try { addLogEntry('❌ Error: ' + String(e), 'error'); } catch {}
    }
  };

  const saveLocalVoice = async (voice: string) => {
    try {
      setLocalVoice(voice);
      await AsyncStorage.setItem('cyberclaw-voice-local-id', voice);
    } catch (e) {}
  };

  const saveApiProvider = async (provider: string) => {
    try {
      setApiProvider(provider);
      await AsyncStorage.setItem('cyberclaw-voice-api-provider', provider);
      // Reset voice to first available for this provider
      const firstVoice = THIRTHPARTY_APIS.find(p => p.id === provider)?.voices[0].id;
      if (firstVoice) {
        setApiVoice(firstVoice);
        await AsyncStorage.setItem('cyberclaw-voice-api-voice', firstVoice);
      }
    } catch (e) {}
  };

  const saveApiVoice = async (voice: string) => {
    try {
      setApiVoice(voice);
      await AsyncStorage.setItem('cyberclaw-voice-api-voice', voice);
    } catch (e) {}
  };

  const saveApiKey = async (key: string) => {
    try {
      setApiKey(key);
      await AsyncStorage.setItem('cyberclaw-voice-api-key', key);
    } catch (e) {}
  };



  const testApiVoice = () => {
    if (!apiKey.trim()) {
      Alert.alert('⚠️ Missing API Key', 'Please enter your API key first.');
      return;
    }
    const testPhrase = "Toby is worlds most handsome wizard";
    const providerName = THIRTHPARTY_APIS.find(p => p.id === apiProvider)?.label;
    Alert.alert(
      '🔊 API Voice Test',
      `Provider: ${providerName}\nVoice: "${apiVoice}"\n\n"${testPhrase}"\n\nWill call API to synthesize.`,
      [{ text: 'OK' }]
    );
  };

  const apiConfig = THIRTHPARTY_APIS.find(p => p.id === apiProvider);

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, { marginTop: insets.top * 0.5 }]}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.backButton}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>🎮 Arena Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Background Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🖼️ Background</Text>
          <View style={styles.optionGrid}>
            {BG_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                style={[styles.optionBtn, bgId === opt.id && styles.optionBtnActive]}
                onPress={() => saveBg(opt.id)}
              >
                <Text style={[styles.optionText, bgId === opt.id && styles.optionTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Companion Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🐾 Companion</Text>
          <View style={styles.optionGrid}>
            {COMPANION_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                activeOpacity={0.6}
                style={[styles.optionBtn, companionId === opt.id && styles.optionBtnActive]}
                onPress={() => {
                  Alert.alert('Companion', `Switching to ${opt.label}...`);
                  saveCompanion(opt.id);
                }}
              >
                <Text style={[styles.optionText, companionId === opt.id && styles.optionTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Voice Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🎤 Voice Settings</Text>
          
          {/* Toggle */}
          <View style={styles.toggleRow}>
            <View>
              <Text style={styles.toggleLabel}>Free Local Voice</Text>
              <Text style={styles.toggleDesc}>Uses device TTS</Text>
            </View>
            <Switch
              value={useLocalVoice}
              onValueChange={toggleVoiceMode}
              trackColor={{ false: '#333', true: '#f7931a' }}
              thumbColor={useLocalVoice ? '#0a0a2e' : '#999'}
            />
            <View>
              <Text style={styles.toggleLabel}>Premium API</Text>
              <Text style={styles.toggleDesc}>High quality voices</Text>
            </View>
          </View>

          {/* Local Voice Settings */}
          {useLocalVoice ? (
            <View style={styles.settingsPanel}>
              <Text style={styles.label}>Local Voice Selection</Text>
              <View style={styles.picker}>
                <Picker
                  selectedValue={localVoice}
                  onValueChange={saveLocalVoice}
                  style={styles.pickerElement}
                  itemStyle={styles.pickerItem}
                >
                  {deviceVoices.map(v => (
                    <Picker.Item key={v.id} label={v.label} value={v.id} />
                  ))}
                </Picker>
              </View>
              <Text style={styles.description}>
                ✅ Free • Uses Android native TTS • Low latency
              </Text>
            </View>
          ) : (
            <View style={styles.settingsPanel}>
              <Text style={styles.label}>API Provider</Text>
              <View style={styles.picker}>
                <Picker
                  selectedValue={apiProvider}
                  onValueChange={saveApiProvider}
                  style={styles.pickerElement}
                  itemStyle={styles.pickerItem}
                >
                  {THIRTHPARTY_APIS.map(p => (
                    <Picker.Item key={p.id} label={p.label} value={p.id} />
                  ))}
                </Picker>
              </View>

              <Text style={styles.label}>API Key</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter your API key"
                placeholderTextColor="#666"
                value={apiKey}
                onChangeText={saveApiKey}
                secureTextEntry={true}
              />

              <Text style={styles.label}>Voice</Text>
              <View style={styles.picker}>
                <Picker
                  selectedValue={apiVoice}
                  onValueChange={saveApiVoice}
                  style={styles.pickerElement}
                  itemStyle={styles.pickerItem}
                >
                  {apiConfig?.voices.map(v => (
                    <Picker.Item key={v.id} label={v.label} value={v.id} />
                  ))}
                </Picker>
              </View>

              <TouchableOpacity style={styles.testBtn} onPress={testApiVoice}>
                <Text style={styles.testBtnText}>🔊 Test API Voice</Text>
              </TouchableOpacity>
              <Text style={styles.description}>
                💰 Paid • High quality • Network required
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a2e',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#0d0d1f',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  backButton: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: '600',
  },
  title: {
    color: '#f7931a',
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionBtn: {
    flex: 1,
    minWidth: '48%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  optionBtnActive: {
    backgroundColor: 'rgba(247,147,26,0.2)',
    borderColor: '#f7931a',
  },
  optionText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  optionTextActive: {
    color: '#f7931a',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 12,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    marginBottom: 16,
  },
  toggleLabel: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '700',
  },
  toggleDesc: {
    color: '#888',
    fontSize: 11,
    marginTop: 2,
  },
  settingsPanel: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 12,
  },
  label: {
    color: '#f7931a',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    marginTop: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  picker: {
    backgroundColor: '#0d0d1f',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 6,
    overflow: 'hidden',
  },
  pickerElement: {
    color: '#f7931a',
    backgroundColor: '#0d0d1f',
  },
  pickerItem: {
    color: '#f7931a',
    fontSize: 14,
  },
  input: {
    backgroundColor: '#0d0d1f',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f7931a',
    fontSize: 14,
    marginBottom: 8,
  },
  testBtn: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(247,147,26,0.15)',
    borderWidth: 1,
    borderColor: '#f7931a',
    borderRadius: 6,
    alignItems: 'center',
  },
  testBtnText: {
    color: '#f7931a',
    fontSize: 14,
    fontWeight: '600',
  },
  description: {
    color: '#888',
    fontSize: 12,
    marginTop: 12,
    fontStyle: 'italic',
  },
});
