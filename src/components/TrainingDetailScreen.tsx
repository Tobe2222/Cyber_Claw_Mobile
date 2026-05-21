import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView, Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

interface TrainingSample {
  id: string;
  date: string;
  quality: number;
}

export default function TrainingDetailScreen({ phrase, onBack, onAddTraining }: {
  phrase: string;
  onBack: () => void;
  onAddTraining: () => void;
}) {
  const [samples, setSamples] = useState<TrainingSample[]>([]);
  const translateX = useSharedValue(0);

  useEffect(() => {
    loadSamples();
  }, []);

  const loadSamples = async () => {
    try {
      const json = await AsyncStorage.getItem('cyberclaw-wake-samples');
      if (json) {
        const data = JSON.parse(json);
        // Mock samples - in real app would be loaded from data
        if (data.samplePaths) {
          const mockSamples = data.samplePaths.map((path: string, idx: number) => ({
            id: `${idx}`,
            date: data.trainedAt || new Date().toISOString(),
            quality: data.overallQuality || 0.8,
          }));
          setSamples(mockSamples);
        }
      }
    } catch (e) {
      console.error('Error loading samples:', e);
    }
  };

  const deleteSample = (id: string) => {
    Alert.alert('Delete Sample?', 'This will remove this training sample.', [
      { text: 'Cancel' },
      {
        text: 'Delete',
        onPress: () => {
          setSamples(prev => prev.filter(s => s.id !== id));
        },
        style: 'destructive',
      },
    ]);
  };

  // Back swipe gesture
  const gesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationX > 50) {
        onBack();
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{ flex: 1 }, animatedStyle]}>
          <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content}>
              <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.backBtn}>
                  <Text style={styles.backBtnText}>← Back</Text>
                </TouchableOpacity>
                <Text style={styles.title}>📊 {phrase}</Text>
              </View>

              <View style={styles.statsBox}>
                <Text style={styles.statsLabel}>Total Samples</Text>
                <Text style={styles.statsValue}>{samples.length}</Text>
              </View>

              {samples.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>No samples yet</Text>
                  <Text style={styles.emptySubtext}>Add your first training sample below</Text>
                </View>
              ) : (
                <View style={styles.samplesList}>
                  <Text style={styles.samplesTitle}>Training Samples</Text>
                  {samples.map((sample, idx) => (
                    <View key={sample.id} style={styles.sampleCard}>
                      <View style={styles.sampleInfo}>
                        <Text style={styles.sampleLabel}>Sample {idx + 1}</Text>
                        <Text style={styles.sampleMeta}>
                          Quality: {(sample.quality * 100).toFixed(0)}%
                        </Text>
                        <Text style={styles.sampleDate}>
                          {new Date(sample.date).toLocaleDateString()}
                        </Text>
                      </View>

                      <View
                        style={[
                          styles.qualityDot,
                          {
                            backgroundColor:
                              sample.quality > 0.7 ? '#10b981' : sample.quality > 0.5 ? '#f59e0b' : '#ef4444',
                          },
                        ]}
                      />

                      <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={() => deleteSample(sample.id)}
                      >
                        <Text style={styles.deleteBtnText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              <TouchableOpacity style={styles.addBtn} onPress={onAddTraining}>
                <Text style={styles.addBtnText}>+ Add More Samples</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    gap: 12,
  },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  backBtnText: {
    color: '#f7931a',
    fontSize: 12,
    fontWeight: 'bold',
  },
  title: {
    color: '#f7931a',
    fontSize: 24,
    fontWeight: 'bold',
    flex: 1,
  },
  statsBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    alignItems: 'center',
  },
  statsLabel: {
    color: '#999',
    fontSize: 12,
    marginBottom: 4,
  },
  statsValue: {
    color: '#3b82f6',
    fontSize: 28,
    fontWeight: 'bold',
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
  samplesList: {
    marginBottom: 24,
  },
  samplesTitle: {
    color: '#f7931a',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  sampleCard: {
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
  sampleInfo: {
    flex: 1,
  },
  sampleLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  sampleMeta: {
    color: '#999',
    fontSize: 12,
    marginBottom: 2,
  },
  sampleDate: {
    color: '#666',
    fontSize: 11,
  },
  qualityDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
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
});
