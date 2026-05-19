/**
 * TrainingSummary — Show what was actually trained
 * 
 * Displays:
 * - Sample count
 * - Quality of each sample
 * - Duration of each
 * - Overall quality
 * - Visual indicators
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface TrainingSample {
  duration: number;
  quality: number;
  path: string;
}

interface Props {
  samples: TrainingSample[];
  overallQuality: number;
}

export default function TrainingSummary({ samples, overallQuality }: Props) {
  const qualityColor = (quality: number) => {
    if (quality > 0.7) return '#10b981';
    if (quality > 0.5) return '#f59e0b';
    return '#ef4444';
  };

  const qualityLabel = (quality: number) => {
    if (quality > 0.7) return 'Excellent';
    if (quality > 0.5) return 'Fair';
    return 'Poor';
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>📊 Training Summary</Text>
      
      <View style={styles.overallBox}>
        <Text style={styles.overallLabel}>Overall Quality</Text>
        <View style={styles.overallBar}>
          <View
            style={[
              styles.overallFill,
              {
                width: `${overallQuality * 100}%`,
                backgroundColor: qualityColor(overallQuality),
              },
            ]}
          />
        </View>
        <Text style={[styles.overallPercent, { color: qualityColor(overallQuality) }]}>
          {(overallQuality * 100).toFixed(0)}% {qualityLabel(overallQuality)}
        </Text>
      </View>

      <Text style={styles.samplesTitle}>Samples ({samples.length}/3)</Text>
      
      {samples.map((sample, i) => (
        <View key={i} style={styles.sampleBox}>
          <View style={styles.sampleHeader}>
            <Text style={styles.sampleLabel}>
              {sample.quality > 0.7 ? '✅' : sample.quality > 0.5 ? '⚠️' : '❌'} Sample {i + 1}
            </Text>
            <Text style={[styles.sampleQuality, { color: qualityColor(sample.quality) }]}>
              {(sample.quality * 100).toFixed(0)}%
            </Text>
          </View>
          <View style={styles.sampleBar}>
            <View
              style={[
                styles.sampleFill,
                {
                  width: `${sample.quality * 100}%`,
                  backgroundColor: qualityColor(sample.quality),
                },
              ]}
            />
          </View>
          <Text style={styles.sampleDuration}>
            Duration: {(sample.duration / 16000).toFixed(2)}s
          </Text>
        </View>
      ))}

      {samples.length < 3 && (
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            ⚠️ Only {samples.length} of 3 samples saved
          </Text>
          <Text style={styles.warningSubtext}>
            Some recordings failed validation. Retrain to get all 3.
          </Text>
        </View>
      )}

      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>💡 What This Means</Text>
        <Text style={styles.infoText}>
          {overallQuality > 0.7
            ? '✅ Great! Your training data is consistent and ready for detection.

💡 Tip: You can retrain and add MORE samples (6, 9, or more) for even better accuracy!'
            : overallQuality > 0.5
            ? '⚠️ Fair quality. Detection may work but consider retraining for better accuracy.

💡 Try adding more samples (5-6 total) for better consistency.'
            : '❌ Poor quality. Retrain with clearer audio and more consistent recordings.

💡 Recording 5-6 samples helps find your natural speaking pattern.'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0a0a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    padding: 12,
    marginVertical: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#f7931a',
    marginBottom: 12,
  },
  overallBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  overallLabel: {
    fontSize: 12,
    color: '#10b981',
    fontWeight: 'bold',
    marginBottom: 6,
  },
  overallBar: {
    height: 12,
    backgroundColor: '#1a1a2e',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 6,
  },
  overallFill: {
    height: '100%',
  },
  overallPercent: {
    fontSize: 13,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  samplesTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ccc',
    marginBottom: 8,
  },
  sampleBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  sampleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  sampleLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ccc',
  },
  sampleQuality: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  sampleBar: {
    height: 8,
    backgroundColor: '#222',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  sampleFill: {
    height: '100%',
  },
  sampleDuration: {
    fontSize: 11,
    color: '#666',
  },
  warningBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  warningText: {
    fontSize: 12,
    color: '#ef4444',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  warningSubtext: {
    fontSize: 11,
    color: '#999',
  },
  infoBox: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 10,
  },
  infoTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#3b82f6',
    marginBottom: 4,
  },
  infoText: {
    fontSize: 11,
    color: '#ccc',
    lineHeight: 16,
  },
});
