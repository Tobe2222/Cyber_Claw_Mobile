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
 * The save flow (v3.10.185):
 *   1. Store partial patch in local state (instant UI feedback)
 *   2. Persist patch to AsyncStorage on every change (offline-safe)
 *   3. On unmount (back button / swipe / navigating away) →
 *      send the latest patch to the desktop via sprite_config_sync
 *   4. The next agents_list broadcast (triggered by the desktop's
 *      mobile-sprite-config-saved handler) updates the in-memory
 *      cache so the Settings list reflects the new chattiness /
 *      scale / name.
 *
 * Section layout (v3.10.185):
 *   🎨 Looks group — Sprite + Size (visual identity)
 *   🎭 Behaviour group — Chattiness + Personality Traits (how they act)
 *   The split makes it obvious which fields shape what the
 *   companion *looks like* vs how they *behave* — previously
 *   everything was under one "Behaviour" umbrella on the parent
 *   CompanionSettingsScreen, which made Sprite feel misplaced.
 *
 * Back swipe (v3.10.185):
 *   A BackHandler is registered so the Android hardware-back
 *   gesture / iOS edge-swipe closes the editor instead of
 *   exiting the app. Without this, tapping ← at the top of the
 *   screen leaves the editor but the OS-level swipe still goes
 *   to the home screen.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, Platform, BackHandler,
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

