import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert,
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

  useEffect(() => {
    loadPhrases();
  }, []);

  const loadPhrases = async () => {
    try {
      const json = await AsyncStorage.getItem('cyberclaw-wake-samples');
      if (json) {
        const data = JSON.parse(json);
        const phrase: WakePhrase = {
          id: '1',
          phrase: data.phrase || defaultPhrase,
          quality: data.overallQuality || 0,
          sampleCount: data.samplePaths?.length || data.sampleCount || 0,
          trainedAt: data.trainedAt || new Date().toISOString(),
        };
        setPhrases([phrase]);
      }
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

        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => handleTraining(defaultPhrase)}
        >
          <Text style={styles.addBtnText}>+ Add Training</Text>
        </TouchableOpacity>
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
