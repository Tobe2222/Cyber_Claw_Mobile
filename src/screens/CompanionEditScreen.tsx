/** CompanionEditScreen — phone-side companion Personalize screen. */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';
// Live WebView preview at the top of the Looks editor.
import { WebView } from 'react-native-webview';
// Native Picker for the sprite dropdown.
import { Picker } from '@react-native-picker/picker';
// v3.10.93: shared Slider matches the desktop's native
// <input type="range">. PanResponder-driven drag + tap.
import Slider from '../components/Slider';
// Bundled sprite catalog (5 sprites, mirrors the desktop's src/assets/companions/catalog.json).
import spriteCatalog from '../data/companion-catalog.json';

// Trait list mirrors the desktop forge's #forge-traits-grid.
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

// Chattiness descriptions mirror the desktop's CHATTINESS_DESCRIPTIONS table in src/js/app.js.
const CHATTINESS_DESCRIPTIONS = {
  1: 'Silent — never randomly comments.',
  2: 'Quiet — comments every 3–6 hours.',
  3: 'Balanced — comments every 60–90 minutes.',
  4: 'Chatty — comments every 30–60 minutes.',
  5: 'Very chatty — comments every 15–30 minutes.',
};

// Model catalog.
const MODEL_DEFAULT_NONE = '__cyberclaw_no_model__';
const PROVIDERS_CURATED = [
  { id: '',              label: '— Choose a provider —' },
  { id: 'anthropic',     label: '🅰️  Anthropic',     keyEnv: 'ANTHROPIC_API_KEY',  placeholder: 'claude-opus-4-8' },
  { id: 'openai',        label: '🅾️  OpenAI',        keyEnv: 'OPENAI_API_KEY',     placeholder: 'gpt-5.5' },
  { id: 'google',        label: '🇬  Google',         keyEnv: 'GOOGLE_API_KEY',     placeholder: 'gemini-2.5-pro' },
  { id: 'minimax',       label: '🐱  MiniMax',        keyEnv: 'MINIMAX_API_KEY',    placeholder: 'MiniMax-M3' },
  { id: 'openrouter',    label: '🌐  OpenRouter',     keyEnv: 'OPENROUTER_API_KEY', placeholder: 'anthropic/claude-sonnet-4-6' },
  { id: 'mistral',       label: '🌫️  Mistral',        keyEnv: 'MISTRAL_API_KEY',    placeholder: 'mistral-large-latest' },
  { id: 'groq',          label: '⚡  Groq',           keyEnv: 'GROQ_API_KEY',       placeholder: 'llama-3.3-70b-versatile' },
  { id: 'custom',        label: '🛠️  Custom',         keyEnv: '',                   placeholder: 'my-model-id' },
];
// Local provider list (self-hosted / private runtimes).
const PROVIDERS_LOCAL = [
  { id: '',          label: '— Choose a local runtime —' },
  { id: 'ollama',    label: '🦙 Ollama',     placeholder: 'llama3' },
  { id: 'lmstudio',  label: '🎛️ LM Studio',   placeholder: 'local-model' },
  { id: 'llamacpp',  label: '⚙️ llama.cpp',   placeholder: 'local-model' },
  { id: 'vllm',      label: '🚀 vLLM',       placeholder: 'local-model' },
];
// Kept for backward-compat with the Models card's local-dot rendering in CompanionSettingsScreen.
const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
function isLocalModel(modelStr: string): boolean {
  if (!modelStr) return false;
  const idx = modelStr.indexOf('/');
  if (idx < 0) return false;
  return LOCAL_PROVIDER_IDS.has(modelStr.slice(0, idx).toLowerCase());
}

// Arena.html asset cache-buster for the Looks editor's live preview WebView.
const LOOKS_ARENA_HTML_VERSION = '3.10.187';

// Wire-format helpers.
function splitModelRef(modelStr: string): { provider: string; modelId: string } {
  if (!modelStr) return { provider: '', modelId: '' };
  const idx = modelStr.indexOf('/');
  if (idx < 0) return { provider: '', modelId: modelStr };
  return { provider: modelStr.slice(0, idx), modelId: modelStr.slice(idx + 1) };
}
function composeModelRef(provider: string, modelId: string): string {
  const p = (provider || '').trim();
  const m = (modelId || '').trim();
  if (!m) return '';
  if (!p) return m; // bare id (no provider) — let the desktop fall through to its default
  return p + '/' + m;
}

// Model list removed from the mobile (Tobe: "We can remove LLM options on the mobile end, that can be desktop only").

