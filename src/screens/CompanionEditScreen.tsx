/**
 * CompanionEditScreen — phone-side companion Personalize screen.
 *
 * v3.10.92: mirrors the desktop Companion Forge (v3.2.26)
 * for the fields the mobile can edit. The mobile currently
 * surfaces:
 *   - Name (customName)
 *   - Scale (1–8)
 *   - Traits (9 checkboxes matching the desktop set)
 *   - Primary / Secondary model
 *   - Chattiness (1–5)
 *
 * The sprite picker (pixelCompanionId) is intentionally NOT
 * here — the desktop forge is the source of truth for sprite
 * swaps because the sprite catalog is bundled with the desktop
 * and regenerating the avatar on the phone would require
 * shipping the same PNG atlas on both. The Settings →
 * Companions list shows the Edit button as the desktop forge
 * entry point for sprite changes; the Personalize screen on
 * mobile complements that for everything else.
 *
 * Reached via App.tsx as the 'companion-edit' route with a
 * companionId prop. Back button → returns to the previous
 * route (CompanionSettingsScreen → Settings, or HomeScreen's
 * Settings button).
 *
 * The save flow:
 *   1. Store partial patch in state
 *   2. Tap Save → send sprite_config_sync via SyncClient
 *   3. Listen for sprite_config_sync_ok → toast + go back
 *   4. Listen for sprite_config_sync_failed → toast + stay
 *   5. The next agents_list broadcast (triggered by the
 *      desktop's mobile-sprite-config-saved handler) updates
 *      the in-memory cache so the Settings list reflects the
 *      new chattiness / scale / name.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';

// v3.10.92: trait list mirrors the desktop forge's
// #forge-traits-grid. The id is the bare trait key (no prefix),
// which matches what the desktop's saveSpriteConfig expects in
// the `traits` array (see getCheckedTraits() in src/js/app.js,
// which uses cb.id.replace('trait-', '')).
const TRAITS = [
  { id: 'sassy', label: '😏 Sassy', desc: 'Witty comebacks and attitude' },
  { id: 'curious', label: '🔍 Curious', desc: 'Asks questions and digs deeper' },
  { id: 'lazy', label: '😴 Lazy', desc: 'Reluctant, easily distracted' },
  { id: 'cheerful', label: '🌟 Cheerful', desc: 'Upbeat and encouraging' },
  { id: 'foodobsessed', label: '🍖 Food-obsessed', desc: 'Always thinking about snacks' },
  { id: 'dramatic', label: '🎭 Dramatic', desc: 'Makes everything a big deal' },
  { id: 'stoic', label: '🗿 Stoic', desc: 'Calm, dry, matter-of-fact' },
  { id: 'adventurous', label: '⚔️ Adventurous', desc: 'Always wants to go on quests' },
  { id: 'goblin', label: '👺 Goblin', desc: 'Angry smartass, curses freely' },
];

// v3.10.92: chattiness descriptions mirror the desktop's
// CHATTINESS_DESCRIPTIONS table in src/js/app.js. Keeping
// these in sync is important — the user sees one number +
// description on each surface; if they drift, the screens
// disagree about what the value means.
const CHATTINESS_DESCRIPTIONS = {
  1: 'Silent — never randomly comments.',
  2: 'Quiet — comments every 3–6 hours.',
  3: 'Balanced — comments every 60–90 minutes.',
  4: 'Chatty — comments every 30–60 minutes.',
  5: 'Very chatty — comments every 15–30 minutes.',
};

// v3.10.92: model list. Hard-coded to match the desktop's
// forge-model-primary optgroups (Anthropic, OpenAI, Google,
// Local). The desktop uses the same list; the mobile doesn't
// ship with the same provider catalog so we offer a curated
// set. The desktop's saveSpriteConfig accepts any model
// string, so adding a custom model is supported via the
// "Custom model" option below.
const MODEL_OPTIONS = [
  { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-haiku-3.5', label: 'Claude Haiku 3.5' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'ollama/llama3', label: 'Ollama — Llama 3' },
];

export default function CompanionEditScreen({
  companionId,
  companionName,
  initialEmoji,
  onBack,
}: {
  companionId: string;
  companionName: string;
  initialEmoji?: string | null;
  onBack: () => void;
}) {
  const [name, setName] = useState(companionName || '');
  const [scale, setScale] = useState<number>(4);
  const [traits, setTraits] = useState<Set<string>>(new Set());
  const [primaryModel, setPrimaryModel] = useState<string>('');
  const [secondaryModel, setSecondaryModel] = useState<string>('');
  // v3.10.92: chattiness is the headline new feature. Default
  // 3 if the companion has no value yet (legacy companion).
  const [chattiness, setChattiness] = useState<number>(3);
  const [customModel, setCustomModel] = useState<string>('');
  const [useCustomModel, setUseCustomModel] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const hydratedRef = useRef<boolean>(false);

  // v3.10.92: hydrate from the local AsyncStorage cache
  // AND the latest agents_list broadcast. The cache is the
  // single source of truth on the mobile side — `agents_list`
  // writes to it on every broadcast, so we just read it back.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-agents-cache');
        if (cancelled) return;
        const arr = raw ? JSON.parse(raw) : [];
        const a = Array.isArray(arr) ? arr.find((x: any) => x.id === companionId) : null;
        if (a) {
          if (a.name) setName(a.name);
          if (typeof a.scale === 'number') setScale(a.scale);
          if (typeof a.chattiness === 'number') {
            const ch = Math.max(1, Math.min(5, a.chattiness));
            setChattiness(ch);
          }
        }
        // v3.10.92: the agents_list payload doesn't include
        // traits/primaryModel/secondaryModel (only the chattiness
        // we just added). For those, we have to read from the
        // desktop's sprite config via a follow-up request —
        // the desktop doesn't expose a sprite-config getter
        // over WS yet, so we fall back to the local custom
        // persist (saved on every Save). If we never saved,
        // default to baseline.
        const localRaw = await AsyncStorage.getItem(`cyberclaw-companion-edit-${companionId}`);
        if (cancelled) return;
        if (localRaw) {
          const local = JSON.parse(localRaw);
          if (Array.isArray(local.traits)) setTraits(new Set(local.traits));
          if (typeof local.primaryModel === 'string') setPrimaryModel(local.primaryModel);
          if (typeof local.secondaryModel === 'string') setSecondaryModel(local.secondaryModel);
          if (typeof local.scale === 'number') setScale(local.scale);
          if (typeof local.chattiness === 'number') setChattiness(local.chattiness);
          if (typeof local.customName === 'string' && local.customName) setName(local.customName);
        }
        setHydrated(true);
        hydratedRef.current = true;
      } catch (e: any) {
        console.warn('[CompanionEdit] hydrate failed:', e?.message);
        setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [companionId]);

  // v3.10.92: listen for sprite_config_sync_ok / _failed to
  // surface the result. We also pick up the agents_list update
  // automatically via the existing SetAgents hook in the
  // parent screen.
  useEffect(() => {
    const onOk = (msg: any) => {
      if (msg.agentId !== companionId) return;
      setSaving(false);
      setSavedAt(Date.now());
      // The cache write also happens on the next agents_list
      // broadcast (SyncServer re-broadcasts after every save).
      // Show a brief toast-like banner.
      setBanner({ kind: 'ok', text: 'Saved!' });
    };
    const onFail = (msg: any) => {
      if (msg.agentId !== companionId) return;
      setSaving(false);
      setBanner({ kind: 'err', text: `Couldn't save: ${msg.error || msg.reason || 'unknown error'}` });
    };
    syncClient.on('sprite_config_sync_ok', onOk);
    syncClient.on('sprite_config_sync_failed', onFail);
    return () => {
      syncClient.off?.('sprite_config_sync_ok', onOk);
      syncClient.off?.('sprite_config_sync_failed', onFail);
    };
  }, [companionId]);

  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3000);
    return () => clearTimeout(t);
  }, [banner]);

  const toggleTrait = useCallback((id: string) => {
    setTraits(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSave = useCallback(async () => {
    if (saving) return;
    if (!hydrated) return;
    setSaving(true);
    setBanner(null);
    const effectivePrimary = useCustomModel ? customModel.trim() : primaryModel;
    const patch = {
      customName: name.trim() || undefined,
      scale: Math.max(1, Math.min(8, scale)),
      traits: Array.from(traits),
      chattiness: Math.max(1, Math.min(5, chattiness)),
      primaryModel: effectivePrimary || '',
      secondaryModel: secondaryModel || '',
    };
    try {
      // Persist locally first so the next mount of this
      // screen has the values (no round-trip to desktop
      // required for display). The desktop is the source of
      // truth via the WS broadcast, but local persistence
      // makes the UI feel instant on remount.
      await AsyncStorage.setItem(
        `cyberclaw-companion-edit-${companionId}`,
        JSON.stringify(patch),
      );
    } catch (e: any) {
      console.warn('[CompanionEdit] local save failed:', e?.message);
    }
    try {
      syncClient.setSpriteConfig(companionId, patch);
    } catch (e: any) {
      setSaving(false);
      setBanner({ kind: 'err', text: `Couldn't send: ${e?.message || 'unknown'}` });
      return;
    }
    // Optimistic: assume success after 5s if no ack. The
    // desktop's sprite_config_sync_ok arrives within ~100ms
    // for happy path; the fallback is for the (rare) case
    // the WS is briefly disconnected.
    setTimeout(() => {
      setSaving((cur) => {
        if (cur) {
          setBanner({ kind: 'err', text: 'No response from desktop. Check connection.' });
        }
        return false;
      });
    }, 5000);
  }, [companionId, name, scale, traits, chattiness, primaryModel, secondaryModel, customModel, useCustomModel, saving, hydrated]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.header}>
            {initialEmoji || '🐾'}  Edit {companionName}
          </Text>
          <View style={{ width: 60 }} />
        </View>

        {!hydrated ? (
          <Text style={styles.loadingHint}>Loading…</Text>
        ) : null}

        {/* Name */}
        <Section title="📛 Name">
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Companion name"
            placeholderTextColor="#666"
            editable={!saving}
          />
        </Section>

        {/* Scale */}
        <Section title="📐 Size">
          <View style={styles.sliderRow}>
            <Text style={styles.sliderLabel}>Scale <Text style={styles.sliderValue}>{scale}×</Text></Text>
            <View style={styles.sliderWrap}>
              <TouchableOpacity
                style={[styles.sliderBtn, scale <= 1 && styles.sliderBtnDisabled]}
                onPress={() => setScale(Math.max(1, scale - 1))}
                disabled={saving || scale <= 1}
              >
                <Text style={styles.sliderBtnText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.sliderScaleText}>{scale}</Text>
              <TouchableOpacity
                style={[styles.sliderBtn, scale >= 8 && styles.sliderBtnDisabled]}
                onPress={() => setScale(Math.min(8, scale + 1))}
                disabled={saving || scale >= 8}
              >
                <Text style={styles.sliderBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.sliderHint}>Bigger number = larger sprite in the arena.</Text>
        </Section>

        {/* v3.10.92: chattiness — the headline new feature. */}
        <Section title="💬 Chattiness">
          <View style={styles.sliderRow}>
            <Text style={styles.sliderLabel}>How chatty <Text style={styles.sliderValue}>{chattiness}/5</Text></Text>
            <View style={styles.sliderWrap}>
              <TouchableOpacity
                style={[styles.sliderBtn, chattiness <= 1 && styles.sliderBtnDisabled]}
                onPress={() => setChattiness(Math.max(1, chattiness - 1))}
                disabled={saving || chattiness <= 1}
              >
                <Text style={styles.sliderBtnText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.sliderScaleText}>{chattiness}</Text>
              <TouchableOpacity
                style={[styles.sliderBtn, chattiness >= 5 && styles.sliderBtnDisabled]}
                onPress={() => setChattiness(Math.min(5, chattiness + 1))}
                disabled={saving || chattiness >= 5}
              >
                <Text style={styles.sliderBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.sliderHint}>{CHATTINESS_DESCRIPTIONS[chattiness as 1|2|3|4|5] || CHATTINESS_DESCRIPTIONS[3]}</Text>
          <View style={styles.chattinessScale}>
            {[1, 2, 3, 4, 5].map(n => (
              <TouchableOpacity
                key={n}
                style={[styles.chattinessStep, chattiness === n && styles.chattinessStepActive]}
                onPress={() => setChattiness(n)}
                disabled={saving}
              >
                <Text style={[styles.chattinessStepText, chattiness === n && styles.chattinessStepTextActive]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Section>

        {/* Traits */}
        <Section title="🎭 Behaviour Traits">
          <Text style={styles.sectionHint}>Pick the traits that fit this companion.</Text>
          <View style={styles.traitsGrid}>
            {TRAITS.map(t => {
              const active = traits.has(t.id);
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[styles.traitToggle, active && styles.traitToggleActive]}
                  onPress={() => toggleTrait(t.id)}
                  disabled={saving}
                >
                  <Text style={styles.traitLabel}>{t.label}</Text>
                  <Text style={styles.traitDesc}>{t.desc}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        {/* Models */}
        <Section title="🧠 Models">
          <Text style={styles.sectionHint}>Pick the primary model. Secondary is a fallback for transient errors.</Text>
          <ModelPicker
            label="Primary"
            value={primaryModel}
            onChange={setPrimaryModel}
            customModel={customModel}
            onCustomModelChange={setCustomModel}
            useCustomModel={useCustomModel}
            onUseCustomModelChange={setUseCustomModel}
            disabled={saving}
          />
          <View style={{ height: 8 }} />
          <ModelPicker
            label="Secondary"
            value={secondaryModel}
            onChange={setSecondaryModel}
            customModel=""
            onCustomModelChange={() => {}}
            useCustomModel={false}
            onUseCustomModelChange={() => {}}
            disabled={saving}
            optional
          />
        </Section>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.saveBtn, (saving || !hydrated) && styles.saveBtnDisabled]}
            onPress={onSave}
            disabled={saving || !hydrated}
          >
            <Text style={styles.saveBtnText}>{saving ? 'Saving…' : '💾 Save'}</Text>
          </TouchableOpacity>
          {savedAt && !saving && !banner ? (
            <Text style={styles.savedHint}>Saved {formatTime(savedAt)}</Text>
          ) : null}
        </View>
      </ScrollView>

      {banner ? (
        <View style={[styles.toast, banner.kind === 'err' ? styles.toastErr : styles.toastOk]}>
          <Text style={styles.toastText}>{banner.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ModelPicker({
  label, value, onChange, customModel, onCustomModelChange,
  useCustomModel, onUseCustomModelChange, disabled, optional,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  customModel: string;
  onCustomModelChange: (v: string) => void;
  useCustomModel: boolean;
  onUseCustomModelChange: (v: boolean) => void;
  disabled?: boolean;
  optional?: boolean;
}) {
  return (
    <View style={styles.modelPicker}>
      <Text style={styles.modelLabel}>{label}</Text>
      <View style={styles.modelOptions}>
        {optional && (
          <TouchableOpacity
            style={[styles.modelChip, !value && !useCustomModel && styles.modelChipActive]}
            onPress={() => { onChange(''); onUseCustomModelChange(false); }}
            disabled={disabled}
          >
            <Text style={[styles.modelChipText, !value && !useCustomModel && styles.modelChipTextActive]}>None</Text>
          </TouchableOpacity>
        )}
        {MODEL_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.modelChip, value === opt.value && !useCustomModel && styles.modelChipActive]}
            onPress={() => { onChange(opt.value); onUseCustomModelChange(false); }}
            disabled={disabled}
          >
            <Text style={[styles.modelChipText, value === opt.value && !useCustomModel && styles.modelChipTextActive]}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.modelChip, styles.modelChipCustom, useCustomModel && styles.modelChipActive]}
          onPress={() => onUseCustomModelChange(!useCustomModel)}
          disabled={disabled}
        >
          <Text style={[styles.modelChipText, useCustomModel && styles.modelChipTextActive]}>Custom</Text>
        </TouchableOpacity>
      </View>
      {useCustomModel ? (
        <TextInput
          style={styles.input}
          value={customModel}
          onChangeText={onCustomModelChange}
          placeholder="provider/model-name"
          placeholderTextColor="#666"
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}
    </View>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a1a',
  },
  scroll: {
    padding: 16,
    paddingBottom: 64,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  backBtn: {
    padding: 8,
  },
  backBtnText: {
    color: '#f7931a',
    fontSize: 14,
    fontWeight: '600',
  },
  header: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
    flex: 1,
    textAlign: 'center',
  },
  loadingHint: {
    color: '#888',
    fontStyle: 'italic',
    textAlign: 'center',
    padding: 24,
  },
  section: {
    backgroundColor: '#13132a',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2a2a3f',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f7931a',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHint: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 14,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sliderLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  sliderValue: {
    color: '#f7931a',
  },
  sliderWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sliderBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f7931a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sliderBtnDisabled: {
    backgroundColor: '#3a3a55',
  },
  sliderBtnText: {
    color: '#0a0a1a',
    fontSize: 18,
    fontWeight: '700',
  },
  sliderScaleText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    minWidth: 24,
    textAlign: 'center',
  },
  sliderHint: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    marginTop: 4,
  },
  chattinessScale: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  chattinessStep: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
    alignItems: 'center',
  },
  chattinessStepActive: {
    backgroundColor: '#f7931a',
    borderColor: '#f7931a',
  },
  chattinessStepText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  chattinessStepTextActive: {
    color: '#0a0a1a',
  },
  traitsGrid: {
    gap: 6,
  },
  traitToggle: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
  },
  traitToggleActive: {
    backgroundColor: 'rgba(247, 147, 26, 0.15)',
    borderColor: '#f7931a',
  },
  traitLabel: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  traitDesc: {
    color: '#888',
    fontSize: 11,
    marginTop: 2,
  },
  modelPicker: {
    marginBottom: 4,
  },
  modelLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  modelOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  modelChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
  },
  modelChipActive: {
    backgroundColor: '#f7931a',
    borderColor: '#f7931a',
  },
  modelChipCustom: {
    borderStyle: 'dashed',
  },
  modelChipText: {
    color: '#fff',
    fontSize: 12,
  },
  modelChipTextActive: {
    color: '#0a0a1a',
    fontWeight: '700',
  },
  footer: {
    marginTop: 20,
    alignItems: 'center',
    gap: 8,
  },
  saveBtn: {
    backgroundColor: '#f7931a',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    backgroundColor: '#3a3a55',
  },
  saveBtnText: {
    color: '#0a0a1a',
    fontSize: 16,
    fontWeight: '700',
  },
  savedHint: {
    color: '#10b981',
    fontSize: 12,
    fontStyle: 'italic',
  },
  toast: {
    position: 'absolute',
    bottom: 32,
    left: 16,
    right: 16,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  toastOk: {
    backgroundColor: 'rgba(16, 185, 129, 0.95)',
  },
  toastErr: {
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
  },
  toastText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
});