// v3.10.94: model list removed from the mobile (Tobe:
// "We can remove LLM options on the mobile end, that
// can be desktop only"). The Models section + the entire
// ModelPicker component + the related state were dropped
// in this release. The desktop's sprite_config_sync
// whitelist still accepts primaryModel/secondaryModel, so
// a future "also let the phone pick a model" reversal is
// a one-component re-add.

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
  // v3.10.92: chattiness is the headline new feature. Default
  // 3 if the companion has no value yet (legacy companion).
  const [chattiness, setChattiness] = useState<number>(3);
  // v3.10.185: no more Save button — edits apply instantly
  // to local state, persist to AsyncStorage on every change,
  // and ship to the desktop on unmount (back tap / swipe /
  // navigating away). saving/savedAt state is gone.
  const [hydrated, setHydrated] = useState<boolean>(false);
  const hydratedRef = useRef<boolean>(false);
  // v3.10.185: track the latest patch values via refs so
  // the unmount cleanup can read the freshest values
  // without re-running the cleanup effect on every change
  // (which would clobber a partial save with stale state).
  const nameRef = useRef<string>('');
  const scaleRef = useRef<number>(4);
  const pixelCompanionIdRef = useRef<string>('boar');
  const traitsRef = useRef<Set<string>>(new Set());
  const chattinessRef = useRef<number>(3);
  // Guard so we only auto-save to the desktop once per
  // mount. Subsequent state changes inside the same mount
  // only persist locally (no desktop spam).
  const autoSavedRef = useRef<boolean>(false);
  // v3.10.103: soul + memory are read-only on mobile.
  // The desktop's Companion Forge is the editor. We just
  // display the desktop's read response so the user can
  // see what their companion's character + remembered
  // facts look like. Memory has a Clear button that calls
  // the desktop's companion:clear-memory IPC.
  const [soulContent, setSoulContent] = useState<string>('');
  const [soulLoading, setSoulLoading] = useState<boolean>(true);
  const [memoryContent, setMemoryContent] = useState<string>('');
  const [memoryLoading, setMemoryLoading] = useState<boolean>(true);
  const [clearingMemory, setClearingMemory] = useState<boolean>(false);
  // v3.10.93: safe-area insets so the header doesn't sit
  // under the status bar (Tobe's v3.10.92 feedback). Used
  // for paddingTop on the page container + the toast's
  // bottom inset.
  const insets = useSafeAreaInsets();

  // v3.10.185: mirror state into refs so the unmount
  // cleanup (and the local-persist effect below) can read
  // the freshest values without re-running the cleanup
  // on every change. Same values, two storage forms:
  // useState drives the UI; refs drive the auto-save.
  useEffect(() => { nameRef.current = name; }, [name]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { pixelCompanionIdRef.current = pixelCompanionId; }, [pixelCompanionId]);
  useEffect(() => { traitsRef.current = traits; }, [traits]);
  useEffect(() => { chattinessRef.current = chattiness; }, [chattiness]);

  // v3.10.185: local-persist effect — writes the patch to
  // AsyncStorage on every meaningful change. The desktop
  // is NOT touched here; the desktop round-trip happens on
  // unmount (next useEffect). Persisting locally on every
  // change makes the UI feel instant: if the user crashes
  // mid-edit, the next mount of this screen picks up the
  // latest local values instead of reverting to whatever
  // the last desktop broadcast had.
  //
  // The local cache (`cyberclaw-agents-cache`) also gets
  // patched on every change so the CompanionSettingsScreen
  // card updates immediately when the user backs out —
  // before the desktop even sees the change.
  useEffect(() => {
    if (!hydrated) return; // wait until the hydrate useEffect finished
    const patch = {
      customName: (nameRef.current || '').trim() || undefined,
      scale: Math.max(1, Math.min(8, scaleRef.current)),
      pixelCompanionId: pixelCompanionIdRef.current,
      traits: Array.from(traitsRef.current),
      chattiness: Math.max(1, Math.min(5, chattinessRef.current)),
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
        AsyncStorage.setItem('cyberclaw-agents-cache', JSON.stringify(list)).catch(() => {});
      } catch (_) { /* best-effort cache patch */ }
    }).catch(() => {});
  }, [hydrated, name, scale, pixelCompanionId, traits, chattiness, companionId]);

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
          // v3.10.95: avatar is the actual pixel-art sprite
          // data URL (not the catalog emoji). Rendered in
          // the preview frame at the size slider's scale.
          if (typeof a.avatar === 'string' && a.avatar) { /* consumed: avatar broadcast received */ }
        }
        // v3.10.95: the desktop's agents_list broadcast (v3.2.27)
        // now carries the full spriteConfig object including
        // traits. The mobile's Personalize screen was rendering
        // empty trait checkboxes (no current selection visible)
        // because the agents_list broadcast didn't include
        // traits. Tobe's v3.10.94 feedback: "i still dont get
        // the current settings. If you see the behaviours, none
        // of them are selected, even tho they are on the
        // desktop. The settings should be consistent between
        // desktop and phone."
        //
        // Hydration order (most-recent-wins):
        //   1. agents_list broadcast (the desktop's source of
        //      truth, refreshed every ~60s and on every
        //      sprite_config_sync)
        //   2. local cache (cyberclaw-companion-edit-{id}) —
        //      offline fallback for the case where the
        //      desktop hasn't broadcast yet
        //   3. component defaults
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
        } else {
          // v3.10.92: fallback for older broadcasts that
          // don't have spriteConfig. The local cache is
          // the only source of truth for traits on the
          // mobile in that case. The desktop will send the
          // full spriteConfig on the next ~60s sync.
          const localRaw = await AsyncStorage.getItem(`cyberclaw-companion-edit-${companionId}`);
          if (cancelled) return;
          if (localRaw) {
            const local = JSON.parse(localRaw);
            if (Array.isArray(local.traits)) setTraits(new Set(local.traits));
            if (typeof local.scale === 'number') setScale(local.scale);
            if (typeof local.chattiness === 'number') setChattiness(local.chattiness);
            if (typeof local.customName === 'string' && local.customName) setName(local.customName);
            if (typeof local.pixelCompanionId === 'string' && local.pixelCompanionId) setPixelCompanionId(local.pixelCompanionId);
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

  // v3.10.92: listen for sprite_config_sync_ok / _failed to
  // surface the result. We also pick up the agents_list update
  // automatically via the existing SetAgents hook in the
  // parent screen.
  useEffect(() => {
    const onOk = (msg: any) => {
      if (msg.agentId !== companionId) return;
      // v3.10.185: removed setSaving(false) + setSavedAt() —
      // the Save button is gone. The local cache patch below
      // still runs because the agents_list broadcast that
      // arrives after sprite_config_sync_ok contains the
      // canonical values the desktop persisted.
      // v3.10.146: also persist the agents list to cache
      // on save success. Bug Tobe hit: edited chattiness
      // to 2, saved, returned to CompanionSettingsScreen,
      // still showed 1. Root cause: the cache
      // (`cyberclaw-agents-cache`) is only written by
      // HomeScreen and CompanionSettingsScreen's
      // agents_list listener. While CompanionEditScreen
      // is open, both are unmounted. The next
      // agents_list broadcast arrives, the desktop
      // updates its in-memory state, but the cache
      // doesn't get the new value. When the user
      // taps back, CompanionSettingsScreen re-hydrates
      // from the stale cache.
      //
      // Fix: CompanionEditScreen proactively updates
      // the cache when the save succeeds. It reads the
      // current cache, finds this companion, merges the
      // patch (the values the user just saved), and
      // writes back. The companion-stats in the cache
      // might be slightly stale (XP, sleep state) but
      // those update on the next agents_list broadcast
      // when the user returns to CompanionSettingsScreen.
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
      // v3.10.185: removed the 'Saved!' toast — the user
      // doesn't need confirmation that something they
      // didn't have to do succeeded. Edits are silent
      // and instant.
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
    // v3.10.95: also pick up live agents_list broadcasts
    // while the screen is open. The desktop re-broadcasts
    // agents_list after every sprite_config_sync (within
    // ~100ms of the save), so the personalise screen sees
    // the new sprite config / avatar / traits without
    // waiting for a remount. The agents_list event is
    // emitted by SyncClient with the full payload.
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
      }
    };
    syncClient.on('agents_list', onAgentsList);
    return () => {
      syncClient.off?.('sprite_config_sync_ok', onOk);
      syncClient.off?.('sprite_config_sync_failed', onFail);
      syncClient.off?.('agents_list', onAgentsList);
    };
  }, [companionId]);

  // v3.10.103: soul + memory are read-only on mobile.
  // On mount we ask the desktop for both files; the
  // responses arrive asynchronously via the
  // 'companion_soul' / 'companion_memory' events. The
  // Clear-memory button sends 'clear_companion_memory'
  // and waits for 'companion_memory_cleared' to refresh
  // the viewer. The desktop is the source of truth for
  // both files — there is no on-device cache because
  // the soul is the personality definition and the
  // memory is auto-written by the companion's chat
  // pipeline (which runs on the desktop).
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
    // v3.10.185: no more setSaving/savedAt/setBanner for the
    // save action — edits are auto-persisted, and the desktop
    // round-trip happens on unmount (see the cleanup
    // useEffect below). The Save button was removed in this
    // release because:
    //   (a) every change already persists to AsyncStorage, so
    //       the phone has the truth at all times,
    //   (b) sending the patch to the desktop on every change
    //       would spam the WS (a slider drag = 30+ frames of
    //       state changes), and
    //   (c) the desktop's agents_list broadcast after each
    //       sprite_config_sync would echo back the in-flight
    //       state mid-edit, fighting the user's drag.
    //
    // The patch is now sent on unmount: one final sprite_config_sync
    // with the latest values, then the screen goes away.
    //
    // Kept as onSave for backward-compat (it was exported in
    // some earlier pre-release versions of this file). It's
    // a no-op now — the real save happens in the unmount effect.
  }, [hydrated]);

  // v3.10.185: unmount handler — ship the final patch to
  // the desktop exactly once, no matter how the user leaves
  // the screen (← Back tap, hardware back button, swipe back,
  // navigate to a sibling route). The guard ensures we only
  // do this once per mount — if the same patch is sent twice
  // (e.g. cleanup runs and then the screen re-mounts within
  // the same tick), the desktop's idempotent save handler
  // treats it as a no-op.
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
      };
      try {
        syncClient.setSpriteConfig(companionId, patch);
        autoSavedRef.current = true;
      } catch (e: any) {
        // The desktop may already be unreachable (mobile WS
        // disconnected). The local AsyncStorage cache still
        // has the patch, so the next time the user reconnects
        // and the desktop does a sprite-config reconcile, the
        // changes will flow through. Don't throw — this is a
        // best-effort fire-and-forget on unmount.
        console.warn('[CompanionEdit] unmount send failed:', e?.message);
      }
    };
  }, [companionId]);

  // v3.10.185: register a BackHandler so the Android
  // hardware-back button (and the iOS edge-swipe, which
  // routes through the same BackHandler on Android-tablet
  // builds) closes the editor instead of exiting the app.
  // Without this, tapping ← Back in the header goes to the
  // previous screen BUT the OS-level swipe / hardware button
  // pops the whole app — the two navigation paths drift
  // apart. Registering here pins them together: BackHandler
  // intercepts the hardware event and calls onBack(), which
  // returns to CompanionSettingsScreen.
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
            editable={hydrated}
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
        {/* v3.10.185: LOOKS group — Sprite + Size. Split out
            from "Behaviour" so it's visually obvious that these
            fields shape what the companion LOOKS like, while
            Chattiness + Traits shape how they BEHAVE. The parent
            CompanionSettingsScreen card is also going to be
            split (v3.10.186) to mirror this layout. */}
        <Text style={styles.groupLabel}>🎨 LOOKS</Text>

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
                  disabled={!hydrated}
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

        {/* v3.10.94: sprite preview frame. Mirrors the
            desktop's #forge-companion-viewer — a 200×200
            centered box with a dark background and a 2px
            border. The mobile doesn't have the desktop's
            pixel sprite renderer, so we render the catalog
            emoji at a size proportional to the scale
            slider (scale × 16, so 1 = 16px, 4 = 64px, 8 =
            128px). The sprite name is shown below the
            frame so the user can see what's currently
            selected. Live-updates as they change either
            control. Tobe's v3.10.93 feedback: "use the
            frame of the sprite selected like the desktop
            has. A preview frame." */}
        {/* v3.10.97: preview removed. Tobe's v3.10.96
            feedback: "the preview are just empty and
            black now. You can remove it." The avatar
            data URL wasn't being broadcast correctly
            until v3.2.28 (file-path-to-data-URI
            conversion at broadcast time). With v3.2.28
            on the desktop, the preview would render the
            actual pixel sprite, but Tobe asked to drop
            the section entirely. The mobile's Companion
            tab in the WebView arena still shows the
            sprite at the chosen scale, so the
            "see how it looks" affordance is preserved. */}
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
          <Text style={styles.sliderHint}>Bigger number = larger sprite in the arena.</Text>
        </Section>

        {/* v3.10.185: BEHAVIOUR group — Chattiness + Personality
            Traits. Visually separated from the Looks group
            above so the editor reads top-to-bottom as
            "Looks" → "Behaviour" → "Soul" → "Memory". */}
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

        {/* v3.10.103: Soul — read-only viewer of the companion's
            character definition. The desktop's Companion Forge
            is the editor (it has presets + textarea + Apply
            preset). Mobile mirrors the file so the user can
            see what their companion is "made of". Editing
            requires opening the desktop forge. */}
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
            companion remembers (auto-written by the desktop's
            remember_fact tool). Clear button hits the desktop's
            companion:clear-memory IPC. The viewer mirrors the
            file content; the desktop regenerates the content
            from scratch on the next chat turn. */}
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
  // v3.10.185: section-group label (LOOKS / BEHAVIOUR).
  // Dimmer than sectionTitle so the section cards inside
  // the group stay the visual anchor. Tight vertical
  // margin so the group label sits close to its first
  // section card and the eye reads them as one block.
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
  // v3.10.94: preview frame mirrors the desktop's
  // .forge-companion-preview (200×200, 2px border, dark
  // background, rounded corners). On the mobile the
  // preview is responsive: width matches the section
  // content (100%) and the inner box is a 200px square
  // (capped to keep tall phones from going huge).
  // The emoji inside scales with the size slider so the
  // user can see "this is what the sprite looks like
  // at scale N" without leaving the screen.
  // v3.10.97: previewFrame / previewEmoji / previewLabel
  // / previewLabelScale styles removed along with the
  // Preview section. The Section now goes straight from
  // the Sprite picker to the Size slider. The user can
  // see the sprite at the chosen scale in the Companion
  // tab of the WebView arena (no in-Personalize preview
  // needed).
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
  // v3.10.94: 2-column trait grid. Tobe's v3.10.93
  // feedback: "make the behaviours smaller and 2 or 3
  // in a row". Dropped the description text (was the
  // bulky bit) and the bigger padding. Each trait is
  // now ~48% wide so 2 fit per row with the existing
  // 6px gap. With 9 traits that fits 4 rows + a single
  // half-width orphan (the desktop forge has the same
  // 9 traits in 2 columns = 4 rows + orphan).
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
  // v3.10.185: removed the footer/saveBtn/saveBtnText/
  // saveBtnDisabled/savedHint styles. The Save button is
  // gone — edits apply automatically and the desktop
  // round-trip happens on unmount.
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
  // v3.10.103: soul + memory viewer surfaces. Read-only
  // box with a thin gold border + monospace-feeling
  // mono text to make it look like a "definition" panel.
  // Match the desktop forge's textarea styling (#0a0a1a
  // background, #3a3a55 border) so the mobile doesn't
  // feel like a different app.
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
  // v3.10.103: clear-memory button — muted grey
  // (not primary) so the user doesn't mistake it for
  // the Save button. The companion is the writer; the
  // Clear button is the escape hatch.
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
