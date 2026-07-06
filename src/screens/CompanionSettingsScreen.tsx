/**
 * CompanionSettingsScreen — per-companion settings as its OWN screen.
 *
 * v3.4.4: extracted from SettingsScreen into its own file so that
 * tapping a companion in Voice mode → list swaps the ENTIRE app
 * view to this screen, instead of rendering the companion detail
 * inline within SettingsScreen's scroll (which mixed companion
 * settings with Voice & Speech / Permissions / Connection sections
 * on the same scroll — confusing per Tobe's v3.4.3 feedback).
 *
 * Reached via App.tsx route 'companion' with a companionId prop.
 * Back button → returns to SettingsScreen.
 *
 * UI hierarchy (5 levels):
 *   App.tsx
 *     ↓ tap companion row in SettingsScreen
 *   <CompanionSettingsScreen>
 *     - companion overview (Wake / Exit cards)
 *         ↓ tap Wake card
 *     - Wake settings sub-page (greeting, phrases, train)
 *         ↓ back
 *     - companion overview
 *         ↓ tap Exit card
 *     - Exit settings sub-page (reply, phrases, train)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform, NativeModules, BackHandler,
} from 'react-native';
const { WakeWordModule } = NativeModules;
import AsyncStorage from '@react-native-async-storage/async-storage';
import OpenWakeWordTrainer from '../components/OpenWakeWordTrainer';
import ExitPhraseTrainer from '../components/ExitPhraseTrainer';
// v3.7.0: per-companion voice settings (engine + voice id,
// both Local and Premium API paths). The catalog of available
// voices is shared with the global Settings screen via
// VoiceCatalog.ts.
import { loadVoiceFor, saveVoiceFor, clearVoiceFor } from '../services/VoiceSettings';
import {
  LOCAL_VOICES,
  PREMIUM_PROVIDERS,
  VoiceEngine,
} from '../services/VoiceCatalog';

type Companion = {
  id: string;
  name: string;
  emoji?: string | null;
  icon?: string | null;
};

export default function CompanionSettingsScreen({
  companionId,
  onBack,
}: {
  companionId: string;
  onBack: () => void;
}) {
  // v3.4.4: drill-down phase inside the companion
  // detail view. null = overview (cards). 'wake' / 'exit'
  // = sub-page for that phase.
  // v3.7.0: 'voice' added — per-companion voice engine +
  // voice picker (Local / Premium API / Use global default).
  const [companionViewPhase, setCompanionViewPhase] = useState<'wake' | 'exit' | 'voice' | null>(null);

  // Companion list — owned here (not lifted to App.tsx)
  // because this screen needs it to resolve companionId
  // → {name, emoji}. Hydrates from the same AsyncStorage
  // cache that HomeScreen writes.
  const [availableCompanions, setAvailableCompanions] = useState<Companion[]>([]);

  // Per-companion settings state
  const [readyPhrase, setReadyPhrase] = useState('Ready to chat');
  const [readyPhraseSavedAt, setReadyPhraseSavedAt] = useState<number | null>(null);
  const readyPhraseSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [exitReplyPhrase, setExitReplyPhrase] = useState('Goodbye!');
  const [exitReplySavedAt, setExitReplySavedAt] = useState<number | null>(null);
  const exitReplySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [voiceExitPhrase, setVoiceExitPhrase] = useState('thanks');
  const [voiceExitPhraseSavedAt, setVoiceExitPhraseSavedAt] = useState<number | null>(null);

  const [activeWakeCompanionId, setActiveWakeCompanionId] = useState<string | null>(null);

  const [savedWakeModels, setSavedWakeModels] = useState<Record<string, { phrase: string; path: string; savedAt: number }>>({});

  // Trainer modal state
  const [trainingCompanionId, setTrainingCompanionId] = useState<string | null>(null);
  const [trainingCompanionName, setTrainingCompanionName] = useState<string>('');
  const [editingWakePhrase, setEditingWakePhrase] = useState<string>('');
  const [showOwwTrainer, setShowOwwTrainer] = useState(false);
  const [editingExitPhrase, setEditingExitPhrase] = useState<string>('');
  const [showExitPhraseTrainer, setShowExitPhraseTrainer] = useState(false);

  // v3.4.4: set true when the active companionId was
  // missing from a populated cache and we already auto-
  // backed out, so we don't loop onBack in render.
  const hasAutoBackedRef = useRef(false);

  // Hydrate companion list from local cache
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-agents-cache');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setAvailableCompanions(parsed.map((a: any) => ({
              id: a.id,
              name: a.name,
              emoji: a.emoji || null,
              icon: a.icon || null,
            })));
          }
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate wake greeting
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-ready-phrase');
        if (raw !== null) {
          setReadyPhrase(raw);
          setReadyPhraseSavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate exit reply
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-exit-reply-phrase');
        if (raw !== null) {
          setExitReplyPhrase(raw);
          setExitReplySavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, []);

  // Hydrate exit phrase (per-companion)
  useEffect(() => {
    (async () => {
      try {
        const { getExitPhraseKey } = await import('../services/VoiceSettings');
        const p = await AsyncStorage.getItem(getExitPhraseKey(companionId));
        if (p) {
          setVoiceExitPhrase(p);
          setVoiceExitPhraseSavedAt(Date.now());
        }
      } catch (_) {}
    })();
  }, [companionId]);

  // Hydrate active-wake-companion preference
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-active-wake-companion');
        if (raw) setActiveWakeCompanionId(raw);
      } catch (_) {}
    })();
  }, []);

  // v3.4.0: one-time migration from v3.3.0's global exit
  // storage to per-companion. Idempotent — no-op if the
  // active companion already has migrated data.
  useEffect(() => {
    (async () => {
      if (availableCompanions.length === 0) return;
      try {
        const { migrateLegacyExitSamples } = await import('../services/VoiceSettings');
        const targetId = activeWakeCompanionId || availableCompanions[0].id;
        await migrateLegacyExitSamples(targetId);
      } catch (_) {}
    })();
  }, [availableCompanions.length, activeWakeCompanionId]);

  // v3.4.4: refresh saved-wake-models whenever the
  // companion list grows or the active companion
  // changes (covers post-training refresh).
  useEffect(() => {
    WakeWordModule?.getSavedWakeModels?.()
      .then((models: any) => {
        if (!models) return;
        const out: Record<string, { phrase: string; path: string; savedAt: number }> = {};
        for (const agentId of Object.keys(models)) {
          const entry = models[agentId];
          if (entry?.phrase && entry?.path) {
            out[agentId] = {
              phrase: entry.phrase,
              path: entry.path,
              savedAt: entry.savedAt || 0,
            };
          }
        }
        setSavedWakeModels(out);
      })
      .catch(() => {});
  }, [availableCompanions.length, activeWakeCompanionId]);

  // Debounced auto-save for wake greeting
  const persistReadyPhrase = (v: string) => {
    if (readyPhraseSaveTimer.current) clearTimeout(readyPhraseSaveTimer.current);
    readyPhraseSaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-ready-phrase', v);
      setReadyPhraseSavedAt(Date.now());
      // v3.1.91: kick off a desktop synthesis for the new
      // phrase so the next wake event has a cached audio
      // to play. Fire-and-forget.
      if (v && v.trim()) {
        try {
          const { ensureGreetingCached } = require('../services/GreetingAudioCache');
          ensureGreetingCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // Mirror for exit reply
  const persistExitReplyPhrase = (v: string) => {
    if (exitReplySaveTimer.current) clearTimeout(exitReplySaveTimer.current);
    exitReplySaveTimer.current = setTimeout(async () => {
      await AsyncStorage.setItem('cyberclaw-exit-reply-phrase', v);
      setExitReplySavedAt(Date.now());
      // Synthesize. Empty string = silent close.
      if (v && v.trim()) {
        try {
          const { ensureExitReplyCached } = require('../services/ExitReplyAudioCache');
          ensureExitReplyCached(v.trim());
        } catch (_) {}
      }
    }, 600);
  };

  // Hardware back handler — chain through phases
  useEffect(() => {
    const bh = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showOwwTrainer) { setShowOwwTrainer(false); return true; }
      if (showExitPhraseTrainer) { setShowExitPhraseTrainer(false); return true; }
      if (companionViewPhase) { setCompanionViewPhase(null); return true; }
      onBack();
      return true;
    });
    return () => bh.remove();
  }, [onBack, showOwwTrainer, showExitPhraseTrainer, companionViewPhase]);

  // v3.4.4: back out if the active companionId is
  // missing from a populated cache. Idempotent via
  // hasAutoBackedRef so re-renders don't loop onBack.
  useEffect(() => {
    if (
      availableCompanions.length > 0 &&
      !availableCompanions.find(c => c.id === companionId)
    ) {
      if (!hasAutoBackedRef.current) {
        hasAutoBackedRef.current = true;
        onBack();
      }
    }
  }, [availableCompanions, companionId, onBack]);

  // Resolve companionId → companion object. If stale
  // (deleted from cache) show a placeholder while the
  // effect above fires onBack().
  const companion = availableCompanions.find(c => c.id === companionId);
  if (!companion) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Companion</Text>
          <View style={{ width: 60 }} />
        </View>
      </View>
    );
  }

  // Dispatch
  if (companionViewPhase === 'wake') {
    return renderCompanionWakePage(companion);
  }
  if (companionViewPhase === 'exit') {
    return renderCompanionExitPage(companion);
  }
  if (companionViewPhase === 'voice') {
    return renderCompanionVoicePage(companion);
  }
  return renderCompanionOverview(companion);

  // Overview (cards)
  function renderCompanionOverview(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity onPress={onBack} style={styles.detailBackBtn}>
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              {companion.emoji || companion.icon || '🐾'}  {companion.name}
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{companion.name} settings</Text>
            <Text style={styles.sectionDesc}>
              Wake word, exit phrase, greeting, and reply for {companion.name}.
            </Text>
            <Hint>Tap a card to open its settings.</Hint>

            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#3b82f6' }]}
              onPress={() => setCompanionViewPhase('wake')}
            >
              <Text style={styles.phaseCardEmoji}>🎤</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Wake settings</Text>
                <Text style={styles.phaseCardSub}>
                  Greeting, trained wake words, train a new wake phrase
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#f7931a' }]}
              onPress={() => setCompanionViewPhase('exit')}
            >
              <Text style={styles.phaseCardEmoji}>🚪</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Exit settings</Text>
                <Text style={styles.phaseCardSub}>
                  Exit reply, trained exit phrases, train a new exit phrase
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>

            {/* v3.7.0: per-companion Voice settings. Engine +
                voice picker. Gated on the global "✨ Enable API
                speech" master toggle when Premium API is
                selected (falls back to Local). API keys are
                global, shared across all companions. */}
            <TouchableOpacity
              style={[styles.phaseCard, { borderColor: '#10b981' }]}
              onPress={() => setCompanionViewPhase('voice')}
            >
              <Text style={styles.phaseCardEmoji}>🔊</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.phaseCardTitle}>Voice settings</Text>
                <Text style={styles.phaseCardSub}>
                  Engine (Local / Premium API) and voice for {companion.name}
                </Text>
              </View>
              <Text style={styles.phaseCardArrow}>›</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  function renderCompanionWakePage(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🎤  {companion.name} — Wake
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Wake settings</Text>
            <Text style={styles.sectionDesc}>
              Greeting and trained wake words for {companion.name}.
            </Text>

            <SubTitle>Wake greeting</SubTitle>
            <Hint>Phrase the companion says when the wake word fires. Auto-saves as you type.</Hint>
            <TextInput
              style={styles.input}
              value={readyPhrase}
              onChangeText={(v) => { setReadyPhrase(v); persistReadyPhrase(v); }}
              onBlur={() => AsyncStorage.setItem('cyberclaw-ready-phrase', readyPhrase).then(() => setReadyPhraseSavedAt(Date.now()))}
              placeholder="Ready to chat"
              placeholderTextColor="#555"
              returnKeyType="done"
            />
            {readyPhraseSavedAt && (
              <Text style={styles.savedHint}>✅ Saved at {new Date(readyPhraseSavedAt).toLocaleTimeString()}</Text>
            )}

            <SubTitle>Wake phrases</SubTitle>
            <Hint>Trained wake words for {companion.name}. Tap 🎙 to retrain, 🗑 to delete.</Hint>
            <WakePhrasePicker
              companions={[companion]}
              savedModels={savedWakeModels}
              activeCompanionId={activeWakeCompanionId}
              onSelect={(selectedCid) => {
                setActiveWakeCompanionId(selectedCid);
                AsyncStorage.setItem('cyberclaw-active-wake-companion', selectedCid);
                const entry = savedWakeModels[selectedCid];
                if (entry?.phrase) {
                  AsyncStorage.getItem('cyberclaw-audio-settings').then(raw => {
                    const settings = raw ? JSON.parse(raw) : {};
                    settings.wakeWord = entry.phrase;
                    AsyncStorage.setItem('cyberclaw-audio-settings', JSON.stringify(settings));
                  });
                }
              }}
              onRetrain={(rcid, phrase) => {
                setTrainingCompanionId(rcid);
                setTrainingCompanionName(companion.name);
                setEditingWakePhrase(phrase);
                setShowOwwTrainer(true);
              }}
              onDelete={(rcid) => {
                Alert.alert(
                  'Delete wake model?',
                  `Removes the trained wake word for ${companion.name}. You can re-train it later.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await AsyncStorage.removeItem(`cyberclaw-wake-samples-${rcid}`);
                          setSavedWakeModels(prev => {
                            const next = { ...prev };
                            delete next[rcid];
                            return next;
                          });
                          if (activeWakeCompanionId === rcid) {
                            setActiveWakeCompanionId(null);
                            await AsyncStorage.removeItem('cyberclaw-active-wake-companion');
                          }
                        } catch (_) {}
                      },
                    },
                  ],
                );
              }}
            />
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#3b82f6' }]}
              onPress={() => {
                setTrainingCompanionId(companion.id);
                setTrainingCompanionName(companion.name);
                setEditingWakePhrase('');
                setShowOwwTrainer(true);
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#3b82f6' }]}>🎤 Train new wake phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record 6 samples — desktop trains a custom neural wake word</Text>
            </TouchableOpacity>
          </View>

          {showOwwTrainer && trainingCompanionId ? (
            <OpenWakeWordTrainer
              companionId={trainingCompanionId}
              companionName={trainingCompanionName}
              presetPhrase={editingWakePhrase}
              onClose={() => setShowOwwTrainer(false)}
            />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  function renderCompanionExitPage(companion: Companion) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🚪  {companion.name} — Exit
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Exit settings</Text>
            <Text style={styles.sectionDesc}>
              Exit reply and trained exit phrases for {companion.name}.
            </Text>

            <SubTitle>Exit reply</SubTitle>
            <Hint>Phrase the companion says when voice mode closes. Empty for silent close.</Hint>
            <TextInput
              style={styles.input}
              value={exitReplyPhrase}
              onChangeText={(v) => { setExitReplyPhrase(v); persistExitReplyPhrase(v); }}
              onBlur={() => AsyncStorage.setItem('cyberclaw-exit-reply-phrase', exitReplyPhrase).then(() => setExitReplySavedAt(Date.now()))}
              placeholder="Goodbye!"
              placeholderTextColor="#555"
              returnKeyType="done"
            />
            {exitReplySavedAt && exitReplyPhrase && (
              <Text style={styles.savedHint}>✅ Saved at {new Date(exitReplySavedAt).toLocaleTimeString()}</Text>
            )}

            <SubTitle>Exit phrases</SubTitle>
            <Hint>Trained phrases that close voice mode when {companion.name} hears them. Tap 🎙 to retrain, 🗑 to delete.</Hint>
            <PerCompanionExitPicker
              companionId={companion.id}
              activePhrase={voiceExitPhrase}
              onSelect={async (p) => {
                setVoiceExitPhrase(p);
                const { saveExitPhrase } = await import('../services/VoiceSettings');
                await saveExitPhrase(companion.id, p);
                setVoiceExitPhraseSavedAt(Date.now());
              }}
              onRetrain={(p) => {
                setEditingExitPhrase(p);
                setShowExitPhraseTrainer(true);
              }}
              onDelete={async (p) => {
                Alert.alert(
                  'Delete exit phrase?',
                  `Removes the trained samples for "${p}" on ${companion.name}.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        const { clearExitSamples, saveExitPhrase } = await import('../services/VoiceSettings');
                        await clearExitSamples(companion.id, p);
                        if (voiceExitPhrase.toLowerCase() === p.toLowerCase()) {
                          setVoiceExitPhrase('');
                          await saveExitPhrase(companion.id, '');
                        }
                      },
                    },
                  ],
                );
              }}
            />
            {voiceExitPhraseSavedAt && voiceExitPhrase && (
              <Text style={styles.savedHint}>✅ Active: "{voiceExitPhrase}" saved</Text>
            )}
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#f7931a' }]}
              onPress={() => {
                setEditingExitPhrase('');
                setShowExitPhraseTrainer(true);
              }}
            >
              <Text style={[styles.trainBtnText, { color: '#f7931a' }]}>🚪 Train new exit phrase for {companion.name}</Text>
              <Text style={styles.trainBtnSub}>Record a short phrase 6 times — closes voice mode instantly when heard</Text>
            </TouchableOpacity>
          </View>

          {showExitPhraseTrainer ? (
            <ExitPhraseTrainer
              companionId={companion.id}
              companionName={companion.name}
              presetPhrase={editingExitPhrase}
              onClose={() => setShowExitPhraseTrainer(false)}
            />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // v3.7.0: per-companion voice settings sub-page. Engine
  // selector + voice picker. API keys are global (set in the
  // Settings screen 🔑 API keys section); this page only
  // chooses which engine and which voice each companion uses.
  //
  // Premium API option is gated on the global "✨ Enable API
  // speech" master toggle (stored in the global voiceEngine
  // AsyncStorage key by SettingsScreen). If the toggle is off,
  // the API radio is disabled and a hint explains why.
  function renderCompanionVoicePage(companion: Companion) {
    const [vcEngine, setVcEngine] = useState<VoiceEngine>('default');
    const [vcLocalId, setVcLocalId] = useState<string>('default');
    const [vcApiProvider, setVcApiProvider] = useState<string>('elevenlabs');
    const [vcApiVoice, setVcApiVoice] = useState<string>('nova');
    const [vcGlobalApiEnabled, setVcGlobalApiEnabled] = useState<boolean>(false);
    const [vcSavedAt, setVcSavedAt] = useState<number | null>(null);
    const vcLoadedRef = useRef(false);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const cfg = await loadVoiceFor(companion.id);
        // Determine stored engine: 'default' if no per-companion
        // override was written, else the explicit value.
        let storedEngine: VoiceEngine = 'default';
        try {
          const raw = await AsyncStorage.getItem(`cyberclaw-voice-engine-${companion.id}`);
          if (raw === 'local' || raw === 'api' || raw === 'default') {
            storedEngine = raw;
          }
        } catch (_) {}
        const globalEngine = await AsyncStorage.getItem('cyberclaw-voice-engine').catch(() => null);
        const apiGloballyEnabled = globalEngine === 'api';
        if (cancelled) return;
        setVcEngine(storedEngine);
        setVcLocalId(cfg.localId);
        setVcApiProvider(cfg.apiProvider);
        setVcApiVoice(cfg.apiVoice);
        setVcGlobalApiEnabled(apiGloballyEnabled);
        vcLoadedRef.current = true;
      })();
      return () => { cancelled = true; };
    }, [companion.id]);

    const saveVoice = useCallback(async () => {
      if (!vcLoadedRef.current) return;
      await saveVoiceFor(companion.id, {
        engine: vcEngine,
        localId: vcLocalId,
        apiProvider: vcApiProvider,
        apiVoice: vcApiVoice,
      });
      setVcSavedAt(Date.now());
    }, [companion.id, vcEngine, vcLocalId, vcApiProvider, vcApiVoice]);

    const resetToGlobal = useCallback(async () => {
      await clearVoiceFor(companion.id);
      setVcEngine('default');
      // Reload effective values from globals.
      const cfg = await loadVoiceFor(companion.id);
      setVcLocalId(cfg.localId);
      setVcApiProvider(cfg.apiProvider);
      setVcApiVoice(cfg.apiVoice);
      setVcSavedAt(Date.now());
    }, [companion.id]);

    // Resolve the effective engine for the "what would actually
    // be used right now?" status row.
    const effectiveEngine: 'local' | 'api' =
      vcEngine === 'default'
        ? (vcGlobalApiEnabled ? 'api' : 'local')
        : vcEngine;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.detailHeaderRow}>
            <TouchableOpacity
              onPress={() => setCompanionViewPhase(null)}
              style={styles.detailBackBtn}
            >
              <Text style={styles.detailBackBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.detailHeader}>
              🔊  {companion.name} — Voice
            </Text>
            <View style={{ width: 60 }} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Voice settings</Text>
            <Text style={styles.sectionDesc}>
              How {companion.name} speaks back to you. Per-companion override
              of the global voice engine and voice choice.
            </Text>

            <SubTitle>Engine</SubTitle>
            <Hint>📱 Local uses the device's Android TTS engine (free, offline). ✨ Premium API uses cloud voices (ElevenLabs / Google Cloud TTS) — requires the global 🔑 API keys setup and the ✨ API speech master toggle to be on.</Hint>
            <View style={{ marginVertical: 6 }}>
              <TouchableOpacity
                onPress={() => setVcEngine('default')}
                style={[styles.radioRow, vcEngine === 'default' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'default' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>🌐 Use global default</Text>
                  <Text style={styles.radioSub}>Inherit whatever the global master is set to right now.</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setVcEngine('local')}
                style={[styles.radioRow, vcEngine === 'local' && styles.radioRowActive]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'local' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>📱 Local (free)</Text>
                  <Text style={styles.radioSub}>Android TTS, always available.</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => vcGlobalApiEnabled && setVcEngine('api')}
                disabled={!vcGlobalApiEnabled}
                style={[
                  styles.radioRow,
                  vcEngine === 'api' && styles.radioRowActive,
                  !vcGlobalApiEnabled && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.radioBullet}>{vcEngine === 'api' ? '◉' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.radioTitle}>✨ Premium API</Text>
                  <Text style={styles.radioSub}>
                    {vcGlobalApiEnabled
                      ? 'Cloud TTS (ElevenLabs / Google). Uses the global API key.'
                      : 'Disabled — turn on ✨ API speech in the global 🔑 API keys section first.'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {effectiveEngine === 'local' ? (
              <>
                <SubTitle>Local voice</SubTitle>
                <View style={{ marginVertical: 6 }}>
                  {LOCAL_VOICES.map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => setVcLocalId(v.id)}
                      style={[styles.radioRow, vcLocalId === v.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcLocalId === v.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{v.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : (
              <>
                <SubTitle>Premium API voice</SubTitle>
                <Hint>Provider and voice for {companion.name}.</Hint>
                <View style={{ marginVertical: 6 }}>
                  {PREMIUM_PROVIDERS.map(p => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => setVcApiProvider(p.id)}
                      style={[styles.radioRow, vcApiProvider === p.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcApiProvider === p.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <SubTitle>Voice</SubTitle>
                <View style={{ marginVertical: 6 }}>
                  {PREMIUM_PROVIDERS.find(p => p.id === vcApiProvider)?.voices.map(v => (
                    <TouchableOpacity
                      key={v.id}
                      onPress={() => setVcApiVoice(v.id)}
                      style={[styles.radioRow, vcApiVoice === v.id && styles.radioRowActive]}
                    >
                      <Text style={styles.radioBullet}>{vcApiVoice === v.id ? '◉' : '○'}</Text>
                      <Text style={[styles.radioTitle, { flex: 1 }]}>{v.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <View style={{ height: 1, backgroundColor: '#333', marginVertical: 16 }} />
            <Hint>
              Currently: <Text style={{ color: '#10b981', fontWeight: '600' }}>{effectiveEngine === 'api' ? 'Premium API' : 'Local'}</Text>
              {effectiveEngine === 'local' && ` — ${LOCAL_VOICES.find(v => v.id === vcLocalId)?.label || vcLocalId}`}
              {effectiveEngine === 'api' && ` — ${vcApiProvider} / ${vcApiVoice}`}
            </Hint>

            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#10b981', marginTop: 12 }]}
              onPress={saveVoice}
            >
              <Text style={[styles.trainBtnText, { color: '#10b981' }]}>
                {vcSavedAt
                  ? `✅ Saved at ${new Date(vcSavedAt).toLocaleTimeString()}`
                  : '💾 Save voice settings'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.trainBtn, { borderColor: '#666', marginTop: 6 }]}
              onPress={resetToGlobal}
            >
              <Text style={[styles.trainBtnText, { color: '#888' }]}>
                🔄 Reset to global default
              </Text>
              <Text style={styles.trainBtnSub}>
                Clears the per-companion override for {companion.name}.
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }
}

// ── Inline UI helpers ──────────────────────────────────────
// (Lifted from SettingsScreen to keep this file self-contained.)

function SubTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.subGroupTitle}>{children}</Text>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

function WakePhrasePicker({
  companions,
  savedModels,
  activeCompanionId,
  onSelect,
  onRetrain,
  onDelete,
}: {
  companions: Companion[];
  savedModels: Record<string, { phrase: string; path: string; savedAt: number }>;
  activeCompanionId: string | null;
  onSelect: (companionId: string) => void;
  onRetrain: (companionId: string, phrase: string) => void;
  onDelete: (companionId: string) => void;
}) {
  const trainedRows = companions
    .filter(c => savedModels[c.id]?.phrase)
    .map(c => ({
      companionId: c.id,
      name: c.name,
      emoji: c.emoji || c.icon || '🐾',
      phrase: savedModels[c.id].phrase,
      savedAt: savedModels[c.id].savedAt,
    }));

  if (trainedRows.length === 0) {
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          No trained wake phrases yet. Tap "Train new wake phrase for {companions[0]?.name || 'this companion'}" below to record 6 samples.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.trainedPicker}>
      {trainedRows.map(r => {
        const active = activeCompanionId === r.companionId;
        return (
          <TouchableOpacity
            key={r.companionId}
            style={[styles.trainedPickerRow, active && styles.trainedPickerRowActive]}
            onPress={() => onSelect(r.companionId)}
          >
            <Text style={[styles.trainedPickerRadio, active && styles.trainedPickerRadioActive]}>
              {active ? '◉' : '◯'}
            </Text>
            <Text style={[styles.trainedPickerCompanionEmoji]}>{r.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.trainedPickerLabel, active && styles.trainedPickerLabelActive]}>
                {r.name}
              </Text>
              <Text style={styles.trainedPickerPhrase}>
                {r.phrase}
              </Text>
            </View>
            <View style={styles.trainedPickerActions}>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); onRetrain(r.companionId, r.phrase); }}
                style={styles.trainedPickerActionBtn}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Text style={styles.trainedPickerActionIcon}>🎙</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={(e) => { e.stopPropagation?.(); onDelete(r.companionId); }}
                style={styles.trainedPickerActionBtn}
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Text style={styles.trainedPickerActionIcon}>🗑</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        );
      })}
      {!activeCompanionId && trainedRows.length > 0 ? (
        <Text style={[styles.trainedPickerBadge, { marginTop: 6, alignSelf: 'flex-start' }]}>
          Tap a row to activate
        </Text>
      ) : null}
    </View>
  );
}

function PerCompanionExitPicker({ companionId, activePhrase, onSelect, onRetrain, onDelete }: {
  companionId: string;
  activePhrase: string;
  onSelect: (p: string) => void;
  onRetrain?: (p: string) => void;
  onDelete?: (p: string) => void;
}) {
  const [phrases, setPhrases] = useState<string[]>([]);
  const reload = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const prefix = `cyberclaw-exit-samples-${companionId}-`;
      const exitKeys = keys.filter(k => k.startsWith(prefix));
      const list = exitKeys.map(k =>
        k.replace(prefix, '').replace(/-/g, ' ')
      );
      setPhrases(list);
    } catch (_) {}
  }, [companionId]);
  useEffect(() => { reload(); }, [reload, activePhrase]);

  if (phrases.length === 0) {
    return (
      <View style={styles.trainedPickerHint}>
        <Text style={{ color: '#888', fontSize: 12, fontStyle: 'italic' }}>
          No trained exit phrases yet. Tap "Train new exit phrase" below to record 6 samples.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.trainedPicker}>
      {phrases.map(p => {
        const active = activePhrase === p;
        return (
          <TouchableOpacity
            key={p}
            style={[styles.trainedPickerRow, active && styles.trainedPickerRowActive]}
            onPress={() => onSelect(p)}
          >
            <Text style={[styles.trainedPickerRadio, active && styles.trainedPickerRadioActive]}>
              {active ? '◉' : '◯'}
            </Text>
            <Text style={[styles.trainedPickerLabel, active && styles.trainedPickerLabelActive]}>
              {p}
            </Text>
            <View style={styles.trainedPickerActions}>
              {onRetrain ? (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); onRetrain(p); }}
                  style={styles.trainedPickerActionBtn}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Text style={styles.trainedPickerActionIcon}>🎙</Text>
                </TouchableOpacity>
              ) : null}
              {onDelete ? (
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation?.(); onDelete(p); }}
                  style={styles.trainedPickerActionBtn}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Text style={styles.trainedPickerActionIcon}>🗑</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  // v3.4.5: bumped paddingTop from 16 → 50 on BOTH Android
  // and iOS. Tobe's screenshot showed the section still
  // flush against the status bar even after the first
  // bump — the device was actually an iPhone (Dynamic
  // Island in the status bar) so the iOS=10 path was
  // insufficient. 50pt clears both Android status bars
  // (~30-40dp) and iOS Dynamic Island (~30pt + safe area).
  // SafeAreaView in App.tsx handles the iOS bottom inset
  // but the ScrollView still needs explicit top padding
  // because the SafeAreaView's top extends to the top of
  // the device edge — we want the scroll to start below
  // the status bar.
  scroll: { padding: 16, paddingTop: 50, paddingBottom: 60 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, paddingTop: Platform.OS === 'android' ? 34 : 10 },
  backBtn: { paddingVertical: 4, paddingRight: 12 },
  backBtnText: { color: '#f7931a', fontSize: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginLeft: 16 },
  section: { backgroundColor: '#111', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#f7931a' },
  sectionTitle: { color: '#f7931a', fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  sectionDesc: { color: '#888', fontSize: 13, marginBottom: 16, lineHeight: 18 },
  subGroupTitle: { color: '#aaa', fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12, letterSpacing: 0.5 },
  hint: { color: '#666', fontSize: 12, marginTop: 4, marginBottom: 8, lineHeight: 16 },
  savedHint: { color: '#4caf50', fontSize: 12, marginTop: 6 },
  input: { backgroundColor: '#1a1a2e', color: '#e0e0e0', borderRadius: 8, padding: 12, fontSize: 16, borderWidth: 1, borderColor: '#333' },
  trainedPicker: { marginTop: 8 },
  trainedPickerHint: { marginTop: 8, paddingVertical: 8 },
  trainedPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    marginBottom: 6,
  },
  trainedPickerRowActive: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: '#10b981',
  },
  trainedPickerRadio: { color: '#666', fontSize: 18, marginRight: 10 },
  trainedPickerRadioActive: { color: '#10b981' },
  trainedPickerLabel: { color: '#fff', fontSize: 14, flex: 1 },
  trainedPickerLabelActive: { fontWeight: '700' },
  trainedPickerBadge: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(16,185,129,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  trainedPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 4,
  },
  trainedPickerActionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(247,147,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.30)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  trainedPickerActionIcon: { fontSize: 16 },
  trainedPickerCompanionEmoji: { fontSize: 22, marginRight: 10 },
  trainedPickerPhrase: { color: '#aaa', fontSize: 12, marginTop: 1, fontStyle: 'italic' },
  phaseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1626',
    borderRadius: 12,
    borderWidth: 2,
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginVertical: 6,
    gap: 12,
  },
  phaseCardEmoji: { fontSize: 28 },
  phaseCardTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  phaseCardSub: { color: '#9aa0b4', fontSize: 12, marginTop: 3 },
  phaseCardArrow: { color: '#888', fontSize: 24, marginLeft: 4 },
  detailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  detailBackBtn: { paddingVertical: 4, paddingRight: 12 },
  detailBackBtnText: { color: '#f7931a', fontSize: 16 },
  detailHeader: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  trainBtn: {
    borderWidth: 2,
    borderRadius: 12,
    borderStyle: 'dashed',
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: 'transparent',
  },
  trainBtnText: { fontSize: 15, fontWeight: '600' },
  trainBtnSub: { color: '#888', fontSize: 11, marginTop: 4 },
  // v3.7.0: radio-style row for the per-companion voice picker.
  // Reused for engine (Use global default / Local / Premium API)
  // and for the voice lists under each engine.
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1626',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#222',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginVertical: 3,
    gap: 10,
  },
  radioRowActive: { borderColor: '#10b981', backgroundColor: '#102a22' },
  radioBullet: { color: '#10b981', fontSize: 18, width: 18, textAlign: 'center' },
  radioTitle: { color: '#fff', fontSize: 15, fontWeight: '500' },
  radioSub: { color: '#9aa0b4', fontSize: 12, marginTop: 2 },
});