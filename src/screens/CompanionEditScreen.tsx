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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
// v3.10.93: shared Slider matches the desktop's native
// <input type="range">. PanResponder-driven drag + tap.
import Slider from '../components/Slider';
// v3.10.93: bundled sprite catalog (5 sprites, mirrors the
// desktop's src/assets/companions/catalog.json). We strip the
// animation frames + file paths on the mobile — the icon is
// all the user needs to make a choice. The full catalog is
// loaded from disk on the desktop; the mobile ships a
// hand-curated subset because the assets themselves aren't
// needed for the picker (only the metadata).
import spriteCatalog from '../data/companion-catalog.json';

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
  // v3.10.93: sprite picker state. pixelCompanionId
  // matches the desktop's catalog id (fox, boar, deer, hare,
  // black_grouse). Bundle icons with the catalog so the
  // picker renders without a separate icon asset fetch.
  const [pixelCompanionId, setPixelCompanionId] = useState<string>('boar');
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
  // v3.10.93: safe-area insets so the header doesn't sit
  // under the status bar (Tobe's v3.10.92 feedback). Used
  // for paddingTop on the page container + the toast's
  // bottom inset.
  const insets = useSafeAreaInsets();

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
          // v3.10.93: sprite id is included in the agents_list
          // broadcast as `sprite`. Hydrate the picker so the
          // currently-selected sprite is visually obvious.
          if (typeof a.sprite === 'string' && a.sprite) setPixelCompanionId(a.sprite);
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
          // v3.10.93: pixelCompanionId is the sprite id. The
          // local cache is the only source of truth on the
          // mobile — the sprite isn't synced via agents_list
          // (only the icon is). Fall back to the agents_list
          // value (already set above) if the local cache
          // doesn't have it.
          if (typeof local.pixelCompanionId === 'string' && local.pixelCompanionId) setPixelCompanionId(local.pixelCompanionId);
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
      // v3.10.93: pixelCompanionId is the sprite id. The
      // desktop's saveSpriteConfig accepts this as is;
      // sprite_config_sync's whitelist (in sync-server.js)
      // includes pixelCompanionId. The desktop's
      // mobile-sprite-config-saved handler regenerates the
      // avatar if the sprite changed.
      pixelCompanionId: pixelCompanionId,
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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 64 }]}>
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

        {/* v3.10.93: sprite picker. Mirrors the desktop's
            Companion Forge "🔄 Change Companion" picker. The
            catalog is bundled with the mobile app (5 sprites,
            matches the desktop's catalog.json). The currently
            selected sprite has a gold border + background tint
            so the user can see what's selected at a glance
            (Tobe's v3.10.92 feedback: "i dont see which ones is
            already selected"). Tapping a sprite card selects
            it immediately; the Save button persists to the
            desktop. */}
        <Section title="🐾 Sprite">
          <Text style={styles.sectionHint}>Pick the sprite for {companionName}. The currently selected one is highlighted.</Text>
          <View style={styles.spriteGrid}>
            {(spriteCatalog as any).companions.map((c: any) => {
              const active = pixelCompanionId === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.spriteCard, active && styles.spriteCardActive]}
                  onPress={() => setPixelCompanionId(c.id)}
                  disabled={saving}
                >
                  <Text style={styles.spriteIcon}>{c.icon}</Text>
                  <Text style={[styles.spriteLabel, active && styles.spriteLabelActive]}>{c.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        {/* Scale — v3.10.93: single horizontal slider matching the
            desktop's <input type="range">. Tobe's v3.10.92
            feedback: "we dont need 2 ways of up and down for the
            scaling". The +/- buttons are gone; the slider is
            draggable AND tappable (just like the desktop). */}
        <Section title="📐 Size">
          <Slider
            min={1}
            max={8}
            step={1}
            value={scale}
            onChange={(v) => setScale(v)}
            disabled={saving}
            label="Scale"
            showValue={`${scale}×`}
          />
          <Text style={styles.sliderHint}>Bigger number = larger sprite in the arena.</Text>
        </Section>

        {/* v3.10.93: chattiness — single slider like the
            desktop. The 1–5 tappable scale row is gone (it's
            the "2 ways of up and down" Tobe flagged). Live
            description below mirrors the desktop's
            CHATTINESS_DESCRIPTIONS. */}
        <Section title="💬 Chattiness">
          <Slider
            min={1}
            max={5}
            step={1}
            value={chattiness}
            onChange={(v) => setChattiness(v)}
            disabled={saving}
            label="How chatty"
            showValue={`${chattiness}/5`}
          />
          <Text style={styles.sliderHint}>{CHATTINESS_DESCRIPTIONS[chattiness as 1|2|3|4|5] || CHATTINESS_DESCRIPTIONS[3]}</Text>
        </Section>

        {/* v3.10.93: traits. The checkbox icon + tinted
            background make selected state obvious (Tobe's
            v3.10.92 feedback: "i dont see which ones is
            already selected"). Mirror the desktop's trait
            row layout: checkbox on the left, label + desc on
            the right. Multiple traits can be selected at
            once (the desktop forge's checkbox array). */}
        <Section title="🎭 Behaviour Traits">
          <Text style={styles.sectionHint}>Pick the traits that fit this companion. Multiple selections allowed.</Text>
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
                  <Text style={[styles.traitBox, active && styles.traitBoxActive]}>{active ? '☑' : '☐'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.traitLabel, active && styles.traitLabelActive]}>{t.label}</Text>
                    <Text style={styles.traitDesc}>{t.desc}</Text>
                  </View>
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
    // paddingBottom is set inline (insets.bottom + 64)
    // so the scroll extends below the home indicator on
    // iPhones with notches.
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
  sliderHint: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    marginTop: 8,
  },
  // v3.10.93: sprite picker grid. Cards are 5 across
  // (the catalog has 5 sprites) with a gold border +
  // background tint for the selected one. Tight 6px gap
  // keeps the row compact; the icon is 32px so even
  // small phones can show it.
  spriteGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  spriteCard: {
    width: 64,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
    alignItems: 'center',
  },
  spriteCardActive: {
    borderColor: '#fbbf24',
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    shadowColor: '#fbbf24',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
  },
  spriteIcon: {
    fontSize: 28,
    marginBottom: 2,
  },
  spriteLabel: {
    color: '#888',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  spriteLabelActive: {
    color: '#fbbf24',
  },
  // v3.10.93: dark base for the empty checkbox icon.
  // The active state (☑) is rendered in the same color
  // as the active border so the checkbox visually ties
  // to the selected state.
  traitBox: {
    fontSize: 18,
    color: '#555',
    marginRight: 10,
    marginTop: 1,
  },
  traitBoxActive: {
    color: '#f7931a',
  },
  traitsGrid: {
    gap: 6,
  },
  // v3.10.93: trait row is a flex-row with a checkbox on
  // the left and label+desc on the right. Mirrors the
  // desktop's .trait-toggle layout (flex, align-items:
  // flex-start, gap: 8).
  traitToggle: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
  },
  traitToggleActive: {
    backgroundColor: 'rgba(247, 147, 26, 0.18)',
    borderColor: '#f7931a',
  },
  traitLabel: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  // v3.10.93: active trait label turns orange (matches
  // the desktop's .trait-toggle input[type=checkbox]:checked
  // ~ .trait-label rule).
  traitLabelActive: {
    color: '#f7931a',
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
