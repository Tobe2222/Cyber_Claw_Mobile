import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert, FlatList,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface TrainingSet {
  id: string;
  phrase: string;
  quality: number;
  sampleCount: number;
  trainedAt: string;
}

export default function TrainingManager({ onStartTraining, onClose }: {
  onStartTraining: () => void;
  onClose: () => void;
}) {
  const [trainingSets, setTrainingSets] = useState<TrainingSet[]>([]);

  useEffect(() => {
    loadTrainingSets();
  }, []);

  const loadTrainingSets = async () => {
    try {
      const json = await AsyncStorage.getItem('cyberclaw-wake-samples');
      if (json) {
        const data = JSON.parse(json);
        // Convert to TrainingSet format
        const set: TrainingSet = {
          id: '1',
          phrase: data.phrase || 'hey clawsuu',
          quality: data.overallQuality || 0,
          sampleCount: data.samplePaths?.length || data.sampleCount || 0,
          trainedAt: data.trainedAt || new Date().toISOString(),
        };
        setTrainingSets([set]);
      }
    } catch (e) {
      console.error('Error loading training sets:', e);
    }
  };

  const deleteTrainingSet = (id: string) => {
    Alert.alert(
      'Delete Training?',
      'This will remove your training data. You\'ll need to retrain.',
      [
        { text: 'Cancel', onPress: () => {} },
        {
          text: 'Delete',
          onPress: async () => {
            await AsyncStorage.removeItem('cyberclaw-wake-samples');
            setTrainingSets([]);
          },
          style: 'destructive',
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>🎤 Training Samples</Text>

        {trainingSets.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No training samples yet</Text>
            <Text style={styles.emptySubtext}>Create your first training set to get started</Text>
          </View>
        ) : (
          <View style={styles.setsList}>
            {trainingSets.map((set) => (
              <TouchableOpacity key={set.id} style={styles.setCard} onPress={() => {
                // TODO: Open manage screen for this training set
              }}>
                <View style={styles.setInfo}>
                  <Text style={styles.setPhrase}>{set.phrase}</Text>
                  <View style={styles.setMeta}>
                    <Text style={styles.setMetaText}>
                      {set.sampleCount} samples • {(set.quality * 100).toFixed(0)}% quality
                    </Text>
                    <Text style={styles.setDate}>
                      Trained: {new Date(set.trainedAt).toLocaleDateString()}
                    </Text>
                  </View>
                </View>

                <View style={styles.qualityIndicator}>
                  <View
                    style={[
                      styles.qualityDot,
                      {
                        backgroundColor:
                          set.quality > 0.7 ? '#10b981' : set.quality > 0.5 ? '#f59e0b' : '#ef4444',
                      },
                    ]}
                  />
                </View>

                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => deleteTrainingSet(set.id)}
                >
                  <Text style={styles.deleteBtnText}>✕</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={styles.hint}>Tap on a training sample to manage it</Text>

        <TouchableOpacity style={styles.createBtn} onPress={onStartTraining}>
          <Text style={styles.createBtnText}>+ Create New Training</Text>
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
  setsList: {
    marginBottom: 24,
  },
  setCard: {
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
  setInfo: {
    flex: 1,
  },
  setPhrase: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  setMeta: {
    gap: 2,
  },
  setMetaText: {
    color: '#999',
    fontSize: 12,
  },
  setDate: {
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
  deleteBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  hint: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 16,
    marginTop: -8,
  },
  createBtn: {
    backgroundColor: '#f7931a',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  createBtnText: {
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