export default function CompanionEditScreen({
  companionId,
  companionName,
  initialEmoji,
  onBack,
  // Mode selects which section group this screen instance shows.
  mode = 'behaviour',
}: {
  companionId: string;
  companionName: string;
  initialEmoji?: string | null;
  onBack: () => void;
  mode?: 'looks' | 'behaviour' | 'models';
}) {
  const [name, setName] = useState(companionName || '');
  const [scale, setScale] = useState<number>(4);
  // Sprite picker state.
  const [pixelCompanionId, setPixelCompanionId] = useState<string>('boar');
  const [traits, setTraits] = useState<Set<string>>(new Set());
  // v3.10.92: chattiness is the headline new feature. Default
  // 3 if the companion has no value yet (legacy companion).
  const [chattiness, setChattiness] = useState<number>(3);
  // Model selection state.
  const [primaryProvider, setPrimaryProvider] = useState<string>('');
  const [primaryModelId, setPrimaryModelId] = useState<string>('');
  const [primaryApiKey, setPrimaryApiKey] = useState<string>('');
  // No more Save button — edits apply instantly to local state, persist to AsyncStorage on every change, and ship to the desktop on unmount…
  const [hydrated, setHydrated] = useState<boolean>(false);
  const hydratedRef = useRef<boolean>(false);
  // Track the latest patch values via refs so the unmount cleanup can read the freshest values without re-running the cleanup effect on every…
  const nameRef = useRef<string>('');
  const scaleRef = useRef<number>(4);
  const pixelCompanionIdRef = useRef<string>('boar');
  const traitsRef = useRef<Set<string>>(new Set());
  const chattinessRef = useRef<number>(3);
  // Model selection refs.
  const primaryProviderRef = useRef<string>('');
  const primaryModelIdRef = useRef<string>('');
  const primaryApiKeyRef = useRef<string>('');
  // Guard so we only auto-save to the desktop once per
  // mount. Subsequent state changes inside the same mount
  // only persist locally (no desktop spam).
  const autoSavedRef = useRef<boolean>(false);
  // WebView ref + arena-ready flag for the live Looks preview.
  const previewWebViewRef = useRef<WebView>(null);
  const [previewReady, setPreviewReady] = useState<boolean>(false);
  // Soul + memory are read-only on mobile.
  const [soulContent, setSoulContent] = useState<string>('');
  const [soulLoading, setSoulLoading] = useState<boolean>(true);
  const [memoryContent, setMemoryContent] = useState<string>('');
  const [memoryLoading, setMemoryLoading] = useState<boolean>(true);
  const [clearingMemory, setClearingMemory] = useState<boolean>(false);
  // Safe-area insets so the header doesn't sit under the status bar (Tobe's v3.10.92 feedback).
  const insets = useSafeAreaInsets();

  // Mirror state into refs so the unmount cleanup (and the local-persist effect below) can read the freshest values without re-running the…
  useEffect(() => { nameRef.current = name; }, [name]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { pixelCompanionIdRef.current = pixelCompanionId; }, [pixelCompanionId]);
  useEffect(() => { traitsRef.current = traits; }, [traits]);
  useEffect(() => { chattinessRef.current = chattiness; }, [chattiness]);
  // v3.10.192: model selection refs mirror state.
  useEffect(() => { primaryProviderRef.current = primaryProvider; }, [primaryProvider]);
  useEffect(() => { primaryModelIdRef.current = primaryModelId; }, [primaryModelId]);
  useEffect(() => { primaryApiKeyRef.current = primaryApiKey; }, [primaryApiKey]);

  // Live preview scale update.
  useEffect(() => {
    if (mode !== 'looks') return;
    if (!previewReady) return;
    if (!previewWebViewRef.current) return;
    const arenaScale = scale * 1.6;
    previewWebViewRef.current.injectJavaScript(
      `try { window.Arena.setCenteredScale(${arenaScale}); } catch (_) {} true;`
    );
  }, [scale, previewReady, mode]);

  // Live preview sprite swap.
  useEffect(() => {
    if (mode !== 'looks') return;
    if (!previewReady) return;
    if (!previewWebViewRef.current) return;
    const c = (spriteCatalog as any).companions.find((x: any) => x.id === pixelCompanionId);
    if (!c) return;
    const slim = [{
      id: companionId,
      name: (name || companionName || '').trim(),
      sprite: pixelCompanionId,
      scale: scale, // mobile-side scale, the arena halves it
    }];
    previewWebViewRef.current.injectJavaScript(
      `(async function(){` +
        `try {` +
          `if (!window.Arena) return;` +
          `window.Arena.setActive(${JSON.stringify(companionId)});` +
          `await window.Arena.setAgents(${JSON.stringify(slim)});` +
          `window.Arena.setCentered(true);` +
          `window.Arena.setCenteredScale(${scale * 1.6});` +
        `} catch (_) {}` +
      `})(); true;`
    );
  }, [pixelCompanionId, previewReady, mode, companionId, name, companionName]);

  // Also push the initial companion to the preview after it boots (when previewReady flips to true).
  useEffect(() => {
    if (mode !== 'looks') return;
    if (!previewReady) return;
    if (!previewWebViewRef.current) return;
    const c = (spriteCatalog as any).companions.find((x: any) => x.id === pixelCompanionId);
    if (!c) return;
    const slim = [{
      id: companionId,
      name: (name || companionName || '').trim(),
      sprite: pixelCompanionId,
      scale: scale,
    }];
    previewWebViewRef.current.injectJavaScript(
      `(async function(){` +
        `try {` +
          `if (!window.Arena) return;` +
          `window.Arena.setActive(${JSON.stringify(companionId)});` +
          `await window.Arena.setAgents(${JSON.stringify(slim)});` +
          `window.Arena.setCentered(true);` +
          `window.Arena.setCenteredScale(${scale * 1.6});` +
        `} catch (_) {}` +
      `})(); true;`
    );
  }, [previewReady]);  // intentionally only fires on the ready transition

  // Local-persist effect — writes the patch to AsyncStorage on every meaningful change.
  useEffect(() => {
    if (!hydrated) return; // wait until the hydrate useEffect finished
    // v3.10.192: build the wire primaryModel from
    // provider + modelId. Same wire format the desktop
    // forge uses. Empty modelId → empty primaryModel
    // (the desktop falls through to its default).
    const composedPrimary = composeModelRef(primaryProviderRef.current, primaryModelIdRef.current);
    const patch = {
      customName: (nameRef.current || '').trim() || undefined,
      scale: Math.max(1, Math.min(8, scaleRef.current)),
      pixelCompanionId: pixelCompanionIdRef.current,
      traits: Array.from(traitsRef.current),
      chattiness: Math.max(1, Math.min(5, chattinessRef.current)),
      // Model selection in the local patch.
      primaryModel: composedPrimary,
      primaryProvider: primaryProviderRef.current,
      primaryModelId: primaryModelIdRef.current,
    };
    // 1) Local per-companion cache (offline-safe + instant remount).
    AsyncStorage.setItem(
      `cyberclaw-companion-edit-${companionId}`,
      JSON.stringify(patch),
    ).catch((e) => console.warn('[CompanionEdit] local save failed:', e?.message));
    // 2) Patch the global agents cache so the parent
    //    CompanionSettingsScreen card reflects the change
    //    without waiting for the desktop broadcast.
    AsyncStorage.getItem('cyberclaw-agents-cache').then((raw) => {
      if (!raw) return;
      try {
        const list = JSON.parse(raw);
        if (!Array.isArray(list)) return;
        const idx = list.findIndex((x: any) => x?.id === companionId);
        if (idx === -1) return;
        list[idx] = Object.assign({}, list[idx], {
          sprite: patch.pixelCompanionId,
          scale: patch.scale,
          chattiness: patch.chattiness,
          ...(patch.customName ? { name: patch.customName } : {}),
        });
        // Also patch the spriteConfig primaryModel so the Models card on the parent screen reflects the change without waiting for the desktop…
        if (list[idx].spriteConfig) {
          list[idx].spriteConfig = Object.assign({}, list[idx].spriteConfig, {
            primaryModel: patch.primaryModel,
          });
        }
        AsyncStorage.setItem('cyberclaw-agents-cache', JSON.stringify(list)).catch(() => {});
      } catch (_) { /* best-effort cache patch */ }
    }).catch(() => {});
  }, [hydrated, name, scale, pixelCompanionId, traits, chattiness, primaryProvider, primaryModelId, companionId]);

  // Hydrate from the local AsyncStorage cache AND the latest agents_list broadcast.
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
          // v3.10.95: avatar is the actual pixel-art sprite
          // data URL (not the catalog emoji). Rendered in
          // the preview frame at the size slider's scale.
          if (typeof a.avatar === 'string' && a.avatar) { /* consumed: avatar broadcast received */ }
        }
        // The desktop's agents_list broadcast (v3.2.27) now carries the full spriteConfig object including traits.
        const spriteConfig = a?.spriteConfig;
        if (spriteConfig) {
          if (typeof spriteConfig.scale === 'number') setScale(Math.max(1, Math.min(8, spriteConfig.scale)));
          if (typeof spriteConfig.chattiness === 'number') {
            setChattiness(Math.max(1, Math.min(5, Math.round(spriteConfig.chattiness))));
          }
          if (Array.isArray(spriteConfig.traits)) setTraits(new Set(spriteConfig.traits));
          if (typeof spriteConfig.pixelCompanionId === 'string' && spriteConfig.pixelCompanionId) {
            setPixelCompanionId(spriteConfig.pixelCompanionId);
          }
          if (typeof spriteConfig.customName === 'string' && spriteConfig.customName) {
            setName(spriteConfig.customName);
          }
          // Hydrate model selection from the agents_list broadcast.
          if (typeof spriteConfig.primaryModel === 'string' && spriteConfig.primaryModel) {
            const { provider, modelId } = splitModelRef(spriteConfig.primaryModel);
            setPrimaryProvider(provider);
            setPrimaryModelId(modelId);
          }
          // Ignore any stale secondaryModel — we never write it and never display it.
        } else {
          // Fallback for older broadcasts that don't have spriteConfig.
          const localRaw = await AsyncStorage.getItem(`cyberclaw-companion-edit-${companionId}`);
          if (cancelled) return;
          if (localRaw) {
            const local = JSON.parse(localRaw);
            if (Array.isArray(local.traits)) setTraits(new Set(local.traits));
            if (typeof local.scale === 'number') setScale(local.scale);
            if (typeof local.chattiness === 'number') setChattiness(local.chattiness);
            if (typeof local.customName === 'string' && local.customName) setName(local.customName);
            if (typeof local.pixelCompanionId === 'string' && local.pixelCompanionId) setPixelCompanionId(local.pixelCompanionId);
            // v3.10.192: model selection fallback from
            // the local cache. Split the wire value into
            // provider + model id for the new panel.
            if (typeof local.primaryModel === 'string' && local.primaryModel) {
              const { provider, modelId } = splitModelRef(local.primaryModel);
              setPrimaryProvider(provider);
              setPrimaryModelId(modelId);
            }
          }
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

  // Listen for sprite_config_sync_ok / _failed to surface the result.
  useEffect(() => {
    const onOk = (msg: any) => {
      if (msg.agentId !== companionId) return;
      // Removed setSaving(false) + setSavedAt() — the Save button is gone.
      try {
        AsyncStorage.getItem('cyberclaw-agents-cache').then(raw => {
          if (!raw) return;
          const list = JSON.parse(raw);
          if (!Array.isArray(list)) return;
          const idx = list.findIndex((x: any) => x.id === companionId);
          if (idx === -1) return;
          // Merge the saved patch into the cached
          // agent. The patch only has the fields the
          // user changed; preserve everything else.
          const spriteConfig = Object.assign(
            {},
            list[idx].spriteConfig || {},
            {
              pixelCompanionId,
              scale: Math.max(1, Math.min(8, scale)),
              traits: Array.from(traits),
              chattiness: Math.max(1, Math.min(5, chattiness)),
            },
          );
          list[idx] = Object.assign({}, list[idx], {
            // Top-level fields the broadcast carries:
            sprite: pixelCompanionId || list[idx].sprite,
            scale: Math.max(1, Math.min(8, scale)),
            chattiness: Math.max(1, Math.min(5, chattiness)),
            spriteConfig,
            // name only if non-empty
            ...(name.trim() ? { name: name.trim() } : {}),
          });
          AsyncStorage.setItem('cyberclaw-agents-cache', JSON.stringify(list)).catch(() => {});
        }).catch(() => {});
      } catch (_) { /* cache is best-effort */ }
      // Removed the 'Saved!' toast — the user doesn't need confirmation that something they didn't have to do succeeded.
    };
    const onFail = (msg: any) => {
      if (msg.agentId !== companionId) return;
      // v3.10.185: keep the error banner so a failed
      // unmount-save is visible (rare — only if the WS
      // is gone). The 'Saved!' ok-banner was removed.
      setBanner({ kind: 'err', text: `Couldn't save: ${msg.error || msg.reason || 'unknown error'}` });
    };
    syncClient.on('sprite_config_sync_ok', onOk);
    syncClient.on('sprite_config_sync_failed', onFail);
    // Also pick up live agents_list broadcasts while the screen is open.
    const onAgentsList = (msg: any) => {
      if (!Array.isArray(msg?.agents)) return;
      const a = msg.agents.find((x: any) => x.id === companionId);
      if (!a) return;
      if (typeof a.avatar === 'string' && a.avatar) { /* consumed: avatar broadcast received */ }
      const spriteConfig = a.spriteConfig;
      if (spriteConfig) {
        if (typeof spriteConfig.scale === 'number') setScale(Math.max(1, Math.min(8, spriteConfig.scale)));
        if (typeof spriteConfig.chattiness === 'number') {
          setChattiness(Math.max(1, Math.min(5, Math.round(spriteConfig.chattiness))));
        }
        if (Array.isArray(spriteConfig.traits)) setTraits(new Set(spriteConfig.traits));
        if (typeof spriteConfig.pixelCompanionId === 'string' && spriteConfig.pixelCompanionId) {
          setPixelCompanionId(spriteConfig.pixelCompanionId);
        }
        if (typeof spriteConfig.customName === 'string' && spriteConfig.customName) {
          setName(spriteConfig.customName);
        }
        // Live model updates from agents_list.
        if (typeof spriteConfig.primaryModel === 'string' && spriteConfig.primaryModel) {
          const { provider, modelId } = splitModelRef(spriteConfig.primaryModel);
          setPrimaryProvider(provider);
          setPrimaryModelId(modelId);
        }
      }
    };
    syncClient.on('agents_list', onAgentsList);
    return () => {
      syncClient.off?.('sprite_config_sync_ok', onOk);
      syncClient.off?.('sprite_config_sync_failed', onFail);
      syncClient.off?.('agents_list', onAgentsList);
    };
  }, [companionId]);

  // Soul + memory are read-only on mobile.
  useEffect(() => {
    setSoulLoading(true);
    setMemoryLoading(true);
    const onSoul = (msg: any) => {
      if (msg?.agentId !== companionId) return;
      if (msg.ok) setSoulContent(msg.content || '');
      else setSoulContent(`(error: ${msg.error || 'unknown'})`);
      setSoulLoading(false);
    };
    const onMemory = (msg: any) => {
      if (msg?.agentId !== companionId) return;
      if (msg.ok) setMemoryContent(msg.content || '');
      else setMemoryContent(`(error: ${msg.error || 'unknown'})`);
      setMemoryLoading(false);
    };
    const onMemoryCleared = (msg: any) => {
      if (msg?.agentId !== companionId) return;
      setClearingMemory(false);
      if (msg.ok) {
        setMemoryContent(msg.content || '');
        setBanner({ kind: 'ok', text: 'Memory cleared' });
      } else {
        setBanner({ kind: 'err', text: `Couldn't clear memory: ${msg.error || 'unknown'}` });
      }
    };
    syncClient.on('companion_soul', onSoul);
    syncClient.on('companion_memory', onMemory);
    syncClient.on('companion_memory_cleared', onMemoryCleared);
    syncClient.requestCompanionSoul(companionId);
    syncClient.requestCompanionMemory(companionId);
    return () => {
      syncClient.off?.('companion_soul', onSoul);
      syncClient.off?.('companion_memory', onMemory);
      syncClient.off?.('companion_memory_cleared', onMemoryCleared);
    };
  }, [companionId]);

  const onClearMemory = useCallback(() => {
    if (clearingMemory) return;
    if (!memoryContent || !memoryContent.trim()) return;
    Alert.alert(
      'Clear memory?',
      `This will delete ${companionName}'s memory log. The companion will start with a clean slate on the next chat.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setClearingMemory(true);
            syncClient.clearCompanionMemory(companionId);
          },
        },
      ],
    );
  }, [clearingMemory, memoryContent, companionName, companionId]);

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
    if (!hydrated) return;
    // No more setSaving/savedAt/setBanner for the save action — edits are auto-persisted, and the desktop round-trip happens on unmount (see the…
  }, [hydrated]);

  // Unmount handler — ship the final patch to the desktop exactly once, no matter how the user leaves the screen (← Back tap, hardware back…
  useEffect(() => {
    return () => {
      if (autoSavedRef.current) return;
      if (!hydratedRef.current) return; // never hydrated = nothing to save
      const patch = {
        customName: (nameRef.current || '').trim() || undefined,
        scale: Math.max(1, Math.min(8, scaleRef.current)),
        pixelCompanionId: pixelCompanionIdRef.current,
        traits: Array.from(traitsRef.current),
        chattiness: Math.max(1, Math.min(5, chattinessRef.current)),
        // Model field.
        primaryModel: composeModelRef(primaryProviderRef.current, primaryModelIdRef.current) || undefined,
      };
      // If the user pasted an API key (and it's not the masked placeholder), ship it to the desktop on unmount so the desktop's providers.json…
      const apiKey = (primaryApiKeyRef.current || '').trim();
      if (apiKey && apiKey !== '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' && primaryProviderRef.current && primaryProviderRef.current !== 'custom') {
        try {
          syncClient.sendProviderKey(primaryProviderRef.current, apiKey);
        } catch (e: any) {
          console.warn('[CompanionEdit] provider key send failed:', e?.message);
        }
      }
      try {
        syncClient.setSpriteConfig(companionId, patch);
        autoSavedRef.current = true;
      } catch (e: any) {
        // The desktop may already be unreachable (mobile WS disconnected).
        console.warn('[CompanionEdit] unmount send failed:', e?.message);
      }
    };
  }, [companionId]);

  // Register a BackHandler so the Android hardware-back button (and the iOS edge-swipe, which routes through the same BackHandler on…
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Returning true tells the OS: "I handled this, do
      // not bubble it up to the activity (which would exit
      // the app on the next bubble)."
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

 return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 64 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.header}>
            {initialEmoji || '🐾'}  Edit {companionName} — {mode === 'looks' ? 'Looks' : mode === 'models' ? 'Models' : 'Behaviour'}
          </Text>
          <View style={{ width: 60 }} />
        </View>

        {!hydrated ? (
          <Text style={styles.loadingHint}>Loading…</Text>
        ) : null}

        {/* v3.10.186: gate sections by mode. The two editor
            screens share the same state (spriteConfig + name)
            but render only the fields relevant to that scope.
            Both modes still auto-save on unmount via the same
            patch (the patch is always the full set of fields
            the screen touched); the desktop merges it
            idempotently via sprite_config_sync. */}

        {/* === LOOKS mode === */}
        {mode === 'looks' ? (
          <>
            {/* v3.10.187: live preview at the top of the
                editor. Same arena.html WebView as the
                parent CompanionSettingsScreen uses, but
                bound to the local scale + sprite state.
                Dragging the scale slider below injects
                `window.Arena.setCenteredScale(n)` so the
                canvas re-paints at the new size on the
                next frame. Picking a sprite injects
                `setActive + setAgents + setCentered` to
                swap the companion in the preview. */}
            <View style={styles.looksPreviewWrap}>
              <WebView
                ref={previewWebViewRef}
                source={{ uri: `file:///android_asset/arena.html?v=${LOOKS_ARENA_HTML_VERSION}&platform=mobile&mode=wake&onlyActive=true&centered=true&centeredScale=5` }}
                style={styles.looksPreview}
                originWhitelist={['*']}
                onMessage={(event) => {
                  try {
                    const msg = JSON.parse(event.nativeEvent.data || '{}');
                    if (msg && msg.type === 'arena_loaded') {
                      setPreviewReady(true);
                    }
                  } catch (_) { /* ignore non-JSON */ }
                }}
                pointerEvents="none"
                scrollEnabled={false}
              />
              {!previewReady ? (
                <View style={styles.looksPreviewHint} pointerEvents="none">
                  <Text style={styles.looksPreviewHintText}>Loading {name || companionName}…</Text>
                </View>
              ) : null}
            </View>

            {/* Name lives in the Looks editor too — renaming
                is a visual identity change. Behaviour mode
                doesn't show it (the user can rename from
                either side; the last write wins). */}
            <Section title="📛 Name">
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Companion name"
                placeholderTextColor="#666"
                editable={hydrated}
              />
            </Section>

            {/* v3.10.187: sprite picker — now a native
                dropdown. Tobe's 2026-09-04 18:36
                feedback: "Make the sprite a drop down."
                The catalog has 5 entries so a dropdown
                is plenty. Matches the desktop's
                Companion Forge preset dropdown. */}
            <Section title="🐾 Sprite">
              <Text style={styles.sectionHint}>
                Pick the sprite for {name || companionName}. The preview above updates live.
              </Text>
              <View style={styles.pickerWrap}>
                <Picker
                  selectedValue={pixelCompanionId}
                  onValueChange={(v: string | number) => setPixelCompanionId(String(v))}
                  enabled={hydrated}
                  style={styles.picker}
                  itemStyle={styles.pickerItem}
                  dropdownIconColor="#f7931a"
                >
                  {(spriteCatalog as any).companions.map((c: any) => (
                    <Picker.Item
                      key={c.id}
                      label={`${c.icon}  ${c.name}`}
                      value={c.id}
                    />
                  ))}
                </Picker>
              </View>
            </Section>

            {/* v3.10.187: Scale slider — 1 (fills ~5% of
                the box) to 8 (overflows the box, the
                "fill the whole view screen" upper
                bound Tobe asked for). */}
            <Section title="📐 Size">
              <Slider
                min={1}
                max={8}
                step={1}
                value={scale}
                onChange={(v) => setScale(v)}
                disabled={!hydrated}
                label="Scale"
                showValue={`${scale}×`}
              />
              <Text style={styles.sliderHint}>
                Live preview above updates as you drag. Bigger = larger sprite in the arena.
              </Text>
            </Section>
          </>
        ) : null}

        {/* === BEHAVIOUR mode === */}
        {mode === 'behaviour' ? (
          <>

        {/* v3.10.187: BEHAVIOUR group — Chattiness + Personality
            Traits. The inline group label is preserved from
            v3.10.185 even though the page now shows only the
            behaviour section (the inline label was originally
            for when Looks + Behaviour shared one scroll). The
            label still helps anchor the section visually. */}
        <Text style={styles.groupLabel}>🎭 BEHAVIOUR</Text>

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
            disabled={!hydrated}
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
        <Section title="🎭 Personality Traits">
          <Text style={styles.sectionHint}>Pick the traits that fit this companion. Multiple selections allowed.</Text>
          <View style={styles.traitsGrid}>
            {TRAITS.map(t => {
              const active = traits.has(t.id);
              return (
                <TouchableOpacity
                  key={t.id}
                  style={[styles.traitToggle, active && styles.traitToggleActive]}
                  onPress={() => toggleTrait(t.id)}
                  disabled={!hydrated}
                >
                  <Text style={[styles.traitBox, active && styles.traitBoxActive]}>{active ? '☑' : '☐'}</Text>
                  {/* v3.10.94: dropped the description line for
                      compactness (Tobe's v3.10.93 feedback: "make
                      the behaviours smaller"). The label is
                      recognizable on its own. The full
                      description still lives in the TRAITS table
                      at the top of the file for any future
                      long-press tooltip. */}
                  <Text style={[styles.traitLabel, active && styles.traitLabelActive]} numberOfLines={1}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>
          </>
        ) : null}

        {/* === MODELS mode === */}
        {mode === 'models' ? (
          <>
            <Text style={styles.groupLabel}>🧠 MODEL</Text>

            {/* v3.10.192: provider-first model picker.
                Replaces the v3.10.191 catalog-based
                pickers (Anthropic / OpenAI / Google /
                Local groups with hardcoded model
                lists). Tobe 2026-09-07: "the catalog
                is not up to date. There have been
                several releases lately. ... Could we
                add a generic input also? Where the
                user can input Whatever he has?"

                New flow:
                1. Pick a provider from the curated
                   list (Anthropic / OpenAI / Google /
                   MiniMax / OpenRouter / Mistral /
                   Groq / Custom).
                2. Paste an API key (optional —
                   gateway uses the env-var fallback
                   if blank).
                3. Type any model id. No catalog
                   restriction. Wire value is
                   `provider/model`.

                The Secondary / fallback picker is
                gone — Tobe 2026-09-07: "remove
                fallbacks". The local-runtimes section
                is preserved (Ollama / LM Studio /
                llama.cpp / vLLM) because the
                self-hosted case has different UX
                (endpoint picker instead of API key). */}

            {/* Row 1: provider picker */}
            <Section title="🌐 Provider">
              <Text style={styles.sectionHint}>
                Pick a provider. Drives the wire prefix and which API key env var applies.
              </Text>
              <View style={styles.pickerWrap}>
                <Picker
                  selectedValue={primaryProvider}
                  onValueChange={(v: string | number) => {
                    const s = String(v);
                    setPrimaryProvider(s);
                    // When switching providers, clear the model id (the user almost certainly wants to pick a different model).
                    if (s !== primaryProvider) {
                      setPrimaryModelId('');
                    }
                  }}
                  enabled={hydrated}
                  style={styles.picker}
                  itemStyle={styles.pickerItem}
                  dropdownIconColor="#f7931a"
                >
                  {PROVIDERS_CURATED.map((p) => (
                    <Picker.Item key={p.id || '__sep__'} label={p.label} value={p.id} />
                  ))}
                </Picker>
              </View>
              {/* Hint about which env var applies. */}
              {primaryProvider && primaryProvider !== 'custom' ? (
                (() => {
                  const meta = PROVIDERS_CURATED.find((p) => p.id === primaryProvider);
                  return meta?.keyEnv ? (
                    <Text style={styles.sectionHint}>
                      💡 Or set <Text style={styles.codeInline}>{meta.keyEnv}</Text> in your desktop's environment.
                    </Text>
                  ) : null;
                })()
              ) : null}
            </Section>

            {/* Row 2: API key field (cloud providers only).
                For local providers this row is hidden. */}
            {primaryProvider && !LOCAL_PROVIDER_IDS.has(primaryProvider) && primaryProvider !== '' ? (
              <Section title="🔑 API key">
                <Text style={styles.sectionHint}>
                  Paste your key. Sent to the desktop on save so this provider is available to all companions.
                </Text>
                <TextInput
                  style={styles.input}
                  value={primaryApiKey}
                  onChangeText={setPrimaryApiKey}
                  placeholder="paste your API key"
                  placeholderTextColor="#666"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  editable={hydrated}
                />
              </Section>
            ) : null}

            {/* Row 3: free-text model input. No catalog
                restriction. The placeholder updates
                based on the chosen provider so the
                user sees a sensible hint, but they can
                type anything. */}
            <Section title="🧠 Model">
              <Text style={styles.sectionHint}>
                Type any model id your provider supports. The wire value is <Text style={styles.codeInline}>{primaryProvider || 'provider'}/{'{model-id}'}</Text>.
              </Text>
              <TextInput
                style={styles.input}
                value={primaryModelId}
                onChangeText={setPrimaryModelId}
                placeholder={(() => {
                  if (primaryProvider === 'custom') return 'my-model-id';
                  const meta = PROVIDERS_CURATED.find((p) => p.id === primaryProvider);
                  return meta?.placeholder || 'model-id';
                })()}
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={hydrated}
              />
              {/* Inline summary of the composed wire value */}
              {primaryProvider && primaryModelId ? (
                <Text style={styles.sectionHint}>
                  → Saves as: <Text style={styles.codeInline}>{composeModelRef(primaryProvider, primaryModelId)}</Text>
                </Text>
              ) : null}
            </Section>

            {/* v3.10.192: LOCAL MODELS section. Preserved
                from v3.10.191 because local runtimes
                have a fundamentally different UX (need
                an endpoint, not an API key). Visual
                separation: purple divider + a local
                provider sub-picker that swaps the
                primaryProvider to a local runtime.
                Tobe's "Create a separation for local
                models also" — still honored, just
                with the new provider-first shape. */}
            <View style={styles.localModelsHeader}>
              <Text style={styles.localModelsHeaderText}>
                💻 LOCAL MODELS
              </Text>
              <Text style={styles.localModelsHeaderSub}>
                Self-hosted / private. Runs on your machine — private, offline-safe, free. Configure endpoints on the desktop (Settings → LLM Endpoints).
              </Text>
            </View>

            <Section title="🖥️ Local runtime">
              <Text style={styles.sectionHint}>
                Pick a local runtime. Switches the provider above to a local one and types the model id for you.
              </Text>
              <View style={styles.pickerWrap}>
                <Picker
                  selectedValue={LOCAL_PROVIDER_IDS.has(primaryProvider) ? primaryProvider : ''}
                  onValueChange={(v: string | number) => {
                    const s = String(v);
                    if (!s) return;
                    setPrimaryProvider(s);
                    const meta = PROVIDERS_LOCAL.find((p) => p.id === s);
                    if (meta?.placeholder && !primaryModelId) {
                      setPrimaryModelId(meta.placeholder);
                    }
                  }}
                  enabled={hydrated}
                  style={styles.picker}
                  itemStyle={styles.pickerItem}
                  dropdownIconColor="#a855f7"
                >
                  {PROVIDERS_LOCAL.map((p) => (
                    <Picker.Item key={p.id || '__sep__'} label={p.label} value={p.id} />
                  ))}
                </Picker>
              </View>
            </Section>

            <View style={styles.localHint}>
              <Text style={styles.localHintText}>
                💡 Setup the local runtime on the desktop's Settings → LLM Endpoints. The 🧠 LLM pill in the desktop header shows whether each model is reachable.
              </Text>
            </View>
          </>
        ) : null}

        {/* === BEHAVIOUR ONLY === */}
        {/* v3.10.193: Soul + Memory are personality / character
            content, not visual identity (Looks) or LLM config
            (Models). They live under Behaviour. Tobe 2026-09-07:
            "i see you have put the soul and memory md in the
            models and looks also, this only needs to be under
            behaviour."

            Previously these were rendered for every mode because
            they sat outside the mode === ... gates (the comment
            said "=== BOTH MODES ===" which was the bug — there
            was no mode where they DIDN'T appear). Now they only
            render when mode === 'behaviour', alongside the
            existing chattiness + traits sections.

            Side benefit: the mobile's behaviour editor now
            matches the desktop forge's structure (where Soul +
            Memory sit below the Behaviour Traits in the
            Settings → Companion Forge layout). */}

        {mode === 'behaviour' ? (
          <>
            {/* v3.10.103: Soul — read-only viewer of the
                companion's character definition. The desktop's
                Companion Forge is the editor (it has presets +
                textarea + Apply preset). Mobile mirrors the
                file so the user can see what their companion
                is "made of". Editing requires opening the
                desktop forge. */}
            <Section title="📜 Soul (read-only)">
              <Text style={styles.sectionHint}>
                Character definition for {companionName}. Edit on the desktop Companion Forge.
              </Text>
              <View style={styles.soulViewer}>
                {soulLoading ? (
                  <Text style={styles.soulLoading}>Loading from desktop…</Text>
                ) : (
                  <Text style={styles.soulText} selectable>
                    {soulContent && soulContent.trim()
                      ? soulContent
                      : '(empty — desktop has not generated a soul yet. Set traits in the desktop forge to generate one.)'}
                  </Text>
                )}
              </View>
            </Section>

            {/* v3.10.103: Memory — read-only log of what the
                companion remembers (auto-written by the
                desktop's remember_fact tool). Clear button
                hits the desktop's companion:clear-memory IPC.
                The viewer mirrors the file content; the
                desktop regenerates the content from scratch
                on the next chat turn. */}
            <Section title="🧠 Memory (read-only)">
              <Text style={styles.sectionHint}>
                Auto-written by {companionName} on the desktop. Clear to start fresh.
              </Text>
              <View style={styles.soulViewer}>
                {memoryLoading ? (
                  <Text style={styles.soulLoading}>Loading from desktop…</Text>
                ) : (
                  <Text style={styles.soulText} selectable>
                    {memoryContent && memoryContent.trim()
                      ? memoryContent
                      : '(empty — companion has not remembered anything yet)'}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                style={[
                  styles.clearBtn,
                  (clearingMemory || !memoryContent || !memoryContent.trim()) && styles.clearBtnDisabled,
                ]}
                onPress={onClearMemory}
                disabled={clearingMemory || !memoryContent || !memoryContent.trim()}
              >
                <Text style={styles.clearBtnText}>
                  {clearingMemory ? '🗑 Clearing…' : '🗑 Clear memory'}
                </Text>
              </TouchableOpacity>
            </Section>
          </>
        ) : null}

        {/* v3.10.94: LLM Models section removed. Tobe's
            v3.10.93 feedback: "We can remove LLM options
            on the mobile end, that can be desktop only."
            The desktop's Companion Forge owns the model
            picker. The mobile now only edits sprite, scale,
            traits, and chattiness (plus name). */}

        {/* v3.10.185: no Save button. Edits are auto-applied
            to local state and AsyncStorage on every change;
            the desktop round-trip fires on unmount. The
            small footer below used to host the Save button
            + 'Saved at HH:MM' hint. Removed both; the empty
            footer margin is gone too. The user sees the
            edits applied instantly — no save action needed. */}
      </ScrollView>
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
  // Section-group label (LOOKS / BEHAVIOUR).
  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1.5,
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  sectionHint: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
  },
  // Inline code chip for showing composed wire values (e.g.
  codeInline: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    color: '#f7931a',
    backgroundColor: 'rgba(247, 147, 26, 0.08)',
    paddingHorizontal: 4,
    borderRadius: 3,
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
  // Looks editor styles.
  looksPreviewWrap: {
    width: '100%',
    height: 240,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#f7931a',
    overflow: 'hidden',
    backgroundColor: '#0a0a1a',
    marginBottom: 12,
    position: 'relative',
  },
  looksPreview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  looksPreviewHint: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10, 10, 26, 0.7)',
  },
  looksPreviewHintText: {
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
  },
  pickerWrap: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3a3a55',
    backgroundColor: '#0a0a1a',
    overflow: 'hidden',
  },
  picker: {
    color: '#fff',
    backgroundColor: 'transparent',
  },
  pickerItem: {
    color: '#fff',
    fontSize: 15,
  },
  // LOCAL MODELS section divider.
  localModelsHeader: {
    marginTop: 24,
    marginBottom: 8,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(168, 85, 247, 0.3)',
  },
  localModelsHeaderText: {
    color: '#a855f7',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  localModelsHeaderSub: {
    color: '#9aa0b4',
    fontSize: 12,
    lineHeight: 16,
  },
  // Hint box at the bottom of the Models page pointing the user at the desktop for setup + reachability checks.
  localHint: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(168, 85, 247, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.25)',
  },
  localHintText: {
    color: '#cfd2e0',
    fontSize: 12,
    lineHeight: 17,
  },
  // Preview frame mirrors the desktop's .forge-companion-preview (200×200, 2px border, dark background, rounded corners).
  traitBox: {
    fontSize: 18,
    color: '#555',
    marginRight: 10,
    marginTop: 1,
  },
  traitBoxActive: {
    color: '#f7931a',
  },
  // 2-column trait grid.
  traitsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  traitToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '48%',
    paddingVertical: 6,
    paddingHorizontal: 8,
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
    fontSize: 12,
    flexShrink: 1,
  },
  // v3.10.93: active trait label turns orange (matches
  // the desktop's .trait-toggle input[type=checkbox]:checked
  // ~ .trait-label rule).
  traitLabelActive: {
    color: '#f7931a',
  },
  // Removed the footer/saveBtn/saveBtnText/ saveBtnDisabled/savedHint styles.
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
  // Soul + memory viewer surfaces.
  soulViewer: {
    backgroundColor: '#0a0a1a',
    borderColor: '#3a3a55',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 60,
  },
  soulText: {
    color: '#d0d0d0',
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  soulLoading: {
    color: '#888',
    fontSize: 12,
    fontStyle: 'italic',
  },
  // Clear-memory button — muted grey (not primary) so the user doesn't mistake it for the Save button.
  clearBtn: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#ef4444',
    alignItems: 'center',
  },
  clearBtnDisabled: {
    opacity: 0.4,
  },
  clearBtnText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '600',
  },
});
