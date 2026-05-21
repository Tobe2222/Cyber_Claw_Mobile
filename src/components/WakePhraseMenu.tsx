import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface WakePhrase {
  id: string;
  phrase: string;
  quality: number;
  sampleCount: number;
  trainedAt: string;
}

export default function WakePhraseMenu({ onSelectPhrase, onClose }: {
  onSelectPhrase: (phrase: string) => void;
  onClose: () => void;
}) {
  const [phrases, setPhrases] = useState<WakePhrase[]>([]);
  const [defaultPhrase] = useState('hey clawsuu');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newPhrase, setNewPhrase] = useState('');

  useEffect(() => {
    migrateOldData();
    loadPhrases();
  }, []);

  const migrateOldData = async () => {
    try {
      // Check if old storage key exists
      const oldData = await AsyncStorage.getItem('cyberclaw-wake-samples');
      if (oldData) {
        const data = JSON.parse(oldData);
        const phrase = data.phrase || defaultPhrase;
        const newKey = `cyberclaw-wake-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;
        
        // Save to new key if it doesn't exist
        const newKeyExists = await AsyncStorage.getItem(newKey);
        if (!newKeyExists) {
          await AsyncStorage.setItem(newKey, oldData);
          console.log('[Migration] Migrated old data to:', newKey);
        }
        
        // Don't delete old key yet, keep for backward compat
      }
    } catch (e) {
      console.error('Error migrating data:', e);
    }
  };

  const loadPhrases = async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const phraseKeys = keys.filter(k => k.startsWith('cyberclaw-wake-samples-'));
      
      if (phraseKeys.length === 0) {
        // Check if old data exists
        const oldData = await AsyncStorage.getItem('cyberclaw-wake-samples');
        if (oldData) {
          const data = JSON.parse(oldData);
          const phrase: WakePhrase = {
            id: 'old-data',
            phrase: data.phrase || defaultPhrase,
            quality: data.overallQuality || 0,
            sampleCount: data.qualityScores?.length || data.sampleCount || 0,
            trainedAt: data.trainedAt || new Date().toISOString(),
          };
          setPhrases([phrase]);
          return;
        }
        return;
      }

      const loadedPhrases: WakePhrase[] = [];
      
      for (const key of phraseKeys) {
        const json = await AsyncStorage.getItem(key);
        if (json) {
          const data = JSON.parse(json);
          loadedPhrases.push({
            id: key,
            phrase: data.phrase || defaultPhrase,
            quality: data.overallQuality || 0,
            sampleCount: data.qualityScores?.length || data.sampleCount || 0,
            trainedAt: data.trainedAt || new Date().toISOString(),
          });
        }
      }
      
      setPhrases(loadedPhrases);
    } catch (e) {
      console.error('Error loading phrases:', e);
    }
  };

  const handleTraining = (phrase: string) => {
    onSelectPhrase(phrase);
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>🎤 Wake Phrases</Text>
        <Text style={styles.subtitle}>Select a phrase to train or add a new one</Text>

        {phrases.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No wake phrases yet</Text>
            <Text style={styles.emptySubtext}>Add your first phrase to get started</Text>
          </View>
        ) : (
          <View style={styles.phrasesList}>
            {phrases.map((p) => (
              <View key={p.id} style={styles.phraseCard}>
                <View style={styles.phraseInfo}>
                  <Text style={styles.phraseName}>{p.phrase}</Text>
                  <View style={styles.phraseMeta}>
                    <Text style={styles.phraseMetaText}>
                      {p.sampleCount} samples • {(p.quality * 100).toFixed(0)}% quality
                    </Text>
                    <Text style={styles.phraseDate}>
                      Trained: {new Date(p.trainedAt).toLocaleDateString()}
                    </Text>
                  </View>
                </View>

                <View style={styles.qualityIndicator}>
                  <View
                    style={[
                      styles.qualityDot,
                      {
                        backgroundColor:
                          p.quality > 0.7 ? '#10b981' : p.quality > 0.5 ? '#f59e0b' : '#ef4444',
                      },
                    ]}
                  />
                </View>

                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => handleTraining(p.phrase)}
                >
                  <Text style={styles.editBtnText}>✏️</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {!showAddDialog ? (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => {
              setShowAddDialog(true);
              setNewPhrase('');
            }}
          >
            <Text style={styles.addBtnText}>+ Add Wake Phrase</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.dialogBox}>
            <Text style={styles.dialogTitle}>New Wake Phrase</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="Enter phrase (e.g., hey clawsuu)"
              placeholderTextColor="#666"
              value={newPhrase}
              onChangeText={setNewPhrase}
              autoFocus
            />
            <TouchableOpacity
              style={styles.dialogBtn}
              onPress={() => {
                if (newPhrase.trim()) {
                  // Create phrase and start training
                  onSelectPhrase(newPhrase.trim());
                  setShowAddDialog(false);
                } else {
                  Alert.alert('Error', 'Please enter a phrase');
                }
              }}
            >
              <Text style={styles.dialogBtnText}>Start Training</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dialogCreateBtn}
              onPress={() => {
                if (newPhrase.trim()) {
                  // Just create without training - save empty phrase
                  AsyncStorage.setItem(
                    `cyberclaw-wake-samples-${newPhrase.trim().toLowerCase().replace(/\s+/g, '-')}`,
                    JSON.stringify({
                      phrase: newPhrase.trim(),
                      sampleCount: 0,
                      qualityScores: [],
                      overallQuality: 0,
                      trainedAt: new Date().toISOString(),
                      features: [],
                    })
                  ).then(() => {
                    setShowAddDialog(false);
                    loadPhrases();
                  });
                } else {
                  Alert.alert('Error', 'Please enter a phrase');
                }
              }}
            >
              <Text style={styles.dialogCreateText}>Just Create</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dialogCancelBtn}
              onPress={() => setShowAddDialog(false)}
            >
              <Text style={styles.dialogCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
  },
  content: {
    paddingTop: 70,
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  title: {
    color: '#f7931a',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  subtitle: {
    color: '#666',
    fontSize: 12,
    marginBottom: 24,
  },
  emptyBox: {
    backgroundColor: 'rgba(139, 92, 246, 0.1)',
    borderWidth: 2,
    borderColor: '#8b5cf6',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyText: {
    color: '#8b5cf6',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  emptySubtext: {
    color: '#666',
    fontSize: 12,
  },
  phrasesList: {
    marginBottom: 24,
  },
  phraseCard: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  phraseInfo: {
    flex: 1,
  },
  phraseName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  phraseMeta: {
    gap: 2,
  },
  phraseMetaText: {
    color: '#999',
    fontSize: 12,
  },
  phraseDate: {
    color: '#666',
    fontSize: 11,
  },
  qualityIndicator: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
  },
  qualityDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  editBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editBtnText: {
    fontSize: 18,
  },
  dialogBox: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  dialogTitle: {
    color: '#3b82f6',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  dialogInput: {
    backgroundColor: '#0a0a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    color: '#fff',
    padding: 12,
    marginBottom: 12,
    fontSize: 14,
  },
  dialogBtn: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  dialogBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  dialogCreateBtn: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  dialogCreateText: {
    color: '#3b82f6',
    fontSize: 14,
  },
  dialogCancelBtn: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dialogCancelText: {
    color: '#999',
    fontSize: 14,
  },
  addBtn: {
    backgroundColor: '#f7931a',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  addBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#0a0a1a',
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  cancelBtn: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#999',
    fontSize: 14,
    fontWeight: 'bold',
  },
});
