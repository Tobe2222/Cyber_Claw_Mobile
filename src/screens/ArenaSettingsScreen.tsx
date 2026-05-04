/**
 * ArenaSettingsScreen — Companion arena appearance and TTS voice
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform,
  Switch, Alert, SafeAreaView,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ArenaSettingsScreenProps {
  onBack: () => void;
}

const BG_OPTIONS = [
  { id: 'summer', label: '🌞 Summer Meadow' },
  { id: 'forest', label: '🌲 Forest Edge' },
  { id: 'dark-forest', label: '🌙 Dark Forest' },
  { id: 'dark', label: '⚫ Dark' },
];

const COMPANION_OPTIONS = [
  { id: 'fox', label: '🦊 Fox' },
  { id: 'boar', label: '🐗 Boar' },
  { id: 'deer', label: '🦌 Deer' },
  { id: 'hare', label: '🐰 Hare' },
  { id: 'black_grouse', label: '🐦 Black Grouse' },
];

const VOICE_OPTIONS = [
  { id: 'lessac', label: '🎙️ Lessac (Professional Male)' },
  { id: 'ryan', label: '👨 Ryan (Young Male)' },
  { id: 'glow-tts', label: '👩 Glow-TTS (Female)' },
];

const COMPANION_VOICE_OPTIONS = [
  { id: 'lessac', label: '🎙️ Lessac (Deep, Authoritative)' },
  { id: 'ryan', label: '👨 Ryan (Young, Friendly)' },
  { id: 'glow-tts', label: '👩 Glow-TTS (Warm, Curious)' },
];

export default function ArenaSettingsScreen({ onBack }: ArenaSettingsScreenProps) {
  const [bgId, setBgId] = useState('dark-forest');
  const [companionId, setCompanionId] = useState('boar');
  const [ttsVoice, setTtsVoice] = useState('lessac');
  const [companionVoice, setCompanionVoice] = useState('lessac');
  const [ttsEnabled, setTtsEnabled] = useState(true);

  useEffect(() => {
    // Load saved settings
    AsyncStorage.getItem('cyberclaw-arena-bg').then(v => { if (v) setBgId(v); });
    AsyncStorage.getItem('cyberclaw-arena-companion').then(v => { if (v) setCompanionId(v); });
    AsyncStorage.getItem('cyberclaw-tts-voice').then(v => { if (v) setTtsVoice(v); });
    AsyncStorage.getItem('cyberclaw-companion-voice').then(v => { if (v) setCompanionVoice(v); });
    AsyncStorage.getItem('cyberclaw-tts-enabled').then(v => { if (v !== null) setTtsEnabled(v === 'true'); });
  }, []);

  const saveBg = (id: string) => {
    setBgId(id);
    AsyncStorage.setItem('cyberclaw-arena-bg', id);
  };

  const saveCompanion = (id: string) => {
    setCompanionId(id);
    AsyncStorage.setItem('cyberclaw-arena-companion', id);
  };

  const saveVoice = (id: string) => {
    setTtsVoice(id);
    AsyncStorage.setItem('cyberclaw-tts-voice', id);
  };

  const saveCompanionVoice = (id: string) => {
    setCompanionVoice(id);
    AsyncStorage.setItem('cyberclaw-companion-voice', id);
  };

  const saveTtsEnabled = (v: boolean) => {
    setTtsEnabled(v);
    AsyncStorage.setItem('cyberclaw-tts-enabled', String(v));
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
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
                style={[styles.optionBtn, companionId === opt.id && styles.optionBtnActive]}
                onPress={() => saveCompanion(opt.id)}
              >
                <Text style={[styles.optionText, companionId === opt.id && styles.optionTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Companion Voice Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🎤 Companion Voice</Text>
          <View style={styles.pickerContainer}>
            <Text style={styles.label}>How does your companion sound?</Text>
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
            <Text style={styles.description}>
              Affects how the companion responds and reacts in the arena.
            </Text>
          </View>
        </View>

        {/* TTS Voice Settings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔊 Voice Response</Text>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Speak AI Responses</Text>
            <Switch
              value={ttsEnabled}
              onValueChange={saveTtsEnabled}
              trackColor={{ false: '#333', true: '#f7931a' }}
              thumbColor={ttsEnabled ? '#fff' : '#666'}
            />
          </View>

          {ttsEnabled && (
            <View style={styles.pickerContainer}>
              <Text style={styles.label}>Select Voice</Text>
              <View style={styles.picker}>
                <Picker
                  selectedValue={ttsVoice}
                  onValueChange={saveVoice}
                  style={styles.pickerElement}
                  itemStyle={styles.pickerItem}
                >
                  {VOICE_OPTIONS.map(opt => (
                    <Picker.Item key={opt.id} label={opt.label} value={opt.id} />
                  ))}
                </Picker>
              </View>
              <Text style={styles.description}>
                Desktop will use your selected voice for AI responses.
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
});
