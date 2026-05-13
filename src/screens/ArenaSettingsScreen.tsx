/**
 * ArenaSettingsScreen — Companion arena appearance and TTS voice
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Alert,
  Switch, SafeAreaView, BackHandler,
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

const COMPANION_VOICE_OPTIONS = [
  // Male voices
  { id: 'lessac', label: '🎙️ Lessac (Male - Deep, Authoritative)', gender: 'male' },
  { id: 'ryan', label: '👨 Ryan (Male - Young, Friendly)', gender: 'male' },
  { id: 'adam', label: '🧑 Adam (Male - Calm, Gentle)', gender: 'male' },
  { id: 'arnold', label: '💪 Arnold (Male - Deep, Bold)', gender: 'male' },
  { id: 'brian', label: '👔 Brian (Male - Warm, Thoughtful)', gender: 'male' },
  // Female voices
  { id: 'glow-tts', label: '👩 Glow-TTS (Female - Warm, Curious)', gender: 'female' },
  { id: 'nova', label: '✨ Nova (Female - Bright, Energetic)', gender: 'female' },
  { id: 'sage', label: '🧙 Sage (Female - Wise, Reflective)', gender: 'female' },
];

export default function ArenaSettingsScreen({ onBack }: ArenaSettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const [bgId, setBgId] = useState('forest');
  const [companionId, setCompanionId] = useState('boar');
  const [ttsVoice, setTtsVoice] = useState('lessac');
  const [companionVoice, setCompanionVoice] = useState('lessac');

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
      
      const tts = await AsyncStorage.getItem('cyberclaw-tts-voice');
      if (tts) setTtsVoice(tts);
      
      const voice = await AsyncStorage.getItem('cyberclaw-companion-voice');
      if (voice) setCompanionVoice(voice);
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
      // Send to desktop - it will handle the change and broadcast back
      syncClient.setCompanionId(id);
      // Update local UI immediately for responsiveness
      setCompanionId(id);
      // Save to AsyncStorage so settings screen stays in sync
      await AsyncStorage.setItem('cyberclaw-arena-comp', id);
      try { addLogEntry('✅ Companion saved and sent to desktop', 'info'); } catch {}
    } catch (e) {
      try { addLogEntry('❌ Error changing companion: ' + String(e), 'error'); } catch {}
    }
  };


  const saveCompanionVoice = (id: string) => {
    setCompanionVoice(id);
    AsyncStorage.setItem('cyberclaw-companion-voice', id);
  };

  const playTestVoice = (voiceId: string) => {
    // Mobile voice settings are saved and used when Clawsuu responds
    // The actual voice played depends on your device OS (Android/iOS system voice)
    const testPhrase = "Toby is worlds most handsome wizard";
    
    Alert.alert(
      'Voice Settings Saved ✅',
      `Voice: "${voiceId}"\n\nWhen Clawsuu responds, this phrase will play:\n\n"${testPhrase}"\n\nThe actual voice used is your device's native voice (set in system settings).`,
      [{ text: 'OK' }]
    );
  };


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
                  console.log('Button pressed for:', opt.id, 'Current:', companionId);
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
          <Text style={styles.sectionTitle}>🎤 Voice</Text>
          <View style={styles.pickerContainer}>
            <Text style={styles.label}>Select your voice</Text>
            <View style={styles.picker}>
              <Picker
                selectedValue={companionVoice}
                onValueChange={saveCompanionVoice}
                style={styles.pickerElement}
                itemStyle={styles.pickerItem}
              >
                {COMPANION_VOICE_OPTIONS.map(opt => (
                  <Picker.Item key={opt.id} label={opt.label} value={opt.id} />
                ))}
              </Picker>
            </View>
            <TouchableOpacity 
              style={styles.testVoiceBtn}
              onPress={() => playTestVoice(companionVoice)}
            >
              <Text style={styles.testVoiceText}>🔊 Test Voice</Text>
            </TouchableOpacity>
            <Text style={styles.description}>
              Used for companion voice in arena and AI responses on desktop.
            </Text>
          </View>
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
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  switchLabel: {
    color: '#ccc',
    fontSize: 14,
    fontWeight: '600',
  },
  label: {
    color: '#f7931a',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  pickerContainer: {
    marginTop: 12,
  },
  picker: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    overflow: 'hidden',
  },
  pickerElement: {
    color: '#f7931a',
    backgroundColor: '#1a1a2e',
  },
  pickerItem: {
    color: '#f7931a',
    fontSize: 14,
  },
  description: {
    color: '#888',
    fontSize: 12,
    marginTop: 8,
    fontStyle: 'italic',
  },
  testVoiceBtn: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(247,147,26,0.15)',
    borderWidth: 1,
    borderColor: '#f7931a',
    borderRadius: 8,
    alignItems: 'center',
  },
  testVoiceText: {
    color: '#f7931a',
    fontSize: 14,
    fontWeight: '600',
  },
});
