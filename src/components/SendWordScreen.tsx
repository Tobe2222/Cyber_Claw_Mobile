/**
 * SendWordScreen — dedicated page for configuring the
 * send (commit-turn) word. v3.10.167.
 *
 * Tobe (2026-08-14): "compact the send word and just make
 * a page out of it with a button for it in the settings."
 *
 * Before this screen, the Voice mode section in
 * SettingsScreen had a 100+ line inline block for the send
 * word: phrase input + save button + train button + trained
 * model badge + classifier test panel. All crammed into
 * the middle of the Voice mode section between Smart
 * silence and the cue-sound controls. Visually noisy,
 * pushing the cue-sound controls below the fold on most
 * phones.
 *
 * This screen pulls everything send-word-related into one
 * full-screen page, leaving the Voice mode section with
 * just a single "Send word" row that opens it.
 *
 * The screen owns its own copy of the relevant state
 * (phrase, saved-at, model info) and pushes changes back
 * to the parent via callbacks. This mirrors how
 * WakeSetManagerScreen is shaped, and keeps SettingsScreen
 * as the single source of truth for the persisted value
 * (the parent updates AsyncStorage and re-derives
 * sendModelInfo on every phrase change — same as before).
 *
 * Structure:
 *   - Header (← Back, title)
 *   - Hint explaining what the send word does
 *   - Phrase input + Save row
 *   - Trained model badge (matches the wake-trainer style)
 *   - "Train send word" button → opens the SendPhraseTrainer
 *   - "Test send" classifier test panel
 *
 * SettingsScreen passes the live `voiceSendPhrase`,
 * `voiceSendPhraseSavedAt`, and `sendModelInfo` as props,
 * along with callbacks to mutate them. The screen also
 * owns its `showSendPhraseTrainer` sub-state so the trainer
 * can open/close without bothering the parent.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TextInput,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeContext';
import { ClassifierTestPanel } from './ClassifierTest';
import SendPhraseTrainer from './SendPhraseTrainer';
import { saveSendPhrase } from '../services/VoiceSettings';

export type SendWordModelInfo = {
  trainedAt: number;
  modelPath: string;
};

export default function SendWordScreen({
  phrase,
  savedAt,
  modelInfo,
  onPhraseChange,
  onSaved,
  onBack,
}: {
  phrase: string;
  savedAt: number | null;
  modelInfo: SendWordModelInfo | null;
  onPhraseChange: (next: string) => void;
  onSaved: (trimmed: string) => void;
  onBack: () => void;
}) {
  const { theme: t } = useTheme();
  const insets = useSafeAreaInsets();
  const [showTrainer, setShowTrainer] = useState(false);

  const handleSave = useCallback(async () => {
    const trimmed = phrase.trim().toLowerCase();
    if (!trimmed) {
      Alert.alert(
        'Invalid',
        'Send word cannot be empty. Tap "Clear" in the trainer to disable.',
      );
      return;
    }
    try {
      const saved = await saveSendPhrase(trimmed);
      onSaved(saved);
    } catch (e: any) {
      Alert.alert('Save failed', e?.message || 'Could not save the send word.');
    }
  }, [phrase, onSaved]);

  // Trainer is mounted as a full-screen overlay above this
  // page. When training completes, the parent re-runs its
  // `loadSendModelInfo` effect for the active phrase, so the
  // badge updates without us needing to push anything back.
  if (showTrainer) {
    return (
      <SendPhraseTrainer
        presetPhrase={phrase || undefined}
        onCancel={() => setShowTrainer(false)}
        onComplete={(ok) => {
          setShowTrainer(false);
          // Tell the parent the phrase is "freshly trained" so
          // it bumps savedAt and re-reads the model info.
          if (ok && phrase.trim()) {
            onSaved(phrase.trim().toLowerCase());
          }
        }}
      />
    );
  }

  const styles = makeStyles(t);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backBtn}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>✉️ Send word</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 24, 60) },
        ]}
      >
        {/* What is the send word? */}
        <View style={styles.introCard}>
          <Text style={styles.introTitle}>What is the send word?</Text>
          <Text style={styles.introBody}>
            Backup commit word for voice-mode turns. The primary trigger is
            silence-detection (the VAD's silence countdown) or
            gibberish-detection (VAD noise floor). When those miss — e.g. the
            silence threshold doesn't trip because the audio cuts off
            mid-word, or the VAD reads low noise as speech — saying this word
            commits the turn to the LLM by hand.
          </Text>
          <Text style={styles.introBody}>
            Independent of the exit phrase — send keeps the conversation
            going, exit closes voice mode. Shared across all companions.
          </Text>
        </View>

        {/* Phrase input + Save row */}
        <Text style={styles.label}>Send word</Text>
        <View style={styles.phraseRow}>
          <TextInput
            value={phrase}
            onChangeText={onPhraseChange}
            editable={true}
            style={[styles.input, { flex: 1 }]}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
            placeholder="send"
            placeholderTextColor="#666"
          />
          <TouchableOpacity
            style={[styles.saveBtn, { marginLeft: 8 }]}
            onPress={handleSave}
          >
            <Text style={styles.saveBtnText}>
              {savedAt ? '✅ Saved' : '💾 Save'}
            </Text>
          </TouchableOpacity>
        </View>
        {savedAt ? (
          <Text style={styles.savedHint}>
            Saved {new Date(savedAt).toLocaleString()}
          </Text>
        ) : null}

        {/* Trained model badge — same shape as before so the
            "Listening for: <phrase>" status is obvious. */}
        <View style={styles.sectionGap} />
        {modelInfo ? (
          <View style={[styles.modelBadge, styles.modelBadgeTrained]}>
            <Text style={styles.modelBadgeIcon}>✓</Text>
            <View style={styles.modelBadgeTextWrap}>
              <Text style={styles.modelBadgeText}>
                Listening for "{phrase.trim().toLowerCase()}"
              </Text>
              <Text style={styles.modelBadgeMeta} numberOfLines={1}>
                Trained {new Date(modelInfo.trainedAt).toLocaleString()}
                {modelInfo.modelPath ? ` · ${modelInfo.modelPath}` : ''}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.modelBadge}>
            <Text style={styles.modelBadgeText}>
              No trained send model yet — tap "Train send word" below to
              record 6 samples and hot-swap one in.
            </Text>
          </View>
        )}

        {/* Train send word button */}
        <TouchableOpacity
          style={styles.trainBtn}
          onPress={() => setShowTrainer(true)}
        >
          <Text style={styles.trainBtnText}>
            🎙️ Train send word (6 samples)
          </Text>
        </TouchableOpacity>

        {/* Classifier test panel — same shared component as
            before, just relocated. */}
        <Text style={styles.label}>Test the trained model</Text>
        <Text style={styles.hint}>
          Tap start, say the trained send word, see the peak score.
        </Text>
        <ClassifierTestPanel kind="send" />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg.primary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.bg.tertiary,
    },
    backBtn: { color: t.brand.accent, fontSize: 16, fontWeight: '600', minWidth: 60 },
    title: { color: t.text.primary, fontSize: 18, fontWeight: '700' },
    scroll: { flex: 1 },
    scrollContent: { paddingHorizontal: 20, paddingTop: 20 },
    introCard: {
      backgroundColor: t.bg.secondary,
      borderRadius: 12,
      padding: 16,
      marginBottom: 20,
      borderWidth: 1,
      borderColor: t.bg.tertiary,
    },
    introTitle: {
      color: t.brand.accent,
      fontSize: 14,
      fontWeight: '700',
      marginBottom: 8,
      letterSpacing: 0.5,
    },
    introBody: {
      color: t.text.muted,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 8,
    },
    label: {
      color: t.text.secondary,
      fontSize: 14,
      fontWeight: '600',
      marginBottom: 6,
      marginTop: 8,
    },
    phraseRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    input: {
      backgroundColor: t.bg.tertiary,
      color: t.text.primary,
      borderRadius: 8,
      padding: 12,
      fontSize: 16,
      borderWidth: 1,
      borderColor: t.border.mid,
    },
    saveBtn: {
      backgroundColor: t.brand.success,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveBtnText: { color: t.text.inverse, fontSize: 14, fontWeight: '700' },
    savedHint: { color: t.brand.success, fontSize: 12, marginTop: 6 },
    sectionGap: { height: 12 },
    modelBadge: {
      backgroundColor: 'rgba(156, 163, 175, 0.10)',
      borderColor: 'rgba(156, 163, 175, 0.3)',
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      flexDirection: 'row',
      alignItems: 'center',
    },
    modelBadgeTrained: {
      // Slightly brighter border when trained — matches the
      // wake-trainer active-model badge.
      backgroundColor: 'rgba(34, 197, 94, 0.08)',
      borderColor: 'rgba(34, 197, 94, 0.4)',
    },
    modelBadgeIcon: {
      color: t.brand.success,
      fontSize: 18,
      fontWeight: '700',
      marginRight: 10,
    },
    modelBadgeTextWrap: { flex: 1 },
    modelBadgeText: { color: t.text.primary, fontSize: 14, fontWeight: '600' },
    modelBadgeMeta: { color: t.text.muted, fontSize: 12, marginTop: 2 },
    trainBtn: {
      backgroundColor: t.brand.success,
      borderRadius: 8,
      padding: 14,
      alignItems: 'center',
      marginTop: 12,
    },
    trainBtnText: { color: t.text.inverse, fontSize: 15, fontWeight: '700' },
    hint: { color: t.text.dim, fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 },
  });
}
