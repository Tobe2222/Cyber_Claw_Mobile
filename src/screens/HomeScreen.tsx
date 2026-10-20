/** HomeScreen - CyberClaw mobile companion Arena (real sprites) + Chat/Events/Log tabs + TTS + background service */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, StyleSheet, Image,
  Platform, Keyboard, Dimensions, KeyboardAvoidingView, Alert, Modal,
  NativeModules, StatusBar, NativeEventEmitter, BackHandler, AppState, Animated,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import syncClient from '../services/SyncClient';
import { getSimpleAudioRecorder, disposeSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import { getVAD, resetVAD } from '../services/SileroVAD';  // Voice Activity Detection
import RNFS from 'react-native-fs';
import { extractAudioFeatures, matchAgainstTraining, matchAgainstAllCompanions, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';
import { version as APP_VERSION } from '../../package.json';
import RemoteToolHandler from '../services/RemoteToolHandler';
// Local-LLM status pill above the chat input.
import LlmStatusPill from '../components/LlmStatusPill';
// Theme support.
import { useTheme } from '../theme/ThemeContext';
import { Theme } from '../theme/tokens';

// Native modules
const { BackgroundService, AppControl, WakeWordModule } = NativeModules;
// Lazy getter - NativeEventEmitter must not be instantiated at module eval time
// (bridge may not be ready). Create on first use instead.
let _wakeWordEmitter: NativeEventEmitter | null = null;

// Module-level wake-recovery state.
let moduleLevelWakePending = false;
let moduleLevelWakePendingAt = 0;

// In-memory guard so HomeScreen's checkPending effect cannot immediately re-trigger voice mode after the user just exited it.
let _wakeJustExitedUntil = 0;
export const markWakeJustExited = (windowMs: number = 5000) => {
  _wakeJustExitedUntil = Date.now() + windowMs;
};
export const isWakeJustExited = () => Date.now() < _wakeJustExitedUntil;

const getWakeWordEmitter = () => {
  if (!_wakeWordEmitter && WakeWordModule) {
    _wakeWordEmitter = new NativeEventEmitter(WakeWordModule);
  }
  return _wakeWordEmitter;
};
// Alias used throughout file
const wakeWordEmitter = { addListener: (event: string, cb: (...args: any[]) => void) => getWakeWordEmitter()?.addListener(event, cb) ?? null };

// ── Sample-match wake listener ──────────────────────────────────────────────
const getWakeSamplesKey = (phrase: string) =>
  `cyberclaw-wake-samples-${phrase.toLowerCase().replace(/\s+/g, '-')}`;
const SAMPLE_MATCH_THRESHOLD_FG = 0.55; // foreground - more lenient

// Lookup the most recent training samples across all phrases.
async function findAnyWakeSamples(): Promise<{ key: string; phrase: string; training: any } | null> {
  let keys: string[] = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return null;
  }
  const sampleKeys = keys.filter(k => k.startsWith('cyberclaw-wake-samples-'));
  for (const key of sampleKeys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.features?.length) {
        // The phrase is encoded in the key. Decode it back.
        const slug = key.replace('cyberclaw-wake-samples-', '');
        const phrase = slug.replace(/-/g, ' ').toLowerCase();
        return { key, phrase, training: parsed };
      }
    } catch {
      // skip broken entries
    }
  }
  return null;
}
const SAMPLE_MATCH_THRESHOLD_BG = 0.65; // background default - stricter

function startSampleMatchListener(
  companionsTraining: Array<{ companionId: string; features: AudioFeatures[] }>,
  onDetected: (matchedCompanionId: string) => void,
  onLog?: (msg: string) => void,
  threshold?: number,
): () => void {
  // Replaced DTW-based sample matcher with openWakeWord TFLite inference.
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('owwWakeDetected', (e: { score: number; wakeword: string }) => {
    if (stopped) return;
    onLog?.(`✅ Wake word detected: ${e.wakeword} (${(e.score * 100).toFixed(0)}%)`);
    // Use the first/active companion for now. Per-companion
    // routing will come when we have custom-trained models
    // for each companion.
    const activeId = companionsTraining[0]?.companionId;
    if (activeId) onDetected(activeId);
  });
  // Initialize OWW with the bundled pre-trained model, then start listening.
  WakeWordModule?.initOww?.('hey_jarvis', threshold ?? 0.5)
    .catch((e: any) => onLog?.(`initOww failed: ${e?.message}`))
    .then(() => WakeWordModule?.startOwwListening?.())
    .catch((e: any) => onLog?.(`startOwwListening failed: ${e?.message}`));
  return () => {
    stopped = true;
    sub?.remove?.();
    WakeWordModule?.stopOwwListening?.().catch(() => {});
  };
}

async function startBgService() {
  try {
    const enabled = await AsyncStorage.getItem('cyberclaw-bg-listening');
    if (enabled !== 'false' && BackgroundService) {
      // Prefer the trained wake phrase from the active set (the manager's source of truth) over `cyberclaw-audio-settings.wakeWord`.
      const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
      let phrase = settingsRaw ? JSON.parse(settingsRaw).wakeWord : '';
      if (!phrase) {
        const agentId = await AsyncStorage.getItem('cyberclaw-active-wake-companion').catch(() => null);
        if (agentId) {
          try {
            const sets = await WakeWordModule?.listWakeSets?.().catch(() => null);
            if (sets && typeof sets === 'object') {
              const candidates = Object.entries(sets)
                .map(([setId, raw]: [string, any]) => ({ setId, ...raw }))
                .filter((e: any) => !e.agentId || e.agentId === agentId);
              const activeId = await WakeWordModule?.getActiveWakeSet?.(agentId).catch(() => null);
              const active = activeId ? candidates.find((e: any) => e.setId === activeId) : null;
              const picked = active || [...candidates].sort(
                (a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0),
              )[0];
              if (picked?.phrase) phrase = picked.phrase;
            }
          } catch (_) {}
        }
      }
      if (!phrase) phrase = 'hey clawsuu';
      await BackgroundService.start(phrase);
    }
  } catch {}
}
async function bringToForeground() {
  try { if (AppControl) await AppControl.bringToForeground(); } catch {}
}

interface AttachmentItem {
  id: string;
  uri: string;
  name: string;
  type: string;
  // Pre-read base64 of the file.
  data?: string;
  size?: number;
}

// v3.11.49: classify a desktop error text for the error card.
function classifyErrorText(t: string): 'timeout' | 'crash' | 'network' | 'ratelimit' | 'error' {
  if (/rate.?limit|429|too many requests|overloaded|quota/i.test(t)) return 'ratelimit';
  if (/timed?\s*out|timeout/i.test(t)) return 'timeout';
  if (/exited with code \d|agent CLI|crash/i.test(t)) return 'crash';
  if (/HTTP request failed|fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(t)) return 'network';
  return 'error';
}

interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  agentId?: string;
  agentName?: string; // v3.1.15: human-readable name from desktop (e.g. "Lamasuu")
  ts: number;
  attachments?: Array<{ uri: string; type: string; name: string; data?: string; size?: number }>; // v3.10.20 (+ v3.10.132: data/size for inline base64)
  // v3.10.85: which quest was active when this message
  // was sent. Captured at append time (not derived at
  // render time) so the chat history is self-documenting
  // even if the active quest changes later. `null` means
  // "no active quest" (the v3.10.82 default state).
  // `undefined` means legacy messages from before
  // v3.10.85 — render them as "no quest active" so the
  // chat doesn't show quest separators on the user's
  // entire old history.
  activeQuestId?: string | null;
  activeQuestName?: string | null;
  // Error-only diagnostic metadata attached when this bubble closes a task session as 'failed'.
  taskSummary?: {
    status: 'failed';
    durationMs: number;
    stepCount: number;
    // Distinct labels in chronological order. Use
    // these for the steps list in the renderer.
    steps: string[];
    // Error category classified by pattern-match on
    // the desktop's "Error: <text>" wire format.
    errorCategory: 'timeout' | 'crash' | 'network' | 'ratelimit' | 'error';
    // The full error text including the "Error:" prefix.
    // Preserved in case the renderer wants to show it
    // again or the user copies it.
    errorText: string;
  };
}

interface LogEntry {
  id: string;
  text: string;
  ts: number;
  type: 'info' | 'sent' | 'received' | 'error' | 'warn' | 'debug' | 'voice';
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
// Reduced from 0.68×w (cap 320) to 0.61×w (cap 290).
const ARENA_HEIGHT = Math.min(SCREEN_WIDTH * 0.61, 290);
const CHAT_STORAGE_KEY = 'cyberclaw-chat-history';
const ARCHIVE_STORAGE_KEY = 'cyberclaw-chat-archive';
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

type DateBucket = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'older';

const startOfDay = (d: Date) => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};

const startOfWeek = (d: Date) => {
  const c = startOfDay(d);
  const day = c.getDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7;
  c.setDate(c.getDate() - diffToMonday);
  return c;
};

const getDateBucket = (ts: number): DateBucket => {
  const now = new Date();
  const dayStartNow = startOfDay(now).getTime();
  const dayStartTs = startOfDay(new Date(ts)).getTime();

  if (dayStartTs === dayStartNow) return 'today';
  if (dayStartTs === dayStartNow - 24 * 60 * 60 * 1000) return 'yesterday';

  const weekStartNow = startOfWeek(now).getTime();
  const weekStartTs = startOfWeek(new Date(ts)).getTime();

  if (weekStartTs === weekStartNow) return 'thisWeek';
  if (weekStartTs === weekStartNow - 7 * 24 * 60 * 60 * 1000) return 'lastWeek';

  return 'older';
};

const getDateBucketLabel = (ts: number): string => {
  const bucket = getDateBucket(ts);
  if (bucket === 'today') return 'Today';
  if (bucket === 'yesterday') return 'Yesterday';
  if (bucket === 'thisWeek') return 'This Week';
  if (bucket === 'lastWeek') return 'Last Week';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};


export const syncLog: LogEntry[] = [];
const logListeners: ((e: LogEntry) => void)[] = [];

// Per-turn task session tracking.
interface TaskStep {
  ts: number;
  // Short label like "tool: exec", "audio sent",
  // "error: timeout", "chat received"
  label: string;
  // Original log entry id, for cross-referencing the
  // full text in the Log tab
  logId?: string;
}
interface TaskSession {
  id: string;
  startTs: number;
  // Snapshot of the user's request at the moment we opened the session, so the summary bubble can show "Task: <first 60 chars>..." even after…
  requestText: string;
  agentId: string;
  agentName?: string;
  // Steps captured during the session. Capped at 50 so
  // a runaway run doesn't blow up.
  steps: TaskStep[];
  // End state. 'open' while the agent is still working;
  // 'done' on agent reply; 'failed' on error bubble or
  // send_error event.
  status: 'open' | 'done' | 'failed';
  endTs?: number;
  // Final error text (if status === 'failed'). Stored
  // so the chat bubble renderer can show it without
  // re-parsing the message.
  errorText?: string;
}
let activeTaskSession: TaskSession | null = null;
let taskSessionCounter = 0;
let _lastFinishedTaskSession: TaskSession | null = null;

function startTaskSession(opts: {
  requestText: string;
  agentId: string;
  agentName?: string;
}): TaskSession {
  taskSessionCounter += 1;
  const session: TaskSession = {
    id: `task-${Date.now()}-${taskSessionCounter}`,
    startTs: Date.now(),
    requestText: opts.requestText,
    agentId: opts.agentId,
    agentName: opts.agentName,
    steps: [],
    status: 'open',
  };
  activeTaskSession = session;
  return session;
}

function appendTaskStep(step: Omit<TaskStep, 'ts'>): void {
  if (!activeTaskSession) return;
  activeTaskSession.steps.push({ ...step, ts: Date.now() });
  // Cap the array so a long-running task with hundreds
  // of captured events doesn't grow unbounded.
  if (activeTaskSession.steps.length > 50) {
    activeTaskSession.steps.splice(0, activeTaskSession.steps.length - 50);
  }
}

function closeTaskSession(status: 'done' | 'failed', errorText?: string): TaskSession | null {
  const s = activeTaskSession;
  if (!s) return null;
  s.status = status;
  s.endTs = Date.now();
  s.errorText = errorText;
  activeTaskSession = null;
  _lastFinishedTaskSession = s;
  return s;
}

// Helper: extract a short tool/action label from a log
// entry. The log text already has emoji prefixes and
// abbreviations we want to surface in the task summary.
function stepLabelFromLogEntry(e: LogEntry): string | null {
  const t = e.text || '';
  // Map common patterns from addLogEntry call sites to compact step labels.
  if (/^🟢 send: pressed/.test(t)) return 'send pressed';
  if (/^→ \[.+\]/.test(t)) return 'sent chat to desktop';
  if (/^📨 Chat message received from server/i.test(t)) return 'agent reply arrived';
  if (/^📨 Adding to chat/i.test(t)) return 'agent reply appended';
  if (/^🔊 AUDIO RESPONSE ARRIVED/i.test(t)) return 'audio response received';
  if (/^🎤 Wake detected/i.test(t)) return 'wake detected';
  if (/🎙️ enterVoiceMode/i.test(t)) return 'voice mode opened';
  if (/🎙️ Closing fullscreen/i.test(t)) return 'voice mode closed';
  if (/Voice message sent/i.test(t)) return 'voice message sent';
  if (/Connect failed/i.test(t)) return 'connect failed';
  if (/Connect timed out/i.test(t)) return 'connect timed out';
  if (/^⏱️/.test(t)) return 'timeout marker';
  if (/^⚠️/.test(t)) return 'warning';
  if (/^❌/.test(t)) return 'error marker';
  if (/^⬜/.test(t)) return 'empty input';
  return null;
}

export function addLogEntry(text: string, type: LogEntry['type'] = 'info') {
  const e: LogEntry = { id: `${Date.now()}-${Math.random()}`, text, ts: Date.now(), type };
  syncLog.push(e);
  if (syncLog.length > 300) syncLog.splice(0, syncLog.length - 300);
  logListeners.forEach(fn => fn(e));
  // When a task session is open, mirror the entry into it as a step.
  if (activeTaskSession) {
    const label = stepLabelFromLogEntry(e);
    if (label) {
      appendTaskStep({ label, logId: e.id });
    } else if (type === 'error' || type === 'warn') {
      // Errors and warnings we don't recognize still get
      // captured so the steps list reflects what went
      // sideways during the task.
      appendTaskStep({ label: `${type}: ${text.substring(0, 60)}`, logId: e.id });
    }
  }
  return e;
}
export function onLogEntry(fn: (e: LogEntry) => void) { logListeners.push(fn); }
export function offLogEntry(fn: (e: LogEntry) => void) {
  const i = logListeners.indexOf(fn); if (i >= 0) logListeners.splice(i, 1);
}

// Public helpers for the chat-bubble renderer so it can
// pull a structured summary off the most recently
// finished session.
export function getLastFinishedTaskSession(): TaskSession | null {
  // Returns the last closed session (we don't keep
  // history beyond what's needed to render the next
  // bubble — the Log tab keeps the full record).
  return _lastFinishedTaskSession;
}
export function formatTaskDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
}

// Module-scoped chat draft.
const chatDraftByKey: Record<string, string> = {};
const chatDraftKey = (aid: string | null, qid: string | null): string =>
  `${aid ?? 'null'}::${qid ?? 'null'}`;
export function getChatDraft(aid: string | null, qid: string | null): string {
  return chatDraftByKey[chatDraftKey(aid, qid)] || '';
}
export function setChatDraft(aid: string | null, qid: string | null, text: string): void {
  const k = chatDraftKey(aid, qid);
  if (text === '') {
    delete chatDraftByKey[k];
  } else {
    chatDraftByKey[k] = text;
  }
  schedulePersistChatUi();
}

// v3.11.45: Discord-style persistence. Drafts and the scroll position
// of every (companion, quest) chat survive app restarts. Scroll
// position = distance from the newest message (inverted list offset).
const CHAT_UI_STORAGE_KEY = 'cyberclaw-chat-ui-v1';
const chatScrollPosByKey: Record<string, number> = {};
export function getChatScrollPos(k: string): number { return chatScrollPosByKey[k] || 0; }
export function setChatScrollPos(k: string, y: number): void {
  if (y < 40) delete chatScrollPosByKey[k]; else chatScrollPosByKey[k] = Math.round(y);
  schedulePersistChatUi();
}
let chatUiPersistTimer: any = null;
function schedulePersistChatUi() {
  if (chatUiPersistTimer) clearTimeout(chatUiPersistTimer);
  chatUiPersistTimer = setTimeout(() => {
    chatUiPersistTimer = null;
    AsyncStorage.setItem(CHAT_UI_STORAGE_KEY, JSON.stringify({ drafts: chatDraftByKey, scroll: chatScrollPosByKey })).catch(() => {});
  }, 600);
}
let chatUiLoaded: Promise<void> | null = null;
export function loadChatUiState(): Promise<void> {
  if (!chatUiLoaded) {
    chatUiLoaded = AsyncStorage.getItem(CHAT_UI_STORAGE_KEY).then(raw => {
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.drafts) for (const k of Object.keys(d.drafts)) if (!(k in chatDraftByKey)) chatDraftByKey[k] = d.drafts[k];
      if (d && d.scroll) Object.assign(chatScrollPosByKey, d.scroll);
    }).catch(() => {});
  }
  return chatUiLoaded;
}

// ArenaHidden persistence.
let arenaHiddenPersistent = false;
export function getArenaHidden() { return arenaHiddenPersistent; }
export function setArenaHiddenPersistent(v: boolean) { arenaHiddenPersistent = v; }

type TabId = 'chat' | 'events' | 'log';

// Per-quest chat bucketing.
const DEFAULT_QUEST_KEY = '__default__';

// Stable message IDs for history/replay paths.
function stableHistoryMessageId(ts: number, text: string, suffix?: string): string {
  // 16 chars of text prefix is enough for human-readable uniqueness; combined with ts it gives near-zero collision probability.
  const t = (typeof ts === 'number' && isFinite(ts)) ? ts : 0;
  const textPart = (text || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `hist-${t}-${textPart}-${hash}${suffix ? '-' + suffix : ''}`;
}

// Per-device active-quest anchor.
let mobileActiveQuestAnchor: string | null | undefined = null;
// Persisted copy of the anchor across cold starts.
const ANCHOR_STORAGE_KEY = 'cyberclaw-mobile-active-quest-anchor';
// Subscribers re-render when the bootstrap completes.
// Each subscriber's callback receives the new value
// and bumps the React state to trigger a re-projection.
type AnchorSubscriber = (qid: string | null | undefined) => void;
const _anchorSubscribers = new Set<AnchorSubscriber>();
function notifyAnchorSubscribers(qid: string | null | undefined) {
  for (const fn of _anchorSubscribers) {
    try { fn(qid); } catch (_) { /* defensive */ }
  }
}
// Tracks whether the module-init bootstrap IIFE has completed at least once.
let _anchorBootstrapResolved = false;
export function subscribeMobileActiveQuestAnchor(fn: AnchorSubscriber) {
  _anchorSubscribers.add(fn);
  // Replay the current anchor value to the new subscriber IF the bootstrap has already resolved.
  if (_anchorBootstrapResolved) {
    try { fn(mobileActiveQuestAnchor); } catch (_) { /* defensive */ }
  }
  return () => { _anchorSubscribers.delete(fn); };
}
// Bootstrap: kick off an async load at module init so by the time HomeScreen mounts the anchor is hydrated.
(async () => {
  try {
    const v = await AsyncStorage.getItem(ANCHOR_STORAGE_KEY);
    let next: string | null | undefined;
    if (v === null) {
      // First run / never persisted. Leave the anchor
      // at its module-init value of null; the first
      // broadcast will seed it.
      next = undefined;
    } else if (v === '__null__') {
      // Explicit "user has no active quest" — restore
      // null (different from "haven't picked yet").
      next = null;
    } else {
      next = v;
    }
    if (next !== undefined) {
      mobileActiveQuestAnchor = next;
    }
  } catch (_) { /* storage failed — fall back to module init */ }
  _anchorBootstrapResolved = true;
})();
export function getMobileActiveQuestAnchor() {
  return mobileActiveQuestAnchor;
}
export function setMobileActiveQuestAnchor(qid: string | null | undefined) {
  mobileActiveQuestAnchor = qid;
  // Persist asynchronously; the module-scope variable is the synchronous source so the projection effect doesn't need to wait.
  try {
    if (qid == null) {
      // Distinguish "user explicitly deactivated" from
      // "haven't picked yet" via a sentinel string. The
      // cold-start bootstrap checks for this.
      AsyncStorage.setItem(ANCHOR_STORAGE_KEY, '__null__').catch(() => {});
    } else {
      AsyncStorage.setItem(ANCHOR_STORAGE_KEY, qid).catch(() => {});
    }
  } catch (_) { /* defensive */ }
}
// Stringify/parse helpers for the per-(agent, quest) AsyncStorage keys.
function questKeyForStorage(qid: string | null | undefined): string {
  return qid == null ? DEFAULT_QUEST_KEY : qid;
}
function questKeyFromStorage(qid: string): string | null {
  return qid === DEFAULT_QUEST_KEY ? null : qid;
}

// Per-companion chat helper.
function companionIconForActive(
  agents: Array<{ id: string; emoji?: string | null; icon?: string | null }>,
  activeId: string | null,
): string {
  if (!activeId) return '🐾';
  const a = (agents || []).find(x => x.id === activeId);
  return a?.emoji || a?.icon || '🐾';
}

// 2.
function appendAgentMessage(
  msg: ChatMessage,
  agentId: string,
  questId: string | null,
  setMessagesByAgentAndQuest: React.Dispatch<React.SetStateAction<Record<string, Record<string, ChatMessage[]>>>>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  activeAgentId: string | null,
  activeQuestId: string | null | undefined,
) {
  setMessagesByAgentAndQuest(prev => {
    const agentBuckets = prev[agentId] || {};
    const bucketKey = questKeyForStorage(questId);
    const list = agentBuckets[bucketKey] || [];
    // Expanded dedupe.
    const dupWindowMs = 60000;
    const dupWindowMsCrossRestart = 60 * 60 * 1000;  // 1h
    // v3.10.68: also strip a leading `[From: ...]`
    // prefix so the local-prefix and desktop-echo
    // paths dedupe to the same normalized text. The
    // v3.10.42 strip-prefix logic only handled
    // leading non-word chars (emoji etc.) — it kept
    // the `[` and everything after it as text. Now
    // we recognize the bracketed source tag and drop
    // the whole prefix. Keeps backwards-compat with
    // old chat history that has the prefix attached.
    const normalize = (s: string) =>
      (s || '')
        .replace(/^\[From:\s*[^\]]*\]\s*/, '')
        .replace(/^[^\w[\(]+/, '')
        .trim();
    const normalizedText = normalize(msg.text);
    const matchingText = (m: ChatMessage) =>
      normalize(m.text) === normalizedText;
    // Stage 1: same text + same isUser + within 60s —
    // likely a within-session echo duplicate.
    if (list.some(m =>
      matchingText(m) &&
      m.isUser === msg.isUser &&
      Math.abs(m.ts - msg.ts) < dupWindowMs
    )) {
      return prev;
    }
    // Stage 2: same text + same isUser + within 1h — catches cross-restart cases where mobile ts (yesterday) and desktop-rebroadcast ts (boot…
    if (list.some(m =>
      matchingText(m) &&
      m.isUser === msg.isUser &&
      Math.abs(m.ts - msg.ts) < dupWindowMsCrossRestart
    )) {
      return prev;
    }
    // Stage 3: same normalized text within 5 minutes — catches the mobile-local ↔ desktop-echo pair when timestamps drift far apart (slow…
    const dupWindowMsCrossEcho = 5 * 60 * 1000;  // 5 min
    // v3.10.110: limit cross-echo dedupe to SAME isUser
    // type. Previously Stage 3 matched any message with
    // the same normalized text within 5 minutes, which
    // could silently drop an agent reply if its text
    // happened to normalize-equal a recent user message
    // (e.g. user said "Yo" at 17:48 and the agent replied
    // with "Yo, I can do that" at 17:50 — the agent reply
    // got dropped because it matched the user's "Yo" by
    // prefix). Cross-echo dedupe should only catch
    // user↔user echo pairs and agent↔agent echo pairs,
    // not accidentally silence the OTHER side of the
    // conversation. Tobe's 2026-07-29 18:49 report:
    // "Yoyo. The Captcha and description looks good now."
    // got a desktop-side agent reply ("raid a captcha
    // farm...") but the bubble never appeared in the
    // mobile chat history — most likely cause.
    if (list.some(m =>
      matchingText(m) &&
      m.isUser === msg.isUser &&
      Math.abs(m.ts - msg.ts) < dupWindowMsCrossEcho
    )) {
      return prev;
    }
    const next = {
      ...prev,
      [agentId]: {
        ...agentBuckets,
        [bucketKey]: [...list, msg],
      },
    };
    // Always sync the visible chat to the active (agent, quest) bucket — NOT just when the new message's bucket matches.
    if (activeAgentId != null) {
      const activeBucketKey = questKeyForStorage(
        activeQuestId === undefined ? null : activeQuestId
      );
      const activeBucket =
        (next[activeAgentId] || {})[activeBucketKey] || [];
      setMessages(activeBucket);
    }
    return next;
  });
}

// Added onActiveCompanionChange prop.
export default function HomeScreen({ onOpenSettings, onOpenVoiceMode, onOpenQuests, onOpenSkills, onActiveCompanionChange, onAgentsChange }: { onOpenSettings: () => void; onOpenVoiceMode?: () => void; onOpenQuests?: () => void; onOpenSkills?: () => void; onActiveCompanionChange?: (id: string) => void; onAgentsChange?: (agents: Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>) => void }) {
  // Theme-aware container + chrome.
  const { theme } = useTheme();
  const t = theme;
  // Build the styles from the active theme. The styles
  // object is rebuilt only when the theme changes (memo).
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Derived list of image attachments from the current chat.
  const chatImages = useMemo(() => {
    const out: { msgId: string; att: { uri: string; type: string; name: string; data?: string } }[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.attachments)) continue;
      for (const att of m.attachments) {
        if (att && typeof att.type === 'string' && att.type.startsWith('image/')) {
          out.push({ msgId: m.id, att });
        }
      }
    }
    return out;
  }, [messages]);
  // Pagination.
  const VISIBLE_BATCH = 50;
  const [visibleCount, setVisibleCount] = useState<number>(VISIBLE_BATCH);
  // Per-companion chat history.
  const [isThinking, setIsThinking] = useState(false);
  const [messagesByAgentAndQuest, setMessagesByAgentAndQuest] = useState<Record<string, Record<string, ChatMessage[]>>>({});
  // v3.1.17: which companion's chat is currently shown. The
  // companion tab bar updates this when the user taps a tab.
  const [activeChatAgentId, setActiveChatAgentId] = useState<string | null>(null);

  // Which quest's chat bucket is currently shown.
  const [activeChatQuestId, setActiveChatQuestId] = useState<string | null | undefined>(undefined);

  // Per-chat draft refs.
  const lastDraftKeyRef = useRef<string | null>(null);
  // v3.11.44/45: casual chat view (declared early — drafts depend on it)
  const [chatCasual, setChatCasual] = useState(false);
  const draftAidRef = useRef<string | null>(activeChatAgentId);
  // Projection effect refs.
  const lastProjectedKeyRef = useRef<string | null>(null);
  const lastProjectedMessagesLenRef = useRef<number>(0);
  // Scroll-to-bottom latch.
  const pendingScrollKeyRef = useRef<string | null>(null);
  const pendingScrollLenRef = useRef<number>(0);
  // Track the latest onScroll values so the onContentSizeChange handler can compute distance-from- end when content grows (e.g., "Load more"…
  const lastScrollYRef = useRef<number>(0);
  const lastViewportHeightRef = useRef<number>(0);
  const draftQidRef = useRef<string | null>(
    activeChatQuestId === undefined ? null : activeChatQuestId);

  // Per-chat draft sync effect.
  useEffect(() => {
    const aid: string | null = activeChatAgentId;
    const qid: string | null = (chatCasual || activeChatQuestId === undefined) ? null : activeChatQuestId;
    draftAidRef.current = aid;
    draftQidRef.current = qid;
    // Only swap the visible text if the conversation actually changed.
    const prev = lastDraftKeyRef.current;
    const next = `${aid ?? 'null'}::${qid ?? 'null'}`;
    lastDraftKeyRef.current = next;
    if (prev !== null && prev !== next) {
      setInputTextLocal(getChatDraft(aid, qid));
    }
  }, [activeChatAgentId, activeChatQuestId, chatCasual]);

  // Report the active chat companion back to App.tsx so WakeModeScreen knows which companion to display.
  useEffect(() => {
    if (activeChatAgentId) onActiveCompanionChange?.(activeChatAgentId);
  }, [activeChatAgentId, onActiveCompanionChange]);
  // v3.1.17: unread message count per companion, used to badge
  // companion tabs when the user is on a different one.
  const [chatUnreadByAgent, setChatUnreadByAgent] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([...syncLog]);
  // InputText persists across Settings navigation via module-scope `chatDraft`.
  const [inputText, setInputTextLocal] = useState(() =>
    getChatDraft(activeChatAgentId, activeChatQuestId ?? null));
  // v3.11.45: restore drafts saved before the app was closed.
  useEffect(() => {
    loadChatUiState().then(() => {
      const cur = getChatDraft(draftAidRef.current, draftQidRef.current);
      if (cur) setInputTextLocal(prev => prev || cur);
    });
  }, []);
  const setInputText = (s: string) => {
    setChatDraft(draftAidRef.current, draftQidRef.current, s);
    setInputTextLocal(s);
  };
  // Local-LLM pill state.
  const [llmStatus, setLlmStatus] = useState<any | null>(null);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  // Fullscreen attachment viewer.
  const [fullscreenAttachment, setFullscreenAttachment] = useState<{ uri: string; type: string; name: string; data?: string } | null>(null);
  // Image gallery overlay.
  const [galleryOpen, setGalleryOpen] = useState<boolean>(false);

  const [connState, setConnState] = useState<string>(syncClient.state);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Keyboard height tracking.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [chatVoiceStatus, setChatVoiceStatus] = useState<string | null>(null);
  // Claude-style action log.
  const [chatActions, setChatActions] = useState<string[]>([]);
  // v3.11.48: seconds since the companion started working (thinking bar).
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  // v3.11.51: auto-scroll latch. Real new messages keep the chat pinned for
  // one render, then we stop touching the user's scroll position. History
  // re-syncs and activity pings stay on the user's current view.
  const [autoScrollTick, setAutoScrollTick] = useState(0);
  const autoScrollEnabledRef = useRef(false);
  const autoScrollMaintainConfig = useMemo(() => {
    if (!autoScrollEnabledRef.current) return undefined;
    return { minIndexForVisible: 0, autoscrollToTopThreshold: 80 };
  }, [autoScrollTick]);
  // v3.11.50: final state of the status line (Done / error / stopped).
  const finishTimerRef = useRef<any>(null);
  const finishedLabelRef = useRef<string | null>(null);
  const finishThinkingRef = useRef<((kind: 'done' | 'error' | 'stopped') => void) | null>(null);
  // Animated value driving the pulsing-dot "is thinking..." spinner.
  const thinkPulse = useRef(new Animated.Value(0)).current;
  const indicatorOpacity = useRef(new Animated.Value(0)).current;
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // Arena can be hidden to give the chat list more vertical room.
  const [arenaHidden, setArenaHidden] = useState(getArenaHidden());
  const toggleArenaHidden = () => {
    const next = !arenaHidden;
    setArenaHidden(next);
    setArenaHiddenPersistent(next);
  };
  const [silenceCountdown, setSilenceCountdown] = useState(0);
  const [isLandscape, setIsLandscape] = useState(false);
  // Set of bubble ids whose error card is currently collapsed.
  const [collapsedTaskCards, setCollapsedTaskCards] = useState<Set<string>>(new Set());
  const [voiceStatus, setVoiceStatus] = useState<string>('idle');
  const [voiceLogs, setVoiceLogs] = useState<string[]>([]);
  const [companionId, setCompanionId] = useState('boar');
  // Full list of agents (id, name, sprite) broadcast by the desktop so the mobile arena can show all companions, not just the active one.
  const [agents, setAgents] = useState<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null; sleepState?: 'awake' | 'sleeping' }>>(() => {
    try {
      // Eager synchronous read isn't possible with AsyncStorage, so
      // we leave this empty and let the useEffect below hydrate it
      // from storage on mount.
      return [];
    } catch (_) {
      return [];
    }
  });
  const [webViewKey, setWebViewKey] = useState(0);
  const chatRef = useRef<FlatList>(null);
  // v3.11.45: Discord-style chat = inverted FlatList, newest first.
  const chatData = useMemo(() => messages.slice(-visibleCount).reverse(), [messages, visibleCount]);
  const chatDataRef = useRef<ChatMessage[]>([]);
  // v3.11.49: id of my most recent message (gets the small resend button).
  const lastUserMsgId = useMemo(() => chatData.find(m => m.isUser)?.id || null, [chatData]);
  chatDataRef.current = chatData;
  const chatScrollKeyRef = useRef<string>('');
  const pendingRestoreRef = useRef<string | null>(null);
  const eventsRef = useRef<FlatList>(null);
  const logRef = useRef<FlatList>(null);
  // Only auto-scroll the log to the bottom if the user is already near the bottom.
  const logStickyBottomRef = useRef(true);
  const webViewRef = useRef<WebView>(null);
  // Latest known WebView container size.
  const webViewSizeRef = useRef<{ w: number; h: number } | null>(null);
  // Chat auto-scroll state — only auto-scroll to the newest message when the user is already at (or near) the bottom of the chat.
  const [chatAtBottom, setChatAtBottom] = useState(true);
  // Mirror `chatAtBottom` into a ref so the FlatList's `onContentSizeChange` handler can read the latest value without a stale closure.
  const chatAtBottomRef = useRef(true);
  useEffect(() => { chatAtBottomRef.current = chatAtBottom; }, [chatAtBottom]);
  // Continuous pulse loop for the thinking-dot spinner.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(thinkPulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(thinkPulse, { toValue: 0, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [thinkPulse]);
  // Fade the indicator bar in/out when chatVoiceStatus flips.
  const lastVoiceStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const wasOn = lastVoiceStatusRef.current != null;
    const isOn = chatVoiceStatus != null;
    lastVoiceStatusRef.current = chatVoiceStatus;
    if (isOn && !wasOn) {
      setChatActions([]);
      setThinkingElapsed(0);
      Animated.timing(indicatorOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    } else if (!isOn && wasOn) {
      Animated.timing(indicatorOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    }
  }, [chatVoiceStatus, indicatorOpacity]);
  // v3.11.48: tick the elapsed timer while the thinking bar is visible.
  useEffect(() => {
    if (!chatVoiceStatus) return;
    const id = setInterval(() => {
      const start = thinkingStartedAtRef.current;
      setThinkingElapsed(start ? Math.floor((Date.now() - start) / 1000) : 0);
    }, 1000);
    return () => clearInterval(id);
  }, [chatVoiceStatus]);
  // SCROLL BEHAVIOR REWRITE.
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const fullscreenRef = useRef(false);
  // Mirror of activeTab so the chat-event handler can check whether the chat tab is the currently visible tab without a stale-closure bug.
  const activeTabRef = useRef<TabId>('chat');
  const isWakeWordStoppedRef = useRef<boolean>(true);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false); // true while recording/transcribing in wake mode
  // v3.1.17: stable refs that mirror the per-companion state so the
  // sync-event handlers (defined inside the main useEffect) can
  // read the latest values without a stale-closure bug.
  const activeChatAgentIdRef = useRef<string | null>(null);
  // Ref mirror of the per-(agent,quest) chat cache.
  const messagesByAgentRef = useRef<Record<string, Record<string, ChatMessage[]>>>({});
  // Forward-declared ref to sendMessage so the recent-pills long-press handler (defined inline in the JSX) can call the latest sendMessage…
  const sendMessageRef = useRef<(() => Promise<void>) | null>(null);
  // v3.1.16: same trick for the agents list so onTyping and
  // other handlers can read the latest names without a stale
  // closure over the `agents` state.
  const agentsRef = useRef<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>>([]);
  // Report the latest agents list to App.tsx so WakeModeScreen (which mounts a fresh WebView) can call setAgents with the same data.
  const onAgentsChangeRef = useRef(onAgentsChange);
  onAgentsChangeRef.current = onAgentsChange;
  // The companion id the WebView was initialised with.
  const initialArenaCompanionRef = useRef<string | null>(null);
  if (initialArenaCompanionRef.current === null) {
    initialArenaCompanionRef.current = companionId;
  }
  // Set to true the first time agents_list arrives, so we only inject the initial companion sprite into the WebView once.
  const initialArenaInjectedRef = useRef(false);

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // v3.1.17: keep stable refs in sync with the per-companion state
  // so the sync-event handlers in the main useEffect don't capture
  // stale values.
  useEffect(() => { activeChatAgentIdRef.current = activeChatAgentId; }, [activeChatAgentId]);
  useEffect(() => { messagesByAgentRef.current = messagesByAgentAndQuest; }, [messagesByAgentAndQuest]);
  // Subscribe to the mobileActiveQuestAnchor module-scope bootstrap read.
  const [anchorHydrateTick, setAnchorHydrateTick] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeMobileActiveQuestAnchor((qid) => {
      setAnchorHydrateTick(t => t + 1);
    });
    return unsubscribe;
  }, []);
  // Per-device quest name lookup.
  const [questNameById, setQuestNameById] = useState<Record<string, string>>({});
  const questNameByIdRef = useRef<Record<string, string>>({});
  useEffect(() => { questNameByIdRef.current = questNameById; }, [questNameById]);

  // Snapshot of the active quest at any given moment.
  const activeQuestRef = useRef<{ id: string; name: string } | null | undefined>(undefined);
  // v3.11.44: casual/quest chat toggle (mirrors the desktop). The quest
  // stays ACTIVE; this only switches which chat is shown and where new
  // messages go. Shared with the desktop via chat_context.
  const chatCasualRef = useRef(false);
  const [activeQuestInfo, setActiveQuestInfo] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { chatCasualRef.current = chatCasual; }, [chatCasual]);
  useEffect(() => {
    const onCtx = (m: any) => setChatCasual(!!m?.casual);
    syncClient.on('chat_context', onCtx);
    return () => syncClient.off('chat_context', onCtx);
  }, []);
  useEffect(() => { if (!activeQuestInfo) setChatCasual(false); }, [activeQuestInfo]);
  // Per-device active-quest anchor lives in module-scope (`mobileActiveQuestAnchor` near the top of this file) so both HomeScreen's…
  const thinkingStickyRef = useRef(false);
  // Long-wait escalation refs.
  const thinkingStartedAtRef = useRef<number | null>(null);
  finishThinkingRef.current = (kind) => {
    const start = thinkingStartedAtRef.current;
    const secs = start ? Math.round((Date.now() - start) / 1000) : 0;
    const t = secs ? ' · ' + (secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's') : '';
    const label = kind === 'done' ? '✓ Done' + t
      : kind === 'error' ? '⚠️ Stopped with an error' + t + ' — see the card below'
      : '■ Stopped without a reply' + t + ' — tap Resend to try again';
    finishedLabelRef.current = label;
    setChatVoiceStatus(label);
    if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
    // v3.11.51: 3 s for ✓ Done is plenty — the reply is already on screen. Errors and
    // stopped-without-reply stick around so the user notices.
    finishTimerRef.current = setTimeout(() => {
      finishTimerRef.current = null;
      setChatVoiceStatus(cur => (cur === label ? null : cur));
      if (finishedLabelRef.current === label) finishedLabelRef.current = null;
    }, kind === 'done' ? 3000 : 30000);
  };
  // v3.11.51: hide the finished label immediately when the reply is already
  // on screen, or when the user starts typing. The reply itself is the
  // "done" — the status line is noise after that.
  useEffect(() => {
    if (!finishedLabelRef.current) return;
    const last = messages.length ? messages[messages.length - 1] : null;
    if (last && !last.isUser) {
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      setChatVoiceStatus(null);
      finishedLabelRef.current = null;
    }
  }, [messages]);
  useEffect(() => {
    if (inputText && inputText.length > 0 && finishedLabelRef.current) {
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      setChatVoiceStatus(null);
      finishedLabelRef.current = null;
    }
  }, [inputText]);
  const thinkingEscalateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // Sync the visible `messages` view to the active agent's bucket whenever activeChatAgentId changes.
  useEffect(() => {
    if (activeChatAgentId == null) {
      // No active agent — leave `messages` as-is, in case the user is in the middle of typing and we don't want to wipe the visible chat.
      return;
    }
    const aid = activeChatAgentId;
    // Prefer `mobileActiveQuestAnchor` over `activeQuestRef.current` for the projection bucket key.
    let qid: string | null;
    let skipBucketLookup = false;
    if (mobileActiveQuestAnchor !== null && mobileActiveQuestAnchor !== undefined) {
      // Anchor is the user's choice (or was seeded by
      // a fresh broadcast). Use it directly.
      qid = mobileActiveQuestAnchor;
    } else if (!_anchorBootstrapResolved) {
      // Bootstrap pending.
      qid = null;
      skipBucketLookup = true;
    } else if (activeQuestRef.current !== undefined) {
      // Anchor is null AND the bootstrap has resolved AND returned null (user explicitly deactivated).
      qid = activeQuestRef.current?.id ?? null;
    } else {
      // Anchor is null AND bootstrap resolved with null AND no ref is set.
      qid = null;
    }
    if (chatCasual) { qid = null; skipBucketLookup = false; } // v3.11.44
    const agentBuckets = messagesByAgentRef.current[aid] || {};
    const bucketKey = questKeyForStorage(qid);
    const bucket = skipBucketLookup ? [] : (agentBuckets[bucketKey] || []);
    setMessages(bucket);
    // Scroll-to-bottom latch moves to onContentSizeChange.
    const chatChanged =
      lastProjectedKeyRef.current !== null &&
      lastProjectedKeyRef.current !== `${aid}::${bucketKey}`;
    const bucketGrew =
      bucket.length > lastProjectedMessagesLenRef.current;
    // Reset pagination when the user switches to a different (agent, quest) chat.
    if (chatChanged) {
      setVisibleCount(VISIBLE_BATCH);
    }
    chatScrollKeyRef.current = aid + '::' + bucketKey;
    if (chatChanged || lastProjectedKeyRef.current === null) pendingRestoreRef.current = aid + '::' + bucketKey;
    if (chatChanged || bucketGrew) {
      // Set the latch. The onContentSizeChange handler
      // will consume it on the first fire where the
      // FlatList has measured non-zero content.
      pendingScrollKeyRef.current = `${aid}::${bucketKey}`;
      pendingScrollLenRef.current = bucket.length;
    }
    lastProjectedKeyRef.current = `${aid}::${bucketKey}`;
    lastProjectedMessagesLenRef.current = bucket.length;
  }, [activeChatAgentId, activeChatQuestId, anchorHydrateTick, chatCasual]);

  // Inject setCentered(true) when voice mode (fullscreen) is entered, setCentered(false) when exited.

  // v3.1.18: hydrate the agents list from AsyncStorage on mount so
  // the companion tab bar shows immediately, even if the desktop
  // hasn't sent agents_list yet (slow reconnect, etc.).
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-agents-cache').then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAgents(parsed);
          // Propagate cached agents to App.tsx too, so WakeModeScreen has the list immediately if the user opens wake mode before the WebSocket…
          onAgentsChangeRef.current?.(parsed);
          addLogEntry(`Loaded ${parsed.length} companion(s) from local cache`, 'info');
        }
      } catch (_) {}
    }).catch(() => {});
  }, []);

  // Persist the agents list whenever it changes so a remount (e.g.
  useEffect(() => {
    if (agents.length === 0) return;
    AsyncStorage.setItem('cyberclaw-agents-cache', JSON.stringify(agents)).catch(() => {});
  }, [agents]);

  // Derive a sleep styling flag from the active agent's sleepState.
  const sleepOverlay = (() => {
    const active = agents.find(a => a.id === activeChatAgentId);
    return active?.sleepState === 'sleeping';
  })();

  // Load companion selection from storage on mount
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-arena-comp').then(v => {
      if (v) {
        addLogEntry('Loaded companion from storage: ' + v, 'info');
        setCompanionId(v);
      }
    }).catch(() => {});

    // Ask the desktop for the current agents list on every mount.
    const requestWithRetry = (attempt: number) => {
      try {
        if (syncClient.connected) {
          syncClient.requestAgentsList();
          addLogEntry('→ Requested agents list from desktop', 'sent');
        } else if (attempt < 5) {
          addLogEntry(`WS not ready, retrying requestAgentsList (attempt ${attempt + 1})`, 'debug');
          setTimeout(() => requestWithRetry(attempt + 1), 800);
        } else {
          addLogEntry('Gave up requesting agents list (WS never opened)', 'warn');
        }
      } catch (e) {
        addLogEntry(`Request agents list failed: ${(e as any)?.message}`, 'error');
      }
    };
    requestWithRetry(0);

    // Test native module
    console.log('[Native] Available modules:', Object.keys(NativeModules).join(', '));
    if (NativeModules.NativeBackground) {
      try {
        NativeModules.NativeBackground.test();
        console.log('[Native] NativeBackground.test() called successfully');
      } catch (e: any) {
        console.error('[Native] Error calling test:', e.message);
      }
    } else {
      console.warn('[Native] NativeBackground module not available!');
      console.warn('[Native] Available:', Object.keys(NativeModules));
    }
  }, []);

  // Stop speech + flush scroll state on unmount.
  useEffect(() => {
    return () => {
      try {
        if (webViewRef?.current) {
          webViewRef.current.injectJavaScript('if (window.speechSynthesis) { window.speechSynthesis.pause?.(); window.speechSynthesis.cancel?.(); } true;');
        }
      } catch (_) { /* swallow on unmount */ }
    };
  }, []);

  // Speak via WebView TTS
  const speak = useCallback((text: string) => {
    if (!ttsEnabled) return;
    // Prefer native Android TTS - works reliably even when AudioRecord is active
    if (WakeWordModule?.speakText) {
      WakeWordModule.speakText(text).catch(() => {
        // Fallback: WebView speechSynthesis
        if (!webViewRef.current) return;
        const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
        webViewRef.current.injectJavaScript(
          `if('speechSynthesis'in window){window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${escaped}');u.rate=0.95;u.pitch=1.1;window.speechSynthesis.speak(u);}true;`
        );
      });
    } else if (webViewRef.current) {
      const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
      webViewRef.current.injectJavaScript(
        `if('speechSynthesis'in window){window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${escaped}');u.rate=0.95;u.pitch=1.1;window.speechSynthesis.speak(u);}true;`
      );
    }
  }, [ttsEnabled]);

  // Propagate thinking state to both WebViews
  const setArenaThinking = useCallback((active: boolean) => {
    const jsActive = `window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: true }) })); document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: true }) })); true;`;
    const jsInactive = `window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: false }) })); document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: false }) })); true;`;
    const inject = active ? jsActive : jsInactive;
    webViewRef.current?.injectJavaScript(inject);
  }, []);

  // v3.1.89: bump from 4 to 5 log lines so the Speaking /
  // Greeting / fallback decision are all visible together.
  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => {
      const updated = [...prev, text];
      return updated.slice(-5);  // Keep last 5 logs
    });
  }, []);

  // Close fullscreen mode and reset state - CANCEL any recording
  const closeFullscreen = useCallback(async () => {
    addLogEntry('🎙️ Closing fullscreen - cancel & cleanup', 'debug');
    addVoiceLog('Exit');
    setFullscreen(false);
    fullscreenRef.current = false;
    setVoiceStatus('idle');
    setIsVoiceListening(false);
    setIsWakeWordMode(false);
    isWakeWordModeRef.current = false;
    AppControl?.keepScreenOn?.(false);

    // CRITICAL: Stop any active recording
    try {
      const recorder = getSimpleAudioRecorder();
      await recorder.stop();
      addLogEntry('Recording cancelled on exit', 'info');
    } catch (e) {
      // Recording already stopped or not running
    }

    // CRITICAL: Stop any in-progress audio playback
    try { WakeWordModule?.stopPlayer?.(); } catch (_) {}

    // Clear pending audio/attachments
    setPendingAudioPath(null);
    setAttachments([]);
    setWakeWordSession(null);

    // CRITICAL: Remove fullscreen CSS classes from HTML
    const js = `
      document.getElementById('ui').classList.remove('fullscreen');
      document.getElementById('c').classList.remove('fullscreen');
      window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})}));
      document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})}));
      true;
    `;
    webViewRef.current?.injectJavaScript(js);
    addLogEntry('Voice mode exited - all cancelled', 'info');
  }, []);

  // Simplified enterVoiceMode - only handles wakeword wake-up
  const enterVoiceMode = useCallback(async (source: 'wakeword' | 'focus' = 'focus') => {
    addLogEntry(`🎙️ enterVoiceMode called (source=${source})`, 'info');
    // Kick the active companion awake on any voice-mode entry.
    try {
      const aid = activeChatAgentIdRef.current || 'companion';
      syncClient.sendWakeAgent(aid);
    } catch (_) {}
    // For wakeword, route to the dedicated WakeModeScreen — same as the user tapping the Wake Mode button.
    if (source === 'wakeword') {
      // Clear the in-home fullscreen state — we're handing off to the
      // dedicated screen which manages its own UI and recording.
      if (fullscreenRef.current) {
        setFullscreen(false);
        fullscreenRef.current = false;
      }
      setIsWakeWordMode(false);
      isWakeWordModeRef.current = false;
      // The per-render watcher that depended on this module-level flag is gone.
      try { await AsyncStorage.removeItem('cyberclaw-wake-pending'); } catch (_) {}
      wakeWordBusyRef.current = false;
      addLogEntry('🎙️ Voice Mode: handing off to dedicated VoiceModeScreen', 'info');
      // v3.2.18: Wake Mode is gone. Voice Mode is the only
      // fullscreen — it does the wake-listening + recording.
      onOpenVoiceMode?.();
      return;
    } else {
      // Focus source (manual mic tap) — old behaviour
      setVoiceLogs([]);
      addVoiceLog('🎙️ Listening...');
      AppControl?.keepScreenOn?.(true);
      setFullscreen(true);
      fullscreenRef.current = true;
    }

    // Initialize Voice Activity Detection
    const vad = getVAD({ sampleRate: 16000, frameSize: 512, silenceThreshold: 0.02 });
    resetVAD();
    if (source !== 'wakeword') addVoiceLog('🎙️ VAD ready');

    // Auto-start listening with SimpleAudioRecorder + countdown on silence (runs always)
    try {
        const fs = require('react-native-fs');
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.wav`;
        const recorder = getSimpleAudioRecorder();

        // FIXED: Track whether we've transitioned to 'recording' state
        let hasTransitionedToRecording = false;

        // Set up silence detection: start countdown and auto-send
        // TODO: Integrate VAD for smarter end-of-speech detection
        let countdownInterval: NodeJS.Timeout | null = null;
        let silenceEventFired = false;
        let maxDurationTimeout: NodeJS.Timeout | null = null;
        let audioSent = false; // guard: only send once

        // VAD will replace this with frame-by-frame analysis
        const vad = getVAD();

        const unsubSilence = recorder.once('silence', async () => {
          silenceEventFired = true;
          addVoiceLog('⏳ Silence detected...');
          addLogEntry('Silence detected after 5s', 'info');
          setVoiceStatus('silence_countdown');
          let count = 3;
          setSilenceCountdown(count);

          countdownInterval = setInterval(() => {
            count--;
            setSilenceCountdown(count);
            if (count <= 0) {
              if (countdownInterval) clearInterval(countdownInterval);
              if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
              addLogEntry('Countdown complete, sending audio', 'info');
              // Auto-stop and send
              recorder.stop().then(async (resultPath: string) => {
                setIsVoiceListening(false);
                if (!resultPath) {
                  setVoiceStatus('idle');
                  addLogEntry('No recording path returned', 'error');
                  return;
                }
                try {
                  const stats = await fs.stat(resultPath);
                  addLogEntry(`Audio file: ${stats.size} bytes`, 'info');
                  const base64 = await fs.readFile(resultPath, 'base64');
                  addLogEntry(`Base64 size: ${base64.length} chars`, 'info');
                  if (base64.length < 100) {
                    addLogEntry('Base64 audio very small', 'error');
                  }
                  if (audioSent) { addLogEntry('Already sent, skipping duplicate', 'debug'); return; }
                  audioSent = true;
                  addVoiceLog('📏 Sending...');
                  setVoiceStatus('transcribing');
                  syncClient.sendAudioInput(base64, 'audio/wav');
                  addLogEntry('Voice message sent for transcription', 'sent');

                  // IMPORTANT: Don't exit voice mode!
                  // Set up listener for response and restart listening after
                  // (Desktop will process and respond with audio)

                } catch (e: any) {
                  setVoiceStatus('idle');
                  addLogEntry(`Send error: ${e?.message}`, 'error');
                }
              }).catch((e: any) => {
                setIsVoiceListening(false);
                setVoiceStatus('idle');
                addLogEntry(`Stop recording error: ${e?.message}`, 'error');
              });
            }
          }, 1000);
        });

        await recorder.start(recPath, 1800); // v3.11.36: 1.8s silence timeout (default from VoiceSettings.DEFAULT_SILENCE_MS)
        setIsVoiceListening(true);

        // FIXED #1: Add audio detection timer
        // If still in 'listening' status after 500ms, assume audio is being captured
        // This gives visual feedback that the recorder is active
        let audioDetectTimer: NodeJS.Timeout | null = null;
        audioDetectTimer = setTimeout(() => {
          if (!hasTransitionedToRecording && fullscreenRef.current) {
            hasTransitionedToRecording = true;
            setVoiceStatus('recording');
            addVoiceLog('🔴 Recording...');
            addLogEntry('Audio detection timeout - status: recording', 'info');
          }
        }, 500);

        // FIXED #2: Add max duration fallback (30s)
        // If silence event doesn't fire after 30s, auto-stop and send
        maxDurationTimeout = setTimeout(() => {
          if (!silenceEventFired && isVoiceListening) {
            addLogEntry('Max duration (30s) reached - silence event may not have fired', 'error');
            if (countdownInterval) clearInterval(countdownInterval);
            if (audioDetectTimer) clearTimeout(audioDetectTimer);

            recorder.stop().then(async (resultPath: string) => {
              setIsVoiceListening(false);
              if (!resultPath) {
                setVoiceStatus('idle');
                return;
              }
              try {
                const base64 = await fs.readFile(resultPath, 'base64');
                if (audioSent) { addLogEntry('Already sent (max-duration), skipping', 'debug'); return; }
                audioSent = true;
                setVoiceStatus('transcribing');
                syncClient.sendAudioInput(base64, 'audio/wav');
                addLogEntry('Forced send after max duration', 'sent');
              } catch (e: any) {
                setVoiceStatus('idle');
                addLogEntry(`Send error after timeout: ${e?.message}`, 'error');
              }
            }).catch((e: any) => {
              setIsVoiceListening(false);
              setVoiceStatus('idle');
              addLogEntry(`Stop error after timeout: ${e?.message}`, 'error');
            });
          }
        }, 30000);

        setVoiceStatus('listening');
        addLogEntry('Voice mode: listening for audio', 'info');
      } catch (e) {
        setVoiceStatus('idle');
        addLogEntry(`Voice recording failed: ${e?.message}`, 'error');
      }
  }, []);

  // Handle messages from arena (companion screen)
  const handleArenaMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      addLogEntry(`🎬 Arena message: type=${msg.type}`, 'debug');
      // v3.1.57: show the payload for the diagnostic events
      // added in v3.1.56, so the log captures the actual
      // scale values flowing through (not just the type).
      if (msg.type === 'arena_scale_update') {
        addLogEntry(
          `🔍 scale_update: ${msg.id} ${msg.from}→${msg.to} (desktop sent: ${msg.incoming})`,
          'info',
        );
      } else if (msg.type === 'arena_full_rebuild') {
        const fromStr = (msg.from || []).map((c: any) => `${c.id}@${c.scale}`).join(',');
        const toStr = (msg.to || []).map((c: any) => `${c.id}@${c.scale}`).join(',');
        addLogEntry(
          `🔍 full_rebuild: from=[${fromStr}] to=[${toStr}]`,
          'info',
        );
      }
      // OpenArenaSettings is a no-op now.
      if (msg.type === 'openArenaSettings') {
        addLogEntry('openArenaSettings ignored — mobile uses desktop arena settings', 'debug');
        return;
      }

      if (msg.type === 'log') {
        // Log message from arena - display in app logs
        addLogEntry(msg.text || 'Arena log', 'info');
        return;
      }

      if (msg.type === 'fullscreen') {
        // Route to the dedicated VoiceModeScreen (same component as WakeModeScreen but with the wake listener replaced by the VAD + recorder).
        addLogEntry(`🎙️ Voice Mode: opening dedicated screen`, 'debug');
        onOpenVoiceMode?.();
      }
      if (msg.type === 'wakeword') {
        // v3.2.18: legacy Wake Mode arena button. Route to
        // Voice Mode instead.
        addLogEntry(`🗣️ Wake Mode toggle from arena → Voice Mode`, 'debug');
        onOpenVoiceMode?.();
      }
      if (msg.type === 'exitFullscreen') {
        // X button in Voice Mode — Voice Mode owns its own onExit handler.
        addLogEntry('Exiting fullscreen via X button', 'debug');
        onOpenVoiceMode && closeFullscreen();
      }
      if (msg.type === 'saveBg') {
        AsyncStorage.setItem('cyberclaw-arena-bg', msg.value);
      }
      if (msg.type === 'saveComp') {
        AsyncStorage.setItem('cyberclaw-arena-comp', msg.value);
      }
      if (msg.type === 'quests') {
        // Arena Quests button (top-left, mirrors Voice Mode at top-right).
        if (onOpenQuests) {
          addLogEntry('📜 Arena Quests → global Quests page', 'debug');
          onOpenQuests();
        } else {
          addLogEntry('📜 Arena Quests ignored — no handler', 'debug');
        }
      }
      if (msg.type === 'skills') {
        // Arena Skills button → global Skills page (mirror of the Quests flow).
        if (onOpenSkills) {
          addLogEntry('📚 Arena Skills → global Skills page', 'debug');
          onOpenSkills();
        } else {
          addLogEntry('📚 Arena Skills ignored — no handler', 'debug');
        }
      }
      if (msg.type === 'treat_placed') {
        // Arena forwarded a treat_drop success.
        syncClient.send({
          type: 'arena_treat_placed',
          treat: msg.treat,
          ...(msg.companionId ? { companionId: msg.companionId } : {}),
        });
      }
      if (msg.type === 'treat_eaten') {
        // Companion ate a treat.
        syncClient.send({
          type: 'arena_treat_eaten',
          treat: msg.treat,
          ...(msg.companionId ? { companionId: msg.companionId } : {}),
        });
      }
    } catch {}
  }, [closeFullscreen, onOpenQuests]);

  // Handle Android back button in fullscreen mode v3.2.18: Wake Mode is gone.
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fullscreen) {
        closeFullscreen();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [fullscreen, closeFullscreen]);

  // Wake word → enter voice mode with lock screen Wake word → hand off to the dedicated WakeModeScreen v3.1.26: this is now a thin wrapper.
  const handleWakeWord = useCallback(async (matchedCompanionId?: string) => {
    // Also respect the just-exited guard at the listener level, not just in checkPending.
    if (isWakeJustExited()) {
      addLogEntry('🎤 Wake detected but just exited — ignoring', 'debug');
      return;
    }
    try { NativeModules.NativeBackground?.showToast?.('🎤 Wake word detected!'); } catch (_) {}
    addLogEntry(`🎤 Wake word detected (matched: ${matchedCompanionId || 'unknown'}) - handing off to WakeModeScreen`, 'info');
    // v3.1.67: switch to the matched companion so the
    // wake mode shows the right one. Each companion has
    // its own wake word now.
    if (matchedCompanionId) {
      onActiveCompanionChange?.(matchedCompanionId);
    }

    if (wakeWordBusyRef.current) {
      addLogEntry('Wake word detected but already busy - ignoring', 'debug');
      return;
    }
    wakeWordBusyRef.current = true;

    // Stop sample listener — it would conflict with WakeModeScreen's
    // own audio capture. WakeModeScreen restarts it on exit.
    sampleListenerCleanupRef.current?.();
    sampleListenerCleanupRef.current = null;

    // Persist the wake event.
    try { await AsyncStorage.setItem('cyberclaw-wake-pending', '1'); } catch (_) {}
    setTimeout(() => { AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {}); }, 30000);

    // Route to Voice Mode (the new single fullscreen entry).
    try { onOpenVoiceMode?.(); } catch (_) {}

    // wakeWordBusyRef is cleared in WakeModeScreen's onExit handler.
  }, [onOpenVoiceMode]);

  // Check for a pending wake event from a previous mount or state wipe.
  const [wakePendingCheckCounter, setWakePendingCheckCounter] = useState(0);
  useEffect(() => {
    let consumed = false;
    const checkPending = () => {
      if (consumed) return;
      // Skip the check entirely if we just exited voice mode within the last few seconds.
      if (isWakeJustExited()) return;
      AsyncStorage.getItem('cyberclaw-wake-pending').then(pending => {
        if (consumed) return;
        if (pending === '1') {
          consumed = true;
          addLogEntry('🎙️ Pending wake event found — entering Voice Mode', 'info');
          AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
          // v3.2.18: Wake Mode is gone. Voice Mode is the
          // only destination. Small delay so any activity
          // re-configuration settles first.
          setTimeout(() => {
            try { onOpenVoiceMode?.(); } catch (_) {}
          }, 300);
        }
      }).catch(() => {});
    };
    // Check on every effect run
    checkPending();
    // Also check on every app-state change (foreground transition)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') checkPending();
    });
    return () => sub?.remove?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakePendingCheckCounter]);

  // Bump the counter every 2s so the pending-wake check effect runs
  // periodically. This catches state wipes that don't trigger a re-mount
  // or an app-state change.
  useEffect(() => {
    const interval = setInterval(() => {
      setWakePendingCheckCounter(c => c + 1);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // The per-render watcher that re-applied setFullscreen(true) during a wake event was REMOVED.

  // Load persisted chat v3.1.27: also load into `messagesByAgent` (per-agent) so tab switching doesn't lose history.
  useEffect(() => {
    let cancelled = false;
    const seedFromLegacy = async () => {
      try {
        const raw = await AsyncStorage.getItem(CHAT_STORAGE_KEY);
        if (!raw) return;
        const loaded = JSON.parse(raw);
        if (!Array.isArray(loaded)) return;
        const filtered = loaded.filter((m: any) =>
          m && typeof m.text === 'string' && m.ts && typeof m.isUser === 'boolean');
        if (filtered.length === 0) return;
        // V3.1.16 migration: v3.1.15 stored the array in reversed (newest→oldest) order for an inverted FlatList.
        let ordered = filtered;
        if (filtered.length >= 2) {
          const firstTs = filtered[0].ts;
          const lastTs = filtered[filtered.length - 1].ts;
          if (firstTs > lastTs) ordered = filtered.slice().reverse();
        }
        if (cancelled) return;
        // Group by agentId.
        const grouped: Record<string, Record<string, ChatMessage[]>> = {};
        for (const m of ordered) {
          const aid: string = m.agentId || 'clawsuu';
          if (!grouped[aid]) grouped[aid] = { [DEFAULT_QUEST_KEY]: [] };
          grouped[aid][DEFAULT_QUEST_KEY].push({
            id: m.id || stableHistoryMessageId(m.ts, m.text),
            text: m.text,
            isUser: m.isUser,
            agentId: aid,
            agentName: m.agentName,
            ts: m.ts,
            // V3.11.30 FIX (Tobe 2026-10-05 08:32): forward attachments from the legacy chat cache.
            attachments: Array.isArray(m.attachments) && m.attachments.length > 0
              ? m.attachments
              : undefined,
          });
        }
        // Also seed the visible `messages` from the first non-empty slot so the chat isn't blank on startup.
        setMessagesByAgentAndQuest(prev => {
          // Merge: prefer the new grouped data for slots that are currently empty, but don't overwrite slots that already have messages (in case the…
          const next: Record<string, Record<string, ChatMessage[]>> = { ...prev };
          for (const [aid, questBuckets] of Object.entries(grouped)) {
            const existing = next[aid];
            const defaultBucket = questBuckets[DEFAULT_QUEST_KEY] || [];
            const existingDefault = existing?.[DEFAULT_QUEST_KEY] || [];
            if (!existing || existingDefault.length === 0) {
              next[aid] = questBuckets;
            } else {
              // Existing bucket has data — just merge the
              // default bucket in case the legacy cache has
              // older messages we don't have.
              next[aid] = {
                ...existing,
                [DEFAULT_QUEST_KEY]: [...existingDefault, ...defaultBucket],
              };
            }
          }
          return next;
        });
        // Show the first non-empty slot (or the active tab's slot, if any) as the visible chat.
        setMessages(prev => {
          if (prev.length > 0) return prev; // already populated
          const activeQid = mobileActiveQuestAnchor ?? null;
          if (activeQid !== null) {
            // User has an active quest (anchor set).
            setAnchorHydrateTick(t => t + 1);
            return prev;
          }
          // ActiveQid === null.
          if (!_anchorBootstrapResolved) {
            // (a) Bootstrap pending. Same as onChatHistory:
            // return prev, projection effect will re-run
            // after bootstrap completes.
            setAnchorHydrateTick(t => t + 1);
            return prev;
          }
          // (b) Bootstrap resolved with null. Surface
          // legacy DEFAULT bucket content.
          const aid = activeChatAgentIdRef.current;
          if (aid && grouped[aid]?.[DEFAULT_QUEST_KEY]?.length) return grouped[aid][DEFAULT_QUEST_KEY];
          // otherwise the first non-empty slot
          for (const [, questBuckets] of Object.entries(grouped)) {
            const def = questBuckets[DEFAULT_QUEST_KEY];
            if (def?.length) return def;
          }
          return prev;
        });
      } catch (e) {
        console.log('Error loading messages:', e);
      }
    };

    // Also load the per-agent key (the new source of truth).
    const seedFromPerAgent = async () => {
      try {
        // v3.11.0: prefer the new per-quest key.
        const rawNew = await AsyncStorage.getItem('cyberclaw-chat-byagent-byquest');
        if (rawNew) {
          const parsed = JSON.parse(rawNew);
          if (!parsed || typeof parsed !== 'object') return false;
          if (cancelled) return true;
          setMessagesByAgentAndQuest(prev => {
            const next: Record<string, Record<string, ChatMessage[]>> = { ...prev };
            for (const [aid, questBuckets] of Object.entries(parsed)) {
              if (!questBuckets || typeof questBuckets !== 'object') continue;
              const migrated: Record<string, ChatMessage[]> = {};
              for (const [qidKey, msgs] of Object.entries(questBuckets)) {
                if (!Array.isArray(msgs) || msgs.length === 0) continue;
                const qk: string = qidKey === 'null' ? DEFAULT_QUEST_KEY : qidKey;
                const questId: string | null = questKeyFromStorage(qk);
                migrated[qk] = msgs.map((m: any) => ({
                  id: m.id || stableHistoryMessageId(m.ts, m.text),
                  text: m.text,
                  isUser: !!m.isUser,
                  agentId: m.agentId || aid,
                  agentName: m.agentName,
                  ts: m.ts,
                  activeQuestId: m.activeQuestId ?? questId,
                  activeQuestName: m.activeQuestName ?? null,
                  // V3.11.30 FIX (Tobe 2026-10-05 08:32): forward attachments from the persisted local cache.
                  attachments: Array.isArray(m.attachments) && m.attachments.length > 0
                    ? m.attachments
                    : undefined,
                }));
              }
              if (Object.keys(migrated).length > 0) {
                // Replace slot with the persisted one
                // (it's the newer / more recent data).
                next[aid] = { ...(next[aid] || {}), ...migrated };
              }
            }
            return next;
          });
          setMessages(prev => {
            if (prev.length > 0) return prev;
            const aid = activeChatAgentIdRef.current;
            // Prefer the active quest's bucket over the iteration-order first bucket.
            if (aid && parsed[aid]) {
              const activeQid = mobileActiveQuestAnchor ?? null;
              const activeKey = questKeyForStorage(
                activeQid === undefined ? null : activeQid
              );
              if (parsed[aid][activeKey] && parsed[aid][activeKey].length > 0) {
                return parsed[aid][activeKey];
              }
              // Active quest bucket has no data on disk.
              if (activeQid === null) {
                const defaultKey = DEFAULT_QUEST_KEY;
                if (parsed[aid][defaultKey] && parsed[aid][defaultKey].length > 0) {
                  return parsed[aid][defaultKey];
                }
              }
              // No fallback to "any bucket of any agent" — the previous version's last-resort path could leak the legacy DEFAULT bucket into a user's…
            }
            // Trigger a projection-effect re-run so the freshly-populated bucket map drives the visible chat.
            setAnchorHydrateTick(t => t + 1);
            return prev;
          });
          return true;
        }
        // v3.11.0: migrate from the old per-agent-only key.
        const rawOld = await AsyncStorage.getItem('cyberclaw-chat-byagent');
        if (rawOld) {
          const parsed = JSON.parse(rawOld);
          if (!parsed || typeof parsed !== 'object') return false;
          if (cancelled) return true;
          const migrated: Record<string, Record<string, ChatMessage[]>> = {};
          for (const [aid, msgs] of Object.entries(parsed)) {
            if (!Array.isArray(msgs) || msgs.length === 0) continue;
            migrated[aid] = {
              [DEFAULT_QUEST_KEY]: msgs.map((m: any) => ({
                id: m.id || stableHistoryMessageId(m.ts, m.text),
                text: m.text,
                isUser: !!m.isUser,
                agentId: m.agentId || aid,
                agentName: m.agentName,
                ts: m.ts,
                // Old data has no quest attribution; stamp
                // it as `null` (default bucket).
                activeQuestId: null,
                activeQuestName: null,
              })),
            };
          }
          if (Object.keys(migrated).length > 0) {
            setMessagesByAgentAndQuest(prev => {
              const next = { ...prev };
              for (const [aid, questBuckets] of Object.entries(migrated)) {
                const existingDefault = next[aid]?.[DEFAULT_QUEST_KEY] || [];
                if (!next[aid] || existingDefault.length === 0) {
                  next[aid] = questBuckets;
                }
              }
              return next;
            });
            // Persist the migrated data under the new key and remove the old key.
            await AsyncStorage.setItem(
              'cyberclaw-chat-byagent-byquest',
              JSON.stringify(migrated),
            ).catch(() => {});
            await AsyncStorage.removeItem('cyberclaw-chat-byagent').catch(() => {});
          }
          setMessages(prev => {
            if (prev.length > 0) return prev;
            const aid = activeChatAgentIdRef.current;
            // Legacy migration only adds a DEFAULT bucket (the old data has no quest attribution).
            const activeQid = mobileActiveQuestAnchor ?? null;
            if (activeQid !== null) {
              // User has an active quest; the legacy DEFAULT bucket doesn't belong in their active-quest view.
              setAnchorHydrateTick(t => t + 1);
              return prev;
            }
            // activeQid === null — same (a)/(b) distinction
            // as in seedFromLegacy.
            if (!_anchorBootstrapResolved) {
              setAnchorHydrateTick(t => t + 1);
              return prev;
            }
            // (b) Bootstrap resolved with null — surface
            // legacy DEFAULT bucket.
            if (aid && migrated[aid]?.[DEFAULT_QUEST_KEY]?.length) return migrated[aid][DEFAULT_QUEST_KEY];
            for (const [, questBuckets] of Object.entries(migrated)) {
              const def = questBuckets[DEFAULT_QUEST_KEY];
              if (def?.length) return def;
            }
            return prev;
          });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    (async () => {
      // New per-agent key takes priority; fall back to legacy.
      const ok = await seedFromPerAgent();
      if (cancelled) return;
      if (!ok) await seedFromLegacy();
    })();

    AsyncStorage.getItem('cyberclaw-tts-enabled').then(v => {
      if (v !== null) setTtsEnabled(v === 'true');
    });
    return () => { cancelled = true; };
  }, []);

  // Persist chat
  useEffect(() => {
    if (messages.length > 0) {
      // Archive messages older than 2 weeks
      const now = Date.now();
      const recentMessages = messages.filter(m => (now - m.ts) < TWO_WEEKS_MS);
      const archivedMessages = messages.filter(m => (now - m.ts) >= TWO_WEEKS_MS);

      // Save recent (keep last 100)
      AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(recentMessages.slice(-100)));

      // Save archived separately (keep all)
      if (archivedMessages.length > 0) {
        AsyncStorage.getItem(ARCHIVE_STORAGE_KEY).then(raw => {
          const existing = raw ? JSON.parse(raw) : [];
          const combined = [...existing, ...archivedMessages].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
          AsyncStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(combined.slice(-1000)));
        });
      }
    }
  }, [messages]);

  // Persist the per-agent chat cache so tab switching can restore history even if the desktop is offline / has been restarted.
  useEffect(() => {
    const handle = setTimeout(() => {
      // Snapshot via the ref so we always read the latest, even
      // if the effect closure was captured before the change.
      const snapshot = messagesByAgentRef.current || {};
      // Don't write empty caches (avoids wiping storage on a
      // transient empty state).
      const nonEmpty = Object.entries(snapshot).filter(
        ([, questBuckets]) =>
          questBuckets &&
          typeof questBuckets === 'object' &&
          Object.values(questBuckets).some(
            (v) => Array.isArray(v) && v.length > 0,
          ),
      );
      if (nonEmpty.length === 0) return;
      const out: Record<string, Record<string, ChatMessage[]>> = {};
      for (const [aid, questBuckets] of nonEmpty) {
        const trimmedBuckets: Record<string, ChatMessage[]> = {};
        for (const [qidKey, msgs] of Object.entries(questBuckets)) {
          if (!Array.isArray(msgs) || msgs.length === 0) continue;
          // Keep the last 200 per (agent, quest) bucket.
          trimmedBuckets[qidKey] = msgs.slice(-200);
        }
        if (Object.keys(trimmedBuckets).length > 0) out[aid] = trimmedBuckets;
      }
      if (Object.keys(out).length === 0) return;
      AsyncStorage.setItem(
        'cyberclaw-chat-byagent-byquest',
        JSON.stringify(out),
      ).catch(() => {});
      // Remove the old key once we've written the new one.
      AsyncStorage.removeItem('cyberclaw-chat-byagent').catch(() => {});
    }, 1500);
    return () => clearTimeout(handle);
  }, [messagesByAgentAndQuest]);

  // Orientation listener
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setIsLandscape(window.width > window.height);
    });
    // Check initial orientation
    const { width, height } = Dimensions.get('window');
    setIsLandscape(width > height);
    return () => subscription?.remove?.();
  }, []);

  // Keyboard
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardVisible(true);
      // Compute the keyboard's visual height from `endCoordinates.screenY` rather than `endCoordinates.height`.
      const coords = e?.endCoordinates;
      const visualHeight = coords
        ? (typeof coords.screenY === 'number'
            ? Math.max(0, Dimensions.get('screen').height - coords.screenY)
            : coords.height ?? 0)
        : 0;
      setKeyboardHeight(visualHeight);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  const [wakeDebug, setWakeDebug] = useState<string>('init');
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const [pendingAudioPath, setPendingAudioPath] = useState<string | null>(null);

  // Wake Mode
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const isWakeWordModeRef = useRef(false);
  const [wakeWordSession, setWakeWordSession] = useState<{ id: string; audioChunks: string[] } | null>(null);

  // toggleVoiceInput defined after sendMessage below

  // AppState listener - adjust wake word threshold based on foreground/background
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      const prev = appStateRef.current;
      const wasBackground = prev === 'background' || prev === 'inactive';
      const goingBackground = nextAppState === 'background' || nextAppState === 'inactive';
      const goingForeground = nextAppState === 'active';

      // De-spam.
      if (nextAppState === prev) return;
      const now = Date.now();
      if (now - lastAppStateLogRef.current < 1500) {
        // Still update the ref so the next fire doesn't think
        // it's a transition. We just don't re-run the listener
        // setup or log this fire.
        appStateRef.current = nextAppState;
        return;
      }
      lastAppStateLogRef.current = now;

      if (goingForeground && wasBackground) {
        // Re-apply the thinking-bubble state when the user comes back to foreground.
        if (thinkingStickyRef.current && !fullscreenRef.current) {
          const a = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
          const name = a?.name || 'Companion';
          // Pick the right "still working" label based on how long the bubble has been up.
          const elapsed = thinkingStartedAtRef.current ? (Date.now() - thinkingStartedAtRef.current) : 0;
          let label = 'is thinking...';
          if (elapsed >= 240000) label = 'is taking very long (model may retry in the background)...';
          else if (elapsed >= 90000) label = 'is taking longer than usual...';
          else if (elapsed >= 30000) label = 'is still working...';
          setChatVoiceStatus(`${name} ${label}`);
          setIsThinking(true);
          setArenaThinking(true);
          // Re-arm the next escalation if we just transitioned to a new tier (e.g.
        }
        // Came back to foreground - restart listener with foreground (lenient) threshold
        if (!isWakeWordModeRef.current && !fullscreenRef.current) {
          const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
          const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
          const phrase = settings.wakeWord || 'hey clawsuu';
          // v3.1.29: same fallback as the initial setup.
          let trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
          let usedPhrase = phrase;
          if (!trainingJson || !JSON.parse(trainingJson || '{}')?.features?.length) {
            const any = await findAnyWakeSamples();
            if (any) {
              trainingJson = JSON.stringify(any.training);
              usedPhrase = any.phrase;
            }
          }
          const training = trainingJson ? JSON.parse(trainingJson) : null;
          if (training?.features?.length) {
            sampleListenerCleanupRef.current?.();
            // v3.1.49: read the user-configured foreground threshold
            // from settings (was hardcoded 0.55). Fall back to the
            // default if not set.
            const fgThrStr = await AsyncStorage.getItem('cyberclaw-wake-fg-threshold');
            const fgThr = fgThrStr ? parseFloat(fgThrStr) : SAMPLE_MATCH_THRESHOLD_FG;
            // v3.1.67: use per-companion matcher. Pass all
            // companions' training data, get the matched
            // companionId back.
            const allKeysFg = await AsyncStorage.getAllKeys();
            const sampleKeysFg = allKeysFg.filter(k => k.startsWith('cyberclaw-wake-samples-'));
            const companionsTrainingFg = [];
            for (const key of sampleKeysFg) {
              try {
                const raw = await AsyncStorage.getItem(key);
                if (!raw) continue;
                const parsed = JSON.parse(raw);
                if (parsed?.features?.length) {
                  const cid = key.replace('cyberclaw-wake-samples-', '');
                  companionsTrainingFg.push({ companionId: cid, features: parsed.features });
                }
              } catch (_) {}
            }
            sampleListenerCleanupRef.current = startSampleMatchListener(
              companionsTrainingFg, handleWakeWord,
              (msg) => addLogEntry(msg, 'debug'),
              fgThr,
            );
            // Log the threshold change so the user can see why a previously-stable 60% (or whatever) suddenly becomes 55%.
            addLogEntry(
              `🎙️ App foregrounded — wake threshold: ${Math.round(fgThr * 100)}% (was stricter in background)`,
              'info',
            );
          }
          isWakeWordStoppedRef.current = false;
        }
      } else if (goingBackground && !wasBackground) {
        // Going to background - restart listener with background (strict) threshold
        if (!fullscreenRef.current) {
          const [settingsRaw, ppnPath, wakeModeRaw, bgThreshRaw] = await Promise.all([
            AsyncStorage.getItem('cyberclaw-audio-settings'),
            AsyncStorage.getItem('cyberclaw-ppn-path'),
            AsyncStorage.getItem('cyberclaw-wake-mode'),
            AsyncStorage.getItem('cyberclaw-wake-bg-threshold'),
          ]);
          const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
          const wakeMode = wakeModeRaw || 'sample';
          const phrase = settings.wakeWord || 'hey clawsuu';
          const bgThreshold = bgThreshRaw ? parseFloat(bgThreshRaw) : SAMPLE_MATCH_THRESHOLD_BG;
          if (wakeMode === 'sample') {
            // v3.1.67: per-companion matcher. Load all
            // companions' training data.
            const allKeysBg = await AsyncStorage.getAllKeys();
            const sampleKeysBg = allKeysBg.filter(k => k.startsWith('cyberclaw-wake-samples-'));
            const companionsTrainingBg = [];
            for (const key of sampleKeysBg) {
              try {
                const raw = await AsyncStorage.getItem(key);
                if (!raw) continue;
                const parsed = JSON.parse(raw);
                if (parsed?.features?.length) {
                  const cid = key.replace('cyberclaw-wake-samples-', '');
                  companionsTrainingBg.push({ companionId: cid, features: parsed.features });
                }
              } catch (_) {}
            }
            if (companionsTrainingBg.length > 0) {
              sampleListenerCleanupRef.current?.();
              sampleListenerCleanupRef.current = startSampleMatchListener(
                companionsTrainingBg, handleWakeWord,
                (msg) => addLogEntry(msg, 'debug'),
                bgThreshold,
              );
              // v3.1.30: same — log the threshold change
              // so the user understands the reason.
              addLogEntry(
                `🎙️ App backgrounded — wake threshold: ${Math.round(bgThreshold * 100)}% (stricter than foreground)`,
                'info',
              );
            }
            // Removed the Vosk fallback here.
          } else if (wakeMode === 'porcupine' && ppnPath) {
            WakeWordModule?.startPorcupine?.(ppnPath).catch(() => {});
          }
          isWakeWordStoppedRef.current = false;
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [handleWakeWord]);

  // Sync & background service
  useEffect(() => {
    startBgService();

    // Start wake word listener
    Promise.all([
      AsyncStorage.getItem('cyberclaw-audio-settings'),
      AsyncStorage.getItem('cyberclaw-ppn-path'),
      AsyncStorage.getItem('cyberclaw-wake-mode'),
    ]).then(async ([settingsRaw, ppnPath, wakeModeRaw]) => {
      const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
      const ppn = ppnPath || '';
      const wakeMode = wakeModeRaw || 'sample';
      const phrase = settings.wakeWord || 'hey claw';
      if (wakeMode === 'sample') {
        // First try the specific phrase the settings ask for; if that has no training data, fall back to any trained phrase (so the user doesn't…
        let trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase))
          .catch(() => null);
        // v3.1.67: per-companion matcher. Load all
        // companions' training data (keyed by companion ID,
        // not phrase) and match against all of them.
        const allKeysInit = await AsyncStorage.getAllKeys();
        const sampleKeysInit = allKeysInit.filter(k => k.startsWith('cyberclaw-wake-samples-'));
        const companionsTraining = [];
        for (const key of sampleKeysInit) {
          try {
            const raw = await AsyncStorage.getItem(key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (parsed?.features?.length) {
              const cid = key.replace('cyberclaw-wake-samples-', '');
              companionsTraining.push({ companionId: cid, features: parsed.features });
            }
          } catch (_) {}
        }
        if (companionsTraining.length > 0) {
          sampleListenerCleanupRef.current?.();
          // v3.1.49: same as the foreground branch — read
          // user-configured FG threshold from settings.
          const fgThrStr = await AsyncStorage.getItem('cyberclaw-wake-fg-threshold');
          const fgThr = fgThrStr ? parseFloat(fgThrStr) : SAMPLE_MATCH_THRESHOLD_FG;
          sampleListenerCleanupRef.current = startSampleMatchListener(
            companionsTraining, handleWakeWord,
            (msg) => addLogEntry(msg, 'debug'),
            fgThr,
          );
          addLogEntry(
            `Starting sample-match wake detection for ${companionsTraining.length} companion(s), threshold: ${Math.round(SAMPLE_MATCH_THRESHOLD_FG * 100)}% (foreground)`,
            'info',
          );
        } else {
          addLogEntry(
            `⚠️ No wake-word samples found. Open Wake Mode and tap "Train wake phrase" to record 3 samples.`,
            'warn',
          );
        }
      } else if (wakeMode === 'porcupine' && ppn) {
        WakeWordModule?.startPorcupine?.(ppn).catch((e: any) => {
          addLogEntry(`Porcupine failed: ${e?.message}`, 'error');
        });
        addLogEntry(`Starting Porcupine wake detection`, 'info');
      } else {
        // v3.1.29: unknown wakeMode. Previously this fell
        // through to Vosk, but Vosk is no longer a fallback.
        // Just log and skip.
        addLogEntry(
          `⚠️ Unknown wake mode "${wakeMode}". Check the Wake Mode settings.`,
          'warn',
        );
      }
    });

    // Check if app is already in background (e.g., freshly opened from wakeword)
    // If so, don't start wake word yet - wait for transition
    if (appStateRef.current !== 'active') {
      // App is backgrounded - wake word will be started by AppState listener
    }

    // Wake event listening moved to App.tsx.
    const wakeSub = null; // (was: wakeWordEmitter?.addListener('wakeWordDetected', handleWakeWord))
    const wakeOpenSub = null; // (was: DeviceEventEmitter.addListener('wakeWordOpenedApp', handleWakeWord))
    // Monitor silence detection for voice mode auto-stop
    // SimpleAudioRecorder will emit 'recorderSilence' when silence is detected
    // We set up a listener in the voice mode flow itself, not here
    const debugSub = wakeWordEmitter?.addListener('wakeWordDebug', (e: any) => {
      const label = e.text ? `${e.state}: "${e.text}"` : e.state;
      setWakeDebug(label);
      // Log all debug events to help track wake word recognition
      if (e.state === 'unavailable') {
        addLogEntry(`Speech Recognition not available on this device`, 'error');
      } else if (e.state === 'downloading') {
        addLogEntry(`Downloading Vosk model (~50MB)...`, 'info');
      } else if (e.state === 'model_ready') {
        addLogEntry(`Vosk model ready`, 'info');
      } else if (e.state === 'ready') {
        addLogEntry(`🎧 Vosk listening: "${e.text}"`, 'info');
      } else if (e.state === 'partial') {
        addLogEntry(`Vosk heard: "${e.text}"`, 'debug');
      } else if (e.state === 'detected') {
        addLogEntry(`✅ Wake word detected: "${e.text}"`, 'info');
      } else if (e.state !== 'error') {
        addLogEntry(`Wake: ${label}`, 'debug');
      }
    });
    const onState = (data: any) => {
      setConnState(data.state);
      addLogEntry(`State → ${data.state}`, 'info');

      // Show connection notifications via Toast (small, subtle)
      if (data.state === 'connected') {
        addLogEntry('Connected - receiving updates from desktop', 'info');
        // Re-request the agents list on every reconnect.
        try {
          syncClient.requestAgentsList();
          addLogEntry('→ Re-requested agents list (reconnect)', 'sent');
        } catch (_) {}
        // Use Toast via native module
        if (NativeModules.NativeBackground) {
          try {
            NativeModules.NativeBackground.showToast('✅ Connected to Desktop');
          } catch (e) {
            console.error('Error showing toast:', e);
          }
        }
      } else if (data.state === 'lost' || data.state === 'offline') {
        addLogEntry('Disconnected from desktop', 'warn');
        if (NativeModules.NativeBackground) {
          try {
            NativeModules.NativeBackground.showToast('❌ Disconnected from Desktop');
          } catch (e) {
            console.error('Error showing toast:', e);
          }
        }
      }
    };

    const onChat = (msg: any) => {
      addLogEntry(`📨 Chat message received from server`, 'received');
      // Allow user messages through to the chat history.
      const aid: string = msg.agentId || activeChatAgentIdRef.current || 'companion';
      // Stamp the message with which quest was active when it landed.
      const aq = chatCasualRef.current ? null : activeQuestRef.current;
      const questFromBroadcast = (typeof msg.activeQuestId === 'string' && msg.activeQuestId)
        ? { id: msg.activeQuestId, name: msg.activeQuestName || null }
        : null;
      // If the broadcast has no activeQuestId (e.g.
      const forceNoQuest = msg.forceNoQuest === true;
      const questForRoute = forceNoQuest
        ? null
        : (questFromBroadcast
          || (mobileActiveQuestAnchor ? { id: mobileActiveQuestAnchor } : aq));
      const questForStamp = questForRoute || aq || null;
      const qidForRoute = questForRoute
        ? questForRoute.id
        : null;
      // V3.11.31 FIX (Tobe 2026-10-05 18:43): use stableHistoryMessageId instead of `${ts}-${random}`.
        const incoming: ChatMessage = {
        id: stableHistoryMessageId(msg.ts || Date.now(), msg.text || ''),
        text: msg.text,
        isUser: !!msg.isUser,
        agentId: aid,
        agentName: msg.agentName,
        ts: msg.ts || Date.now(),
        // Stamp the broadcast-derived quest id on the message bubble so the v3.11.5 pill shows the correct quest name even when the mobile's anchor…
        activeQuestId: questForStamp?.id ?? null,
        activeQuestName: (questForStamp as any)?.name ?? null,
        // Forward `attachments` from the desktop's chat_message broadcast.
        attachments: Array.isArray(msg.attachments) && msg.attachments.length > 0
          ? msg.attachments
          : undefined,
      };
      appendAgentMessage(
        incoming,
        aid,
        qidForRoute,
        setMessagesByAgentAndQuest,
        setMessages,
        activeChatAgentIdRef.current,
        chatCasualRef.current ? null : activeChatQuestId,
      );
      // Classify error bubbles so the chat can render a structured card with category, duration, and partial-step list.
      let errorCategory: 'timeout' | 'crash' | 'network' | 'ratelimit' | 'error' | null = null;
      if (!incoming.isUser && typeof incoming.text === 'string') {
        const t = incoming.text;
        if (/^Error:\s/.test(t) || msg.isError) {
          errorCategory = classifyErrorText(t);
          if (false) {
            errorCategory = 'timeout';
          } else if (/exited with code \d/i.test(t) || /agent CLI/i.test(t)) {
            errorCategory = 'crash';
          } else if (/HTTP request failed|fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(t)) {
            errorCategory = 'network';
          } else {
            errorCategory = 'error';
          }
        }
      }
      // Close the active task session when an agent reply lands.
      if (!incoming.isUser) {
        const finished = closeTaskSession(errorCategory ? 'failed' : 'done', incoming.text);
        // Attach taskSummary only when the bubble is an error.
        const shouldAttach = !!errorCategory;
        if (shouldAttach && finished) {
          const durationMs = (finished.endTs || Date.now()) - finished.startTs;
          const summary = {
            status: 'failed' as const,
            durationMs,
            stepCount: finished.steps.length,
            steps: finished.steps.map(s => s.label),
            errorCategory: errorCategory!,
            errorText: incoming.text,
          };
          // Mutate the bubble we just appended via the messagesByAgent state for this agent.
          setMessagesByAgentAndQuest(prev => {
            const agentBuckets = prev[aid] || {};
            const qid: string | null =
              incoming.activeQuestId === undefined ? null : incoming.activeQuestId;
            const bucketKey = questKeyForStorage(qid);
            const list = agentBuckets[bucketKey] || [];
            const idx = list.findIndex((m: ChatMessage) => m.id === incoming.id);
            if (idx < 0) return prev;
            const updated = [...list];
            updated[idx] = { ...updated[idx], taskSummary: summary };
            return {
              ...prev,
              [aid]: {
                ...agentBuckets,
                [bucketKey]: updated,
              },
            };
          });
          // Also mirror into the flat `messages` array
          // (used for the active-tab view) if it's the
          // active agent.
          if (aid === activeChatAgentIdRef.current) {
            setMessages(prev => {
              const idx = prev.findIndex(m => m.id === incoming.id);
              if (idx < 0) return prev;
              const updated = [...prev];
              updated[idx] = { ...updated[idx], taskSummary: summary };
              return updated;
            });
          }
        }
      }
      // Any new message (user or agent) lands here.
      if (!incoming.isUser) {
        // Gate the indicator clear on whether the reply is for the ACTIVE (agent, quest) bucket.
        const replyBucketKey = questKeyForStorage(
          incoming.activeQuestId === undefined ? null : incoming.activeQuestId
        );
        // V3.11.32 FIX (Tobe 2026-10-05 22:53): use the same source for `activeBucketKey` as the projection effect at line 1723 uses for its `qid`.
        const activeQidFromRef = activeQuestRef.current?.id ?? null;
        const activeBucketKey = questKeyForStorage(
          activeQidFromRef
        );
        const replyIsForActiveBucket =
          aid === activeChatAgentIdRef.current &&
          replyBucketKey === activeBucketKey;
        if (replyIsForActiveBucket && !msg.ambient) {
          // v3.11.50: show the outcome (✓ Done · 42s / ⚠️ error) instead of vanishing.
          finishThinkingRef.current?.(/^Error:\s/.test(String(msg.text || '')) ? 'error' : 'done');
          thinkingStickyRef.current = false;
          thinkingStartedAtRef.current = null;
          if (thinkingEscalateTimerRef.current) {
            clearTimeout(thinkingEscalateTimerRef.current);
            thinkingEscalateTimerRef.current = null;
          }
          setIsThinking(false);
          setArenaThinking(false);
        }
        // v3.11.51: let the FlatList auto-scroll for the first real new content
        // (user message or active reply), then go back to preserving the user's
        // scroll position. Without this, history re-syncs nudge the list by
        // a pixel or two every 30 s. 600 ms covers image bubble layout + measure.
        if (!msg.replay && replyIsForActiveBucket) {
          autoScrollEnabledRef.current = true;
          setAutoScrollTick(t => t + 1);
          setTimeout(() => {
            autoScrollEnabledRef.current = false;
            setAutoScrollTick(t => t + 1);
          }, 600);
        }
        // If replyIsForActiveBucket is false, leave the sticky flag and timer alone — the indicator stays up for the still-in-flight active request.
      }
      if (aid !== activeChatAgentIdRef.current && !msg.replay && !msg.ambient) {
        setChatUnreadByAgent(prev => ({ ...prev, [aid]: (prev[aid] || 0) + 1 }));
      }
      // Fire a system notification when a companion replies and the user isn't actively watching the chat for that companion.
      const isOwnReply = !msg.isUser;
      // v3.11.48: no phone notification for ambient chatter (idle comments,
      // toy/snack reactions) — it lands in casual chat, nothing to read.
      if (isOwnReply && !msg.replay && !msg.ambient) {
        const isChatFocused =
          appStateRef.current === 'active' &&
          !fullscreenRef.current &&
          !isWakeWordModeRef.current &&
          activeTabRef.current === 'chat' &&
          aid === activeChatAgentIdRef.current;
        if (!isChatFocused) {
          const agentName =
            msg.agentName ||
            (agents || []).find(x => x.id === aid)?.name ||
            'Companion';
          // Truncate to 140 chars to match the
          // native-side preview cap.
          const preview = msg.text.length > 140
            ? msg.text.substring(0, 137) + '…'
            : msg.text;
          try {
            NativeModules.NativeBackground?.notifyCompanionReply?.(
              agentName,
              preview,
            );
          } catch (_) {}
        }
      }
      // In Wake Mode, only process messages that are responses to a wake word trigger
      // (wakeWordBusyRef=true). Random companion reactions should just go to normal chat.
      if (isWakeWordModeRef.current && !wakeWordBusyRef.current) {
        addLogEntry(`📨 Wake word mode idle - routing to chat silently`, 'debug');
        return;
      }
      // If in voice mode (or Wake Mode responding to trigger), treat text response as audio response
      if (fullscreenRef.current && !msg.isUser) {
        addLogEntry(`🎙️ Voice mode response: "${msg.text.substring(0, 50)}..."`, 'info');
        addVoiceLog(`🔊 Responding: "${msg.text.substring(0, 40)}..."`);
        setVoiceStatus('playing');
        setChatVoiceStatus(null);

        if (isWakeWordModeRef.current) {
          // Wake word mode: sample listener was stopped in handleWakeWord before recording
          // speak response, then restartWakeListening will restart it

          let ttsDoneSub: any = null;
          let ttsTimeoutId: ReturnType<typeof setTimeout> | null = null;

          const restartWakeListening = async () => {
            if (ttsDoneSub) { ttsDoneSub.remove(); ttsDoneSub = null; }
            if (ttsTimeoutId) { clearTimeout(ttsTimeoutId); ttsTimeoutId = null; }
            if (!isWakeWordModeRef.current) return;
            try { await getSimpleAudioRecorder().stop(); } catch (_) {}
            setIsVoiceListening(false);
            setVoiceStatus('listening');
            addVoiceLog('Wake listening...');
            addLogEntry('🎙️ Ready for next wake word', 'info');
            wakeWordBusyRef.current = false; // allow next wake trigger
            // Restart sample listener now that SimpleAudioRecorder is stopped
            // v3.1.29: same fallback as the initial setup — use
            // the settings phrase if it has samples, otherwise
            // fall back to any trained phrase.
            try {
              const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
              // v3.1.67: per-companion matcher. Load all
              // companions' training data and pass to the
              // matcher.
              const allKeysRt = await AsyncStorage.getAllKeys();
              const sampleKeysRt = allKeysRt.filter(k => k.startsWith('cyberclaw-wake-samples-'));
              const companionsTraining = [];
              for (const key of sampleKeysRt) {
                try {
                  const raw = await AsyncStorage.getItem(key);
                  if (!raw) continue;
                  const parsed = JSON.parse(raw);
                  if (parsed?.features?.length) {
                    const cid = key.replace('cyberclaw-wake-samples-', '');
                    companionsTraining.push({ companionId: cid, features: parsed.features });
                  }
                } catch (_) {}
              }
              if (companionsTraining.length > 0 && !sampleListenerCleanupRef.current) {
                sampleListenerCleanupRef.current = startSampleMatchListener(
                  companionsTraining, handleWakeWord,
                  (m) => addLogEntry(m, 'debug'),
                );
                addLogEntry(`🔄 Sample listener restarted (${companionsTraining.length} companions)`, 'debug');
              }
            } catch (_) {}
          };

          // Desktop sends audio_response (synthesized WAV) - onAudioResponse plays it and will call restartWakeListening via audioPlayerFinished event.
          const wordCount = msg.text.split(/\s+/).length;
          const fallbackMs = Math.max(6000, Math.ceil((wordCount / 130) * 60 * 1000) + 3000);
          ttsTimeoutId = setTimeout(restartWakeListening, fallbackMs);
          // Also listen for audioPlayerFinished (fired by startPlayer in onAudioResponse)
          ttsDoneSub = wakeWordEmitter?.addListener('audioPlayerFinished', restartWakeListening);
        } else {
          // audio_response from desktop handles playback - speak() removed
          setTimeout(() => {
            if (fullscreenRef.current) {
              setVoiceStatus('listening');
              addVoiceLog('🎙️ Listening...');
            }
          }, 2000);
        }
        return;
      }
      addLogEntry(`📨 Adding to chat: "${msg.text.substring(0, 50)}..."`, 'received');
      // v3.11.50: the status line is closed by finishThinking (above) for real
      // replies only — not by the echo of my own message or ambient chatter,
      // which used to wipe it a few seconds after sending.
      // v3.1.17: incoming message already appended to messagesByAgent[aid]
      // and (if active) `messages` at the top of onChat. The legacy
      // duplicate-detection log entry still helps when debugging the
      // sync layer.
      // v3.11.0: log the active quest bucket's length (the
      // user's currently-visible chat), not the total
      // across all buckets. The total is misleading now
      // that one agent can have many quest buckets.
      const aqForLog: string | null =
        activeChatQuestId === undefined ? null : activeChatQuestId;
      const bucketCount = (messagesByAgentRef.current[aid]?.[questKeyForStorage(aqForLog)] || []).length + 1;
      addLogEntry(`📨 Chat updated, total: ${bucketCount}`, 'received');
      // audio_response from desktop handles spoken replies
    };

    const onTyping = (msg: any) => {
      setIsThinking(!!msg.active);
      setArenaThinking(!!msg.active);
      if (msg.active) {
        if (finishTimerRef.current) { clearTimeout(finishTimerRef.current); finishTimerRef.current = null; }
        if (finishedLabelRef.current) { finishedLabelRef.current = null; setChatActions([]); }
      } else {
        // Desktop stopped working. If no reply arrived, say so.
        setTimeout(() => {
          if (thinkingStickyRef.current && !fullscreenRef.current) {
            finishThinkingRef.current?.('stopped');
            thinkingStickyRef.current = false;
            thinkingStartedAtRef.current = null;
          }
        }, 3000);
      }
      // When typing starts (and a session isn't already open), open one.
      if (msg.active && !activeTaskSession) {
        const _a2 = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
        const _aid2 = activeChatAgentIdRef.current || 'companion';
        startTaskSession({
          requestText: '[voice or remote trigger]',
          agentId: _aid2,
          agentName: _a2?.name,
        });
      }
      if (!fullscreenRef.current && msg.active) {
        // v3.1.16: use the agent's name (from the cached agents
        // list) instead of the hard-coded 'Clawsuu' so the status
        // reads correctly when the user is chatting with Lamasuu.
        const a = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
        const name = a?.name || 'Companion';
        setChatVoiceStatus(`${name} is thinking...`);
        // Stamp the moment the indicator went up so the long-wait escalation (below) can flip the text to "still working..." after 30s, 90s, and 4min.
        // v3.11.52: also track work started elsewhere (desktop, or before the app was reopened) so steps, timer and resume keep working.
        const alreadyTracking = thinkingStickyRef.current && thinkingStartedAtRef.current;
        thinkingStickyRef.current = true;
        if (!alreadyTracking) thinkingStartedAtRef.current = (msg.replay && msg.ts) ? msg.ts : Date.now();
        // Cancel any previous long-wait timer; restart fresh.
        if (thinkingEscalateTimerRef.current) {
          clearTimeout(thinkingEscalateTimerRef.current);
          thinkingEscalateTimerRef.current = null;
        }
        // Schedule the escalation chain. Each timer re-reads
        // the agent name so it can fire even after a tab switch.
        const scheduleNext = (delayMs: number, label: string) => {
          thinkingEscalateTimerRef.current = setTimeout(() => {
            // Only escalate if the bubble is STILL up — i.e.
            if (!thinkingStickyRef.current) return;
            if (fullscreenRef.current) return; // don't override voice-mode status
            const a2 = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
            const name2 = a2?.name || 'Companion';
            setChatVoiceStatus(`${name2} ${label}`);
          }, delayMs);
        };
        // 30s: 'still working...' (covers typical tool-use waits)
        scheduleNext(30000, 'is still working...');
        // 90s: 'taking longer than usual'
        scheduleNext(90000, 'is taking longer than usual...');
        // 4 min: 'taking very long — may retry soon'
        scheduleNext(240000, 'is taking very long (model may retry in the background)...');
      }
      // Keep the thinking bubble sticky across app foreground/background cycles.
      if (msg.active) {
        thinkingStickyRef.current = true;
        thinkingStartedAtRef.current = Date.now();
      }
      // Explicit {active:false} is now a no-op on its own.
    };

    // Tool-call events from the desktop's OpenClaw session tailer.
    const onAgentTool = (msg: any) => {
      if (!msg || typeof msg.friendly !== 'string') return;
      // v3.11.48: only while this phone is waiting for a reply from that
      // companion (Discord / other sessions also produce tool calls).
      if (!thinkingStickyRef.current) return;
      if (msg.agentId && msg.agentId !== activeChatAgentIdRef.current) return;
      const friendly = msg.friendly;
      setChatActions(prev => {
        if (prev[prev.length - 1] === friendly) return prev;
        const next = [...prev, friendly];
        // Keep the last 3 (oldest drops first).
        return next.length > 3 ? next.slice(next.length - 3) : next;
      });
      // Also capture this as a task step so the structured error/timeout bubble can show which tools the agent ran before failing.
      appendTaskStep({ label: `tool: ${friendly.substring(0, 40)}` });
    };

    const onChatHistory = (msg: any) => {
      if (Array.isArray(msg.messages) && msg.messages.length > 0) {
        addLogEntry(`← Loaded ${msg.messages.length} messages from desktop`, 'info');
        // Data is stored in chronological order (oldest→newest).
        if (msg.messages.every((m: any) => 'activeQuestId' in m)) {
          // Per-quest attribution is present on all messages.
          const aid = activeChatAgentIdRef.current || 'companion';
          setMessagesByAgentAndQuest(prev => {
            const next: Record<string, Record<string, ChatMessage[]>> = { ...prev };
            for (const m of msg.messages) {
              const mAid: string = m.agentId || aid;
              const rawQid: string | null = (typeof m.activeQuestId === 'string') ? m.activeQuestId : null;
              // If the desktop stamped this message with activeQuestId: null (because the desktop's module-scope activeQuestId was null at addChatMsg time…
              const mForceNoQuest = m.forceNoQuest === true;
              const useAnchorFallback = !mForceNoQuest && rawQid == null && !!mobileActiveQuestAnchor;
              const mQid: string | null = useAnchorFallback
                ? (mobileActiveQuestAnchor as string)
                : rawQid;
              const mQname: string | null = useAnchorFallback && mobileActiveQuestAnchor
                ? (questNameByIdRef.current?.[mobileActiveQuestAnchor] ?? m.activeQuestName ?? null)
                : (m.activeQuestName ?? null);
              const mKey = questKeyForStorage(mQid);
              if (!next[mAid]) next[mAid] = {};
              if (!next[mAid][mKey]) next[mAid][mKey] = [];
              const id = stableHistoryMessageId(m.ts, m.text);
              // V3.11.31 FIX (Tobe 2026-10-05 18:43): Stage 1 fallback dedupe.
              const mIsUser = typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user');
              const incomingTs = (typeof m.ts === 'number' && isFinite(m.ts)) ? m.ts : 0;
              const stage1Dup = next[mAid][mKey].some((existing: any) =>
                existing.text === m.text &&
                !!existing.isUser === mIsUser &&
                Math.abs((existing.ts || 0) - incomingTs) < 60000
              );
              if (stage1Dup) continue;
              // Skip if we've already stored a message with this ID in this bucket.
              if (next[mAid][mKey].some((existing: ChatMessage) => existing.id === id)) {
                continue;
              }
              // Cross-bucket dedupe: if this message ID exists in any other bucket for this agent (e.g.
              let foundInOtherBucket = false;
              for (const [otherKey, otherList] of Object.entries(next[mAid])) {
                if (otherKey === mKey) continue;
                if (otherList.some((existing: ChatMessage) => existing.id === id)) {
                  foundInOtherBucket = true;
                  break;
                }
              }
              if (foundInOtherBucket) continue;
              next[mAid][mKey].push({
                id,
                text: m.text,
                isUser: !!m.isUser,
                agentId: mAid,
                agentName: m.agentName ?? null,
                ts: m.ts,
                activeQuestId: mQid,
                activeQuestName: mQname,
                // V3.11.30 FIX (Tobe 2026-10-05 08:32): forward attachments from chat_history messages.
                attachments: Array.isArray(m.attachments) && m.attachments.length > 0
                  ? m.attachments
                  : undefined,
              });
            }
            return next;
          });
          // Bump hydrate tick so the projection effect picks
          // up the freshly-populated buckets.
          setAnchorHydrateTick(t => t + 1);
          return;
        }
        // Preserve attachments through the history re-deserialization.
        const loaded = msg.messages.map((m: any) => ({
          id: stableHistoryMessageId(m.ts, m.text),
          text: m.text,
          isUser: m.isUser,
          agentId: m.agentId,
          agentName: m.agentName,
          ts: m.ts,
          attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
        }));
        // Route the legacy flat chat_history response to the active companion.
        const aid = activeChatAgentIdRef.current || 'companion';
        const bucketKey = DEFAULT_QUEST_KEY;
        setMessagesByAgentAndQuest(prev => {
          const agentBuckets = prev[aid] || {};
          // Don't overwrite an existing bucket that has
          // data — only seed if the active quest bucket
          // is empty (or doesn't exist).
          const existing = agentBuckets[bucketKey] || [];
          if (existing.length > 0) return prev;
          return {
            ...prev,
            [aid]: { ...agentBuckets, [bucketKey]: loaded },
          };
        });
        // Only push to the visible chat if the active quest is the default bucket.
        if (_anchorBootstrapResolved && mobileActiveQuestAnchor === null) {
          setMessages(loaded);
        }
      }
    };

    const onArena = (msg: any) => {
      setEvents(prev => [`${new Date().toLocaleTimeString()} ${msg.event || JSON.stringify(msg)}`, ...prev.slice(0, 99)]);
    };

    const onAudioResponse = async (msg: any) => {
      addLogEntry(`🔊 AUDIO RESPONSE ARRIVED - bytes=${msg.audioBase64?.length ?? 0} mime=${msg.mimeType}`, 'info');
      // Don't play if we've already exited voice/wake mode
      if (!fullscreenRef.current) {
        addLogEntry('🔊 Skipping playback - no longer in fullscreen', 'debug');
        return;
      }
      try {
        if (!msg.audioBase64) {
          addLogEntry(`🔊 No audioBase64, returning`, 'debug');
          return;
        }
        const fs = require('react-native-fs');
        const ext = (msg.mimeType && msg.mimeType.includes('wav')) ? 'wav' : 'mp3';
        const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-response-${Date.now()}.${ext}`;
        await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
        addLogEntry(`🔊 Written to ${tmpPath}, calling playCachedGreeting`, 'info');

        // If in voice mode, set status to 'playing'
        if (fullscreenRef.current) {
          setVoiceStatus('playing');
        }

        // Use the shared playCachedGreeting helper for consistent audio focus + lifecycle handling across all desktop-synthesized audio (greeting,…
        try {
          const { playAudioFile } = require('../services/AudioPlayer');
          await playAudioFile(tmpPath);
          addLogEntry('🔊 startPlayer resolved OK', 'info');
        } catch (playerErr: any) {
          addLogEntry(`🔊 startPlayer ERROR: ${playerErr?.message}`, 'error');
        }

        // After playback, if still in voice mode, restart listening loop
        // In Wake Mode, restartWakeListening handles this via audioPlayerFinished
        if (fullscreenRef.current && !isWakeWordModeRef.current) {
          addLogEntry(`🔊 Restarting listening loop (fullscreen=true)`, 'debug');
          addLogEntry('Playback finished, restarting listening loop', 'info');
          setVoiceStatus('listening');
          setSilenceCountdown(0);
          setIsVoiceListening(true);

          // Restart SimpleAudioRecorder for voice mode
          try {
            const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.wav`;
            const recorder = getSimpleAudioRecorder();

            // Re-attach silence listener with state tracking
            let hasTransitionedToRecording = false;
            let silenceEventFired = false;
            let countdownInterval: NodeJS.Timeout | null = null;
            let maxDurationTimeout: NodeJS.Timeout | null = null;
            let audioDetectTimer: NodeJS.Timeout | null = null;

            const unsubSilence = recorder.once('silence', async () => {
              silenceEventFired = true;
              addLogEntry('Silence detected in loop', 'info');
              // Silence detected - same flow as before
              setVoiceStatus('silence_countdown');
              let count = 3;
              setSilenceCountdown(count);
              countdownInterval = setInterval(async () => {
                count--;
                setSilenceCountdown(count);
                if (count <= 0) {
                  clearInterval(countdownInterval);
                  if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
                  if (audioDetectTimer) clearTimeout(audioDetectTimer);
                  addLogEntry('Loop countdown complete, sending audio', 'info');
                  // FIXED: Actually stop and send audio
                  try {
                    const resultPath = await recorder.stop();
                    if (!resultPath) {
                      addLogEntry('No recording path returned in loop', 'error');
                      setVoiceStatus('listening');
                      return;
                    }
                    const stats = await fs.stat(resultPath);
                    addLogEntry(`Loop audio file: ${stats.size} bytes`, 'info');
                    const base64 = await fs.readFile(resultPath, 'base64');
                    addLogEntry(`Loop base64 size: ${base64.length} chars`, 'info');
                    if (base64.length < 100) {
                      addLogEntry('Loop base64 audio very small', 'error');
                    }
                    setVoiceStatus('transcribing');
                    addLogEntry('Loop: sending audio', 'sent');
                    syncClient.sendAudioInput(base64, 'audio/wav');
                  } catch (e: any) {
                    addLogEntry(`Loop send error: ${e?.message}`, 'error');
                    setVoiceStatus('listening');
                  }
                }
              }, 1000);
            });

            // FIXED #1: Add audio detection timer for loop
            audioDetectTimer = setTimeout(() => {
              addLogEntry(`Loop: audio timer fired (fullscreen=${fullscreenRef.current}, transitioned=${hasTransitionedToRecording})`, 'debug');
              if (!hasTransitionedToRecording && fullscreenRef.current) {
                hasTransitionedToRecording = true;
                setVoiceStatus('recording');
                addLogEntry('Loop: audio detection - status: recording', 'info');
              }
            }, 500);

            // FIXED #2: Add max duration fallback for loop
            maxDurationTimeout = setTimeout(() => {
              if (!silenceEventFired && isVoiceListening) {
                addLogEntry('Loop: Max duration (30s) reached - forcing send', 'error');
                if (countdownInterval) clearInterval(countdownInterval);
                if (audioDetectTimer) clearTimeout(audioDetectTimer);

                recorder.stop().then(async (resultPath: string) => {
                  setIsVoiceListening(false);
                  if (!resultPath) {
                    setVoiceStatus('listening');
                    return;
                  }
                  try {
                    const base64 = await fs.readFile(resultPath, 'base64');
                    setVoiceStatus('transcribing');
                    syncClient.sendAudioInput(base64, 'audio/wav');
                    addLogEntry('Loop: forced send after max duration', 'sent');
                  } catch (e: any) {
                    setVoiceStatus('listening');
                    addLogEntry(`Loop: send error after timeout: ${e?.message}`, 'error');
                  }
                }).catch((e: any) => {
                  setIsVoiceListening(false);
                  setVoiceStatus('listening');
                  addLogEntry(`Loop: stop error: ${e?.message}`, 'error');
                });
              }
            }, 30000);

            await recorder.start(recPath, 1800);
            addLogEntry('Loop: listening restarted', 'info');
          } catch (e: any) {
            addLogEntry(`Voice: restart error: ${e?.message}`, 'error');
            setVoiceStatus('idle');
          }
        }
      } catch (e: any) {
        addLogEntry(`Audio playback error: ${e?.message}`, 'error');
      }
    };

    const onLogUpdate = (e: LogEntry) => setLogEntries(prev => [...prev, e]);


    syncClient.on('state_change', onState);
    syncClient.on('chat', onChat);
    const onCompanionChange = (msg: any) => {
      if (!msg?.companionId) return;
      setCompanionId(msg.companionId);
      AsyncStorage.setItem('cyberclaw-arena-comp', msg.companionId).catch(() => {});
    };
    syncClient.on('companion_id', onCompanionChange);

    // The v3.1.26 version of onCompanionChange set `companionId` state, which triggered the per-companionId useEffect to reload the WebView.

    syncClient.on('typing', onTyping);
    // v3.10.87: tool-call events (see comment on the
    // onAgentTool handler above for the design rationale).
    syncClient.on('agent_tool', onAgentTool);
    syncClient.on('chat_history', onChatHistory);
    syncClient.on('arena', onArena);
    // Local-LLM pill status from the desktop.
    const onLlmStatus = (msg: any) => {
      // We always update state, then let the pill decide.
      // If agentId is null/missing (mobile-initiated action
      // result), we update unconditionally.
      setLlmStatus(msg);
    };
    syncClient.on('llm_status', onLlmStatus);
    syncClient.on('audio_response', onAudioResponse);
    // Cache the desktop-synthesized audio for both the wake greeting AND the exit reply.
    const onGreetingAudio = (msg: any) => {
      if (msg?.text && msg?.audio) {
        const { saveGreetingAudio } = require('../services/GreetingAudioCache');
        // Forward msg.voice from the desktop so the cache writes to the same (phrase, voice) slot the desktop synthesized against.
        saveGreetingAudio(msg.text, msg.audio, msg.voice).catch(() => {});
      }
    };
    syncClient.on('greeting_audio', onGreetingAudio);
    const onExitReplyAudio = (msg: any) => {
      if (msg?.text && msg?.audio) {
        const { saveExitReplyAudio } = require('../services/ExitReplyAudioCache');
        // v3.10.166: same — forward msg.voice from the
        // desktop so the cache key matches what was
        // synthesized. Falls back internally if missing.
        saveExitReplyAudio(msg.text, msg.audio, msg.voice).catch(() => {});
      }
    };
    syncClient.on('exit_reply_audio', onExitReplyAudio);
    const onVoiceTranscriptResult = (msg: any) => {
      if (!msg.transcript) {
        setChatVoiceStatus(null);
        addLogEntry('No speech detected', 'error');
        return;
      }
      addLogEntry(`Transcribed: "${msg.transcript}"`, 'received');
      // Display transcript in UI.
      const aid = activeChatAgentIdRef.current || 'companion';
      const localTs = Date.now();
      // Match the typed-message prefix behavior — voice transcripts get the same `[From: <deviceName>] ` prefix so the desktop's echo dedupes…
      const deviceName = syncClient.getDeviceName?.() || 'Android Phone';
      // Stamp with which quest was active at voice-send time.
      const aq = chatCasualRef.current ? null : activeQuestRef.current;
      // V3.11.31 FIX (Tobe 2026-10-05 18:43): use stableHistoryMessageId so the voice-mode local bubble has the same id as the chat_history replay…
      const localUserMsg: ChatMessage = {
        id: stableHistoryMessageId(localTs, `[From: ${deviceName}] ${msg.transcript}`),
        text: `[From: ${deviceName}] ${msg.transcript}`,
        isUser: true,
        agentId: aid,
        ts: localTs,
        activeQuestId: aq === undefined ? undefined : (aq?.id ?? null),
        activeQuestName: aq === undefined ? undefined : (aq?.name ?? null),
      };
      appendAgentMessage(
        localUserMsg,
        aid,
        aq === undefined ? null : (aq?.id ?? null),
        setMessagesByAgentAndQuest,
        setMessages,
        activeChatAgentIdRef.current,
        chatCasualRef.current ? null : activeChatQuestId,
      );
      // Send to AI - desktop transcribed the audio but we must send the text to trigger the AI response
      const a = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
      const name = a?.name || 'Companion';
      setChatVoiceStatus(`${name} is thinking...`);
      syncClient.sendChat(msg.transcript);
    };
    syncClient.on('voice_transcript_result', onVoiceTranscriptResult);

    const onVoiceReceived = () => {
      setChatVoiceStatus('Received at desktop, transcribing...');
    };
    syncClient.on('voice_received', onVoiceReceived);

    // Per-agent chat history response.
    const onAgentHistory = (msg: any) => {
      if (!msg?.agentId) return;
      const aid = msg.agentId;
      // Defend against legacy desktop shape.
      if (msg.buckets && typeof msg.buckets === 'object' && !Array.isArray(msg.buckets)) {
        const bucketsMsg = msg.buckets;
        setMessagesByAgentAndQuest(prev => {
          const next: Record<string, Record<string, ChatMessage[]>> = { ...prev };
          const existingBuckets = next[aid] || {};
          // v3.11.46: desktop is the source of truth. Its buckets REPLACE
          // the local ones; only very recent local messages the desktop
          // hasn't echoed yet (in flight) are kept on top.
          const IN_FLIGHT_MS = 120000;
          const nowTs = Date.now();
          const keepInFlight = (local: ChatMessage[] | undefined, loaded: ChatMessage[]) => {
            const ids = new Set(loaded.map(m => m.id));
            const texts = new Set(loaded.map(m => String(m.text || '').trim()));
            const extra = (local || []).filter(m => m && m.ts > nowTs - IN_FLIGHT_MS && !ids.has(m.id) && !texts.has(String(m.text || '').trim()));
            return extra.length ? loaded.concat(extra).sort((a, b) => (a.ts || 0) - (b.ts || 0)) : loaded;
          };
          const mergedForAgent: Record<string, ChatMessage[]> = {};
          for (const [k, local] of Object.entries(existingBuckets)) {
            if (!(k in bucketsMsg)) {
              const fresh = keepInFlight(local, []);
              if (fresh.length) mergedForAgent[k] = fresh;
            }
          }
          for (const [bucketKey, msgs] of Object.entries(bucketsMsg)) {
            if (!Array.isArray(msgs)) continue;
            // Map each message with a stable id + preserve
            // quest attribution.
            const loadedBucket: ChatMessage[] = msgs.map((m: any) => ({
              id: stableHistoryMessageId(m.ts, m.text),
              text: m.text,
              isUser: typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user'),
              agentId: m.agentId || m.name || aid,
              agentName: m.agentName || m.name || null,
              ts: m.ts,
              activeQuestId: m.activeQuestId ?? (bucketKey === DEFAULT_QUEST_KEY ? null : bucketKey),
              activeQuestName: m.activeQuestName ?? null,
              // v3.11.49: desktop errors (timeouts, rate limits) come back as error cards.
              ...((m.isError || (!m.isUser && /^Error:\s/.test(String(m.text || '')))) ? { taskSummary: { status: 'failed' as const, durationMs: 0, stepCount: 0, steps: [], errorCategory: classifyErrorText(String(m.text || '')), errorText: String(m.text || '') } } : {}),
              // Forward attachments on history sync.
              attachments: Array.isArray(m.attachments) && m.attachments.length > 0
                ? m.attachments
                : undefined,
            }));
            mergedForAgent[bucketKey] = keepInFlight(existingBuckets[bucketKey], loadedBucket);
          }
          next[aid] = mergedForAgent;
          return next;
        });
        // Bump the anchor re-trigger counter so the projection effect re-runs with the freshly-populated bucket map.
        setAnchorHydrateTick(t => t + 1);
        return;
      }
      // Legacy fallback path: flat `messages` array (v3.3.18
      // and earlier, or v3.3.19 when no per-quest data
      // exists). Routes everything to DEFAULT bucket.
      const loaded: ChatMessage[] = (Array.isArray(msg.messages) ? msg.messages : []).map((m: any) => ({
        id: stableHistoryMessageId(m.ts, m.text),
        text: m.text,
        isUser: typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user'),
        agentId: m.agentId || m.name || aid,
        agentName: m.agentName || m.name || null,
        ts: m.ts,
        // Forward attachments on history sync.
        attachments: Array.isArray(m.attachments) && m.attachments.length > 0
          ? m.attachments
          : undefined,
      }));
      addLogEntry(`← Loaded ${loaded.length} messages for ${aid}`, 'info');
      const agentBuckets = (messagesByAgentRef.current || {})[aid] || {};
      // Agent_history responses are pre-per-quest (the desktop's chatHistoryByAgent has no quest attribution), so they land in the default bucket.
      const localSlot = agentBuckets[DEFAULT_QUEST_KEY] || [];
      // Decide what to put in the slot.
      if (loaded.length > 0) {
        setMessagesByAgentAndQuest(prev => {
          const existingBuckets = prev[aid] || {};
          // Preserve any other quest buckets we already
          // have; only the default bucket is replaced.
          return {
            ...prev,
            [aid]: {
              ...existingBuckets,
              [DEFAULT_QUEST_KEY]: loaded,
            },
          };
        });
        // If this is the active companion AND the active quest is `null` (default bucket), swap the visible messages to the freshly loaded history.
        if (
          activeChatAgentIdRef.current === aid &&
          activeChatQuestId !== undefined &&
          activeChatQuestId === null
        ) {
          setMessages(loaded);
        }
      } else if (localSlot.length === 0) {
        // Empty desktop response + empty local slot =
        // genuinely empty chat. Adopt the empty state.
        setMessagesByAgentAndQuest(prev => {
          const existingBuckets = prev[aid] || {};
          if ((existingBuckets[DEFAULT_QUEST_KEY] || []).length > 0) return prev;
          return {
            ...prev,
            [aid]: { ...existingBuckets, [DEFAULT_QUEST_KEY]: [] },
          };
        });
        if (
          activeChatAgentIdRef.current === aid &&
          activeChatQuestId !== undefined &&
          activeChatQuestId === null
        ) {
          setMessages([]);
        }
      } else {
        // Desktop says empty but we have local history (e.g.
        addLogEntry(`← Desktop history empty for ${aid}, clearing local copy (${localSlot.length} msg)`, 'info');
        setMessagesByAgentAndQuest(prev => ({ ...prev, [aid]: { ...(prev[aid] || {}), [DEFAULT_QUEST_KEY]: [] } }));
        if (activeChatAgentIdRef.current === aid && activeChatQuestId === null) setMessages([]);
      }
      // History is loaded — clear unread for this agent.
      setChatUnreadByAgent(prev => ({ ...prev, [aid]: 0 }));
    };
    syncClient.on('agent_history', onAgentHistory);

    // v3.1.15: receive the full agent list from the desktop. The mobile
    // arena uses this to render one sprite per agent (instead of only
    // the active companion).
    const onAgentsList = (msg: any) => {
      if (Array.isArray(msg?.agents)) {
        addLogEntry(`← Agents list: ${msg.agents.length} companion(s)`, 'info');
        // The mobile trusts the desktop's list as the source of truth.
        setAgents(msg.agents);
        // v3.1.59: propagate to App.tsx so WakeModeScreen has
        // the current list when it mounts.
        onAgentsChangeRef.current?.(msg.agents);
        // Initialise per-companion chat slots and request each companion's history from the desktop.
        setMessagesByAgentAndQuest(prev => {
          const next: Record<string, Record<string, ChatMessage[]>> = { ...prev };
          for (const a of msg.agents) {
            if (!next[a.id]) next[a.id] = {};
          }
          return next;
        });
        // Pick the first agent as the active chat companion if we
        // don't already have one (initial load, or desktop restarted
        // and the agent list is fresh).
        setActiveChatAgentId(curr => {
          if (curr) return curr;
          const first = msg.agents[0];
          return first ? first.id : null;
        });
        // The mobile arena.html is now a multi-companion renderer.
        if (Array.isArray(msg.agents) && msg.agents.length > 0 && webViewRef.current) {
          // Strip to the fields the WebView needs (id, name, sprite, scale)
          const slim = msg.agents.map((a: any) => ({
            id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null,
          }));
          try {
            webViewRef.current.injectJavaScript(
              `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
            );
            addLogEntry(`→ Injected setAgents to WebView (${slim.length} agents)`, 'sent');
          } catch (e: any) {
            addLogEntry(`✗ Failed to inject setAgents: ${e?.message || e}`, 'error');
          }
          // Persist the first agent's sprite for next app start (only the sprite is used by the legacy persistence path; the WebView now derives the…
          if (slim[0]?.sprite) {
            AsyncStorage.setItem('cyberclaw-arena-comp', slim[0].sprite).catch(() => {});
          }
          // Mark initial injection as done
          initialArenaInjectedRef.current = true;
        } else if (Array.isArray(msg.agents) && msg.agents.length > 0) {
          // WebView ref not ready — log so we know the inject was skipped.
          addLogEntry('⏳ Skipped arena inject: webViewRef not ready (will retry on next agents_list)', 'debug');
        }
        // Request history for every companion so switching tabs is
        // instant. The desktop will respond with `agent_history` per
        // agent; we fill each slot as responses arrive.
        for (const a of msg.agents) {
          try { syncClient.requestAgentHistory(a.id); } catch (_) {}
        }
      }
    };
    syncClient.on('agents_list', onAgentsList);

    // Track the active quest so each new chat message can be stamped with which quest (if any) was active when it was sent.
    const onQuestsList = (msg: any) => {
      try {
        const quests = Array.isArray(msg?.quests) ? msg.quests : [];
        // Always populate the quest name lookup map from every broadcast (including cache replays).
        if (quests.length > 0) {
          setQuestNameById(prev => {
            let changed = false;
            const next = { ...prev };
            for (const q of quests) {
              if (q && q.id && q.name && next[q.id] !== q.name) {
                next[q.id] = q.name;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
        const active = quests.find((q: any) => q && q.active);
        const next = active && active.id
          ? { id: active.id, name: active.name || '(unnamed quest)' }
          : null;
        const nextQid: string | null | undefined = next ? next.id : null;
        // Tobe clarified that the chat didn't flash — it STAYED on the wrong quest until he navigated Quests and back.
        const isFreshBroadcast = msg?.source !== 'cache_replay';
        if (!isFreshBroadcast) {
          // Cache replay.
          return;
        }
        if (mobileActiveQuestAnchor === null) {
          // Case 1: no anchor yet.
          setMobileActiveQuestAnchor(nextQid);
          activeQuestRef.current = next; setActiveQuestInfo((next as any) ?? null);
          setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
          return;
        }
        if (mobileActiveQuestAnchor === nextQid) {
          // Case 2: broadcast confirms our anchor.
          // No state swap; keep the ref in sync.
          activeQuestRef.current = next; setActiveQuestInfo((next as any) ?? null);
          setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
          return;
        }
        // Case 3 — desktop is the source of truth for the active quest.
        setMobileActiveQuestAnchor(nextQid);
        activeQuestRef.current = next; setActiveQuestInfo((next as any) ?? null);
        setActiveChatQuestId(prev => (prev === nextQid ? prev : nextQid));
      } catch {}
    };
    syncClient.on('quests_list', onQuestsList);

    // NOTE: Wake word detection now happens locally on mobile in Wake Mode

    // NOTE: Wake word listener already set up at line 603 (wakeSub)
    // No need for duplicate listener here

    const onSendError = (e: any) => {
      if (e?.type === 'audio_input') {
        setChatVoiceStatus(null);
        addLogEntry('Not connected - reconnect and try again', 'error');
      }
      // Any send_error during an active task session closes it as failed.
      const finished = activeTaskSession ? closeTaskSession('failed', e?.message || 'send error') : null;
      if (finished && finished.steps.length > 0) {
        const aid = activeChatAgentIdRef.current || 'companion';
        // Stamp the error bubble with the active quest so it lands in the right bucket.
        const aq = chatCasualRef.current ? null : activeQuestRef.current;
        const durationMs = (finished.endTs || Date.now()) - finished.startTs;
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}-${Math.random()}`,
          text: `Error: ${e?.message || 'send error'}`,
          isUser: false,
          agentId: aid,
          ts: Date.now(),
          taskSummary: {
            status: 'failed',
            durationMs,
            stepCount: finished.steps.length,
            steps: finished.steps.map(s => s.label),
            errorCategory: e?.message?.toLowerCase().includes('connect') ? 'network' : 'error',
            errorText: e?.message || 'send error',
          },
        };
        appendAgentMessage(
          errorMsg,
          aid,
          aq === undefined ? null : (aq?.id ?? null),
          setMessagesByAgentAndQuest,
          setMessages,
          activeChatAgentIdRef.current,
          chatCasualRef.current ? null : activeChatQuestId,
        );
      }
    };
    syncClient.on('send_error', onSendError);
    onLogEntry(onLogUpdate);

    syncClient.loadSaved().then(({ host }) => {
      if (host) {
        addLogEntry(`Connecting to ${host}...`);
        syncClient.connect().catch(e => addLogEntry(`Connect failed: ${e?.message}`, 'error'));
      }
    });

    // Agent Reach - remote tool handler
    const remoteToolHandler = new RemoteToolHandler(syncClient);
    remoteToolHandler.init();

    return () => {
      remoteToolHandler.destroy();
      // Cancel any pending long-wait escalation timer before tearing down listeners — otherwise an unmount mid-wait leaves a dangling setTimeout…
      try { if (thinkingEscalateTimerRef.current) clearTimeout(thinkingEscalateTimerRef.current); } catch {}
      thinkingEscalateTimerRef.current = null;
      try { wakeSub?.remove?.(); } catch {}
      try { wakeOpenSub?.remove?.(); } catch {}
      try { debugSub?.remove?.(); } catch {}
      try { syncClient?.off?.('companion_id', onCompanionChange); } catch {}
      try { syncClient?.off?.('state_change', onState); } catch {}
      try { syncClient?.off?.('chat', onChat); } catch {}
      try { syncClient?.off?.('typing', onTyping); } catch {}
      try { syncClient?.off?.('agent_tool', onAgentTool); } catch {}
      try { syncClient?.off?.('chat_history', onChatHistory); } catch {}
      try { syncClient?.off?.('arena', onArena); } catch {}
      // v3.10.183: local-LLM pill listener.
      try { syncClient?.off?.('llm_status', onLlmStatus); } catch {}
      try { syncClient?.off?.('audio_response', onAudioResponse); } catch {}
      // v3.2.29: also tear down the cache listeners.
      try { syncClient?.off?.('greeting_audio', onGreetingAudio); } catch {}
      try { syncClient?.off?.('exit_reply_audio', onExitReplyAudio); } catch {}
      try { syncClient?.off?.('voice_transcript_result', onVoiceTranscriptResult); } catch {}
      try { syncClient?.off?.('voice_received', onVoiceReceived); } catch {}
      try { syncClient?.off?.('agents_list', onAgentsList); } catch {}
      // v3.10.85: quests_list listener (see comment above).
      try { syncClient?.off?.('quests_list', onQuestsList); } catch {}
      try { syncClient?.off?.('agent_history', onAgentHistory); } catch {}

      try { syncClient?.off?.('send_error', onSendError); } catch {}
      try { offLogEntry?.(onLogUpdate); } catch {}
      try { disposeSimpleAudioRecorder?.(); } catch {}
    };
  }, [speak, setArenaThinking]);





  const appStateRef = useRef<string>(AppState.currentState);
  // Rate-limit the AppState 'foregrounded/backgrounded' log so it doesn't spam.
  const lastAppStateLogRef = useRef<number>(0);

  // Add attachment
  const addAttachment = async (asset: any) => {
    const uri = asset.uri || '';
    const fileName = asset.fileName || 'attachment';
    const fileType = asset.type || 'image/jpeg';
    // Read the file to base64 immediately at picker time.
    let dataBase64: string | undefined;
    let fileSize: number | undefined;
    let stableUri: string = uri;
    if (uri) {
      try {
        const fs = require('react-native-fs');
        const readPath = uri.startsWith('file://') ? uri.slice(7) : uri;
        if (uri.startsWith('content://')) {
          addLogEntry(`📎 content:// URI — copying to documents dir`, 'info');
        }
        dataBase64 = await fs.readFile(readPath, 'base64');
        fileSize = dataBase64 ? Math.floor((dataBase64.length * 3) / 4) : 0;
        addLogEntry(`📎 Read: ${fileName} (${fileSize} bytes from ${uri.slice(0, 60)}…)`, 'info');
        // Copy to permanent storage so the uri survives the picker activity closing.
        const uuid = (Date.now().toString(36) + '-' +
          Math.floor(Math.random() * 1e9).toString(36));
        const ext = (() => {
          if (fileType.startsWith('image/')) return fileType.slice('image/'.length).replace('jpeg', 'jpg');
          if (fileType.startsWith('video/')) return fileType.slice('video/'.length);
          if (fileType.startsWith('audio/')) return fileType.slice('audio/'.length);
          return 'bin';
        })();
        const attachmentsDir = `${RNFS.DocumentDirectoryPath}/chat-attachments`;
        const targetPath = `${attachmentsDir}/${uuid}.${ext}`;
        const dirExists = await fs.exists(attachmentsDir);
        if (!dirExists) {
          await fs.mkdir(attachmentsDir).catch(() => { /* mkdir may fail if it already exists between exists and mkdir — swallow */ });
        }
        // `copyFile` source can be a `file://` or bare path; for `content://` we read into base64 above and write the base64 directly (copyFile…
        if (uri.startsWith('content://')) {
          await fs.writeFile(targetPath, dataBase64, 'base64');
        } else {
          await fs.copyFile(readPath, targetPath);
        }
        stableUri = `file://${targetPath}`;
        addLogEntry(`📎 Copied to: ${targetPath}`, 'info');
      } catch (e: any) {
        addLogEntry(`📎 Read/copy failed at picker time: ${fileName}: ${e?.message ?? 'unknown'}`, 'error');
        // Don't add to the list if we can't read it — attaching a broken attachment is worse UX than telling the user "this image couldn't be opened".
        return;
      }
    }
    if (!dataBase64) {
      addLogEntry(`📎 Skipped: ${fileName} (no data)`, 'warn');
      return;
    }
    const attachment: AttachmentItem = {
      id: Date.now().toString(),
      uri: stableUri,
      name: fileName,
      type: fileType,
      data: dataBase64,
      size: fileSize,
    };
    setAttachments(prev => [...prev, attachment]);
    addLogEntry(`📎 Added: ${fileName}`, 'info');
  };

  // Remove attachment
  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  // Load more history.
  const handleLoadMore = useCallback(() => {
    setVisibleCount(prev => prev + VISIBLE_BATCH);
    pendingScrollKeyRef.current = null;
    // Force the projection effect to update its lastProjectedMessagesLenRef on the next run, so a subsequent bucket growth (e.g., a new realtime…
    lastProjectedMessagesLenRef.current = -1;
  }, []);

  // Removed the auto-paste-on-focus handler and the explicit 📋 clipboard paste button.

  // Toggle Wake Mode - v3.1.12: delegate to App-level navigation so the wake mode UI always renders in the dedicated WakeModeScreen (not as…
  const toggleWakeWordMode = useCallback(async () => {
    addLogEntry('🗣️ Wake Mode toggle (legacy) → Voice Mode', 'info');
    if (onOpenVoiceMode) {
      onOpenVoiceMode();
    }
  }, [onOpenVoiceMode]);

  // Extracted from the companion tab's onPress handler so the cross-agent banner can also call it.
  const switchToAgent = useCallback((aid: string) => {
    setActiveChatAgentId(aid);
    // Per-quest buckets.
    setChatUnreadByAgent(prev => ({ ...prev, [aid]: 0 }));
    try { syncClient.requestAgentHistory(aid); } catch (_) {}
    try {
      webViewRef.current?.injectJavaScript(
        `window.Arena && window.Arena.setActive(${JSON.stringify(aid)}); true;`,
      );
    } catch (_) {}
    AsyncStorage.setItem('cyberclaw-arena-comp', aid).catch(() => {});
  }, [messagesByAgentAndQuest]);

  const handleAttach = useCallback(() => {
    Alert.alert('Attach', 'Choose source', [
      { text: 'Camera', onPress: () => launchCamera({ mediaType: 'mixed', quality: 0.8 }, (res) => {
        // AddAttachment is async (reads base64 at picker time).
        if (res.assets?.[0]) addAttachment(res.assets[0]).catch((e: any) => {
          addLogEntry(`📎 Camera attach failed: ${e?.message ?? 'unknown'}`, 'error');
        });
      })},
      { text: 'Gallery', onPress: () => launchImageLibrary({ mediaType: 'mixed', selectionLimit: 0 }, (res) => {
        if (res.assets && res.assets.length > 0) {
          res.assets.forEach(asset => {
            addAttachment(asset).catch((e: any) => {
              addLogEntry(`📎 Gallery attach failed: ${asset?.fileName ?? '?'}: ${e?.message ?? 'unknown'}`, 'error');
            });
          });
        }
      })},
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const sendMessage = useCallback(async () => {
    if (!isConnected) return;
    // REMOVED the v3.10.179 pre-send snap that tried to scroll the chat to the most recent failed taskSummary card.
    addLogEntry('🟢 send: pressed', 'info');
    // See the sendMessageRef declaration above.
    sendMessageRef.current = sendMessage;
    // Open a task session for this turn.
    const _sendAid = activeChatAgentIdRef.current || 'companion';
    const _sendAgent = (agentsRef.current || []).find(x => x.id === _sendAid);
    startTaskSession({
      requestText: inputText.trim() || (pendingAudioPath ? '[voice message]' : '[no text]'),
      agentId: _sendAid,
      agentName: _sendAgent?.name,
    });
    // Kick the active companion awake on any chat submit.
    try {
      const aid = activeChatAgentIdRef.current || 'companion';
      syncClient.sendWakeAgent(aid);
    } catch (_) {}
    // If there's a pending voice recording, send that
    if (pendingAudioPath) {
      try {
        const fs = require('react-native-fs');
        const base64 = await fs.readFile(pendingAudioPath, 'base64');
        setChatVoiceStatus('Sending to desktop...');
        syncClient.sendAudioInput(base64, 'audio/wav');
        addLogEntry('Voice message sent', 'sent');
        setPendingAudioPath(null);
        // Status will update via mobile-voice-incoming / transcript events
      } catch (e: any) {
        setChatVoiceStatus(null);
        addLogEntry(`Send error: ${e?.message}`, 'error');
      }
      return;
    }
    const text = inputText.trim();
    if (!text && attachments.length === 0) {
      // Silent empty-tap-send is confusing.
      addLogEntry('⬜ send: empty input, ignored', 'warn');
      return;
    }

    if (text || attachments.length > 0) {
      // Tag the user message with the active companion's agentId so it lands in the right slot of messagesByAgent and the desktop routes the…
      const aid = activeChatAgentIdRef.current || 'companion';
      const deviceName = syncClient.getDeviceName?.() || 'Android Phone';
      // v3.10.85: stamp with which quest was active at
      // typed-send time. Same snapshot-at-append pattern
      // as the desktop-echo and voice paths.
      const aq = chatCasualRef.current ? null : activeQuestRef.current;
      // V3.11.31 FIX (Tobe 2026-10-05 18:43): use stableHistoryMessageId so the local user bubble has the SAME id as the chat_history replay entry.
      const userMsg: ChatMessage = {
        id: stableHistoryMessageId(Date.now(), text ? `[From: ${deviceName}] ${text}` : text),
        text: text ? `[From: ${deviceName}] ${text}` : text,
        isUser: true,
        agentId: aid,
        ts: Date.now(),
        attachments: attachments.map(a => ({ uri: a.uri, type: a.type, name: a.name, data: a.data, size: a.size })),
        activeQuestId: aq === undefined ? undefined : (aq?.id ?? null),
        activeQuestName: aq === undefined ? undefined : (aq?.name ?? null),
      };
      appendAgentMessage(
        userMsg,
        aid,
        aq === undefined ? null : (aq?.id ?? null),
        setMessagesByAgentAndQuest,
        setMessages,
        activeChatAgentIdRef.current,
        chatCasualRef.current ? null : activeChatQuestId,
      );
      if (text) {
        syncClient.sendChat(text, aid);
        addLogEntry(`→ [${aid}] ${text.substring(0, 80)}`, 'sent');
      }
    }

    for (const att of attachments) {
      // Send the pre-read base64 from addAttachment().
      let b64 = att.data;
      if (!b64 && att.uri) {
        // Fallback: the pre-read at picker time failed but
        // we still have a URI. Try once more at send time
        // before giving up.
        try {
          const fs = require('react-native-fs');
          const readPath = att.uri.startsWith('file://') ? att.uri.slice(7) : att.uri;
          const readB64 = fs.readFileSync(readPath, 'base64');
          b64 = readB64;
          addLogEntry(`📎 Re-read at send: ${att.name} (${Math.floor((readB64.length * 3) / 4)} bytes)`, 'info');
        } catch (e: any) {
          addLogEntry(`📎 Send-time read failed: ${att.name}: ${e?.message ?? 'unknown'}`, 'error');
          continue;
        }
      }
      if (!b64) {
        addLogEntry(`📎 No data for ${att.name}, skipping`, 'warn');
        continue;
      }
      const ok = syncClient.sendAttachment(b64, att.type, att.name);
      addLogEntry(ok ? `📎 Sent: ${att.name} (${Math.floor((b64.length * 3) / 4)} bytes)` : `📎 Send failed: ${att.name}`, ok ? 'info' : 'error');
    }

    setInputText('');
    setAttachments([]);
    // V3.11.30 FIX (Tobe 2026-10-05 08:32): add `attachments` to the deps.
  }, [inputText, isConnected, pendingAudioPath, attachments]);

  const toggleVoiceInput = useCallback(async () => {
    if (!isConnected) {
      Alert.alert('Not Connected', 'Please connect to your desktop first.');
      return;
    }
    if (isVoiceListening) {
      // Stop recording → save path as pending, show preview in input area
      try {
        const recorder = getSimpleAudioRecorder();
        const result = await recorder.stop();
        setIsVoiceListening(false);
        setPendingAudioPath(result || null);
        setVoiceStatus('idle');
        // Resume wake word in background
        const [ppnRaw, modeRaw, settingsRaw] = await Promise.all([
          AsyncStorage.getItem('cyberclaw-ppn-path'),
          AsyncStorage.getItem('cyberclaw-wake-mode'),
          AsyncStorage.getItem('cyberclaw-audio-settings'),
        ]);
        // FIXED: Don't manually resume wake word here
        // AppState listener will handle it when app goes to background
        addLogEntry('Chat mic stopped; wake word managed by AppState', 'info');
      } catch (e: any) {
        setIsVoiceListening(false);
        addLogEntry(`Stop recording error: ${e?.message}`, 'error');
      }
    } else {
      // Discard any pending audio, PAUSE wake word, start recording with SimpleAudioRecorder
      setPendingAudioPath(null);
      try {
        // PAUSE wake word while recording in chat - prevent conflicts
        if (NativeModules.NativeBackground) {
          try {
            NativeModules.NativeBackground.stopListening();
            NativeModules.NativeBackground.showToast('🔕 Wake word listening stopped');
          } catch (e) {}
        }

        const fs = require('react-native-fs');
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-chat-voice-${Date.now()}.wav`;
        const recorder = getSimpleAudioRecorder();

        // Set up silence detection listener for chat mode
        const unsubSilence = recorder.once('silence', async () => {
          try {
            const result = await recorder.stop();
            setIsVoiceListening(false);
            setPendingAudioPath(result || null);
            setVoiceStatus('idle');
            setChatVoiceStatus('Ready to send');
            addLogEntry('Recording stopped by silence detection', 'info');
            // Resume wake word
            const [ppn, mode, settingsRaw] = await Promise.all([
              AsyncStorage.getItem('cyberclaw-ppn-path'),
              AsyncStorage.getItem('cyberclaw-wake-mode'),
              AsyncStorage.getItem('cyberclaw-audio-settings'),
            ]);
            const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey claw') : 'hey claw';
            // FIXED: Don't restart wake word during voice loop
            // Wake word is paused while in voice mode (fullscreen is true)
            // It will resume when app goes to background or voice mode exits
            addLogEntry('Voice recording ready to send', 'info');
          } catch (e: any) {
            addLogEntry(`Error after silence: ${e?.message}`, 'error');
          }
        });

        await recorder.start(recPath, 1800);
        setIsVoiceListening(true);
        setVoiceStatus('recording');
        setChatVoiceStatus('Recording...');
        addLogEntry('Recording started', 'info');
      } catch (e: any) {
        addLogEntry(`Microphone error: ${e?.message}`, 'error');
        Alert.alert('Microphone Error', e?.message || 'Could not start recording');
      }
    }
  }, [isConnected, isVoiceListening]);

  // Auto-scroll to bottom when switching to chat tab or getting new messages v3.1.14: track incoming (non-user) messages so we can surface a…
const lastMessageIdRef = useRef<string | null>(null);
// V3.11.31 FIX (Tobe 2026-10-05 18:43): track the last message's text + ts so the unread counter can handle the chat_history-replay case…
const lastMessageTextRef = useRef<string | null>(null);
const lastMessageTsRef = useRef<number | null>(null);
// v3.11.49: newest message time already seen — re-synced history never counts as new.
const newestSeenTsRef = useRef<number>(0);
useEffect(() => {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.id === lastMessageIdRef.current) return;
  // Stage 1 fallback (matches the realtime appendAgentMessage dedupe): if text + ts match the previous last (within 60s), it's a chat_history…
  const prevText = lastMessageTextRef.current;
  const prevTs = lastMessageTsRef.current;
  if (prevText !== null && prevTs !== null) {
    const textMatches = last.text === prevText;
    const tsWithinWindow = Math.abs((last.ts || 0) - prevTs) < 60000;
    if (textMatches && tsWithinWindow) {
      // It's a replay.
      lastMessageIdRef.current = last.id;
      // Keep prevTs unchanged so a future genuine
      // duplicate (e.g. another reconnect) still
      // matches.
      return;
    }
  }
  {
    const seen = newestSeenTsRef.current;
    newestSeenTsRef.current = Math.max(seen, last.ts || 0);
    if (seen && (last.ts || 0) <= seen + 2000 && lastMessageIdRef.current !== null) {
      lastMessageIdRef.current = last.id; lastMessageTextRef.current = last.text; lastMessageTsRef.current = last.ts || 0;
      return;
    }
  }
  const isInitial = lastMessageIdRef.current === null;
  lastMessageIdRef.current = last.id;
  lastMessageTextRef.current = last.text;
  lastMessageTsRef.current = last.ts || 0;
  if (isInitial) return; // first mount: just record, no auto-scroll/bump
  // Skip user-sent messages: the user just typed them, they know.
  if (last.isUser) {
    // ...but still scroll to the new (their) message at the bottom.
    if (chatAtBottomRef.current) {
      setTimeout(() => chatRef.current?.scrollToOffset({ offset: 0, animated: false }), 50);
    }
    // The user just sent a new message — any failed taskSummary cards from PRIOR turns are now stale.
    setCollapsedTaskCards(prev => {
      let next: Set<string> | null = null;
      // Walk backwards through messages. Find any
      // failed taskSummary bubbles and add their ids to
      // the collapsed set.
      for (let i = messages.length - 2; i >= 0; i--) {
        const m = messages[i];
        if (m.taskSummary && m.taskSummary.status === 'failed') {
          if (!prev.has(m.id)) {
            if (!next) next = new Set(prev);
            next.add(m.id);
          }
        }
        // We could stop at the first user message we hit (cards from older turns), but actually cards from any turn should collapse when a new user…
      }
      return next || prev;
    });
    return;
  }
  // Increment the unread badge whenever a new message arrives — even when the user is already at the bottom.
  if (!last.isUser && last.taskSummary && last.taskSummary.status === 'failed') {
    const failedIndex = messages.length - 1;
    const scrollToFailed = () => {
      try {
        chatRef.current?.scrollToOffset({ offset: 0, animated: true });
      } catch (_) {
        // scrollToIndex throws if the item isn't
        // measured yet — retry once after a short
        // delay, then fall back to scrollToEnd.
        setTimeout(() => {
          try {
            chatRef.current?.scrollToOffset({ offset: 0, animated: true });
          } catch (__) {
            chatRef.current?.scrollToOffset({ offset: 0, animated: true });
          }
        }, 120);
      }
    };
    // schedule via setTimeout so the FlatList has a
    // chance to lay out the newly-appended item.
    setTimeout(scrollToFailed, 50);
    // also clear unread — they will see it now.
    setChatUnreadCount(0);
    return;
  }
  // Removed the duplicate scrollToEnd here.
  setChatUnreadCount(c => c + 1);
}, [messages.length]);

// When the user switches to the chat tab, ONLY clear the unread badge — do NOT scroll to end.
useEffect(() => {
  if (activeTab === 'chat') {
    setChatUnreadCount(0);
  }
}, [activeTab]);

// Periodic activity heartbeat while the chat tab is open + app is foregrounded.
const activityPingRef = useRef<ReturnType<typeof setInterval> | null>(null);
useEffect(() => {
  const tick = () => {
    try {
      if (
        activeTabRef.current === 'chat' &&
        appStateRef.current === 'active' &&
        isConnected
      ) {
        syncClient.sendActivityPing(activeChatAgentIdRef.current || 'companion');
      }
    } catch (_) {}
  };
  if (activityPingRef.current) clearInterval(activityPingRef.current);
  activityPingRef.current = setInterval(tick, 30 * 1000);
  // Fire one immediately on tab change / connect so the
  // desktop sees activity within seconds of the user
  // opening the chat, not after a 30s wait.
  tick();
  return () => {
    if (activityPingRef.current) {
      clearInterval(activityPingRef.current);
      activityPingRef.current = null;
    }
  };
}, [isConnected, activeTab]);

// The explicit first-paint scroll-to-bottom effect was redundant with the v3.11.15 onContentSizeChange handler, which now handles initial…

  const renderMessage = useCallback(({ item, index }: { item: ChatMessage; index: number }) => {
    if (!item || typeof item.text !== 'string' || !item.ts || typeof item.isUser !== 'boolean') {
      return <View />;
    }

    // Derive the quest name for this bubble's header.
    const qidForLabel = item.activeQuestId;
    const questNameFromId = (id: string) =>
      questNameByIdRef.current[id] || null;

    // v3.1.16: data is stored in chronological order (oldest→newest).
    // Show a date separator when the bucket changes from the previous
    // message (which is the one right above in the array).
    let showDateSeparator = false;
    const olderMsg = chatDataRef.current[index + 1]; // v3.11.45: inverted list
    if (!olderMsg) {
      showDateSeparator = true;
    } else {
      const prevBucket = getDateBucket(olderMsg.ts);
      const currBucket = getDateBucket(item.ts);
      showDateSeparator = prevBucket !== currBucket;
    }

    // Quest-change separator.
    let showQuestSeparator = false;
    let questSeparatorLabel: string | null = null;
    if (olderMsg) {
      const prevQ = olderMsg.activeQuestId;
      const currQ = item.activeQuestId;
      const changed = (() => {
        // Both undefined: no data, no separator
        if (prevQ === undefined && currQ === undefined) return false;
        // undefined vs null: treat as same (legacy into default)
        if ((prevQ === undefined && currQ === null) || (prevQ === null && currQ === undefined)) return false;
        // Otherwise compare directly
        return prevQ !== currQ;
      })();
      if (changed) {
        showQuestSeparator = true;
        questSeparatorLabel = currQ == null ? '— Casual chat' : `🎯 ${item.activeQuestName || '(unnamed quest)'}`;
      }
    }

    // Show the actual agent name (e.g.
    const agentLabel = (() => {
      if (item.isUser) return '👤 You';
      if (item.agentId) {
        const a = (agents || []).find(x => x.id === item.agentId);
        // prefer agent.emoji, fall back to the sprite icon sent by
        // the desktop, finally to the generic paw.
        if (a) return `${a.emoji || a.icon || '🐾'} ${a.name}`;
        if (item.agentName) return item.agentName;
        return `🐾 ${item.agentId}`;
      }
      if (item.agentName) return item.agentName;
      return '🐾 Clawsuu';
    })();

    const dateStr = getDateBucketLabel(item.ts);

    return (
      <View>
        {showDateSeparator && <Text style={styles.dateSeparator}>{dateStr}</Text>}
        {showQuestSeparator && questSeparatorLabel && (
          <View style={styles.questSeparator}>
            <Text style={styles.questSeparatorText}>{questSeparatorLabel}</Text>
          </View>
        )}
        <View style={[styles.messageBubble, item.isUser ? styles.userBubble : styles.aiBubble]}>
          <View style={styles.bubbleHeaderRow}>
            <Text style={[styles.agentLabel, item.isUser ? styles.userLabel : styles.aiLabel]}>
              {agentLabel}
            </Text>
            {/* v3.11.5: show the quest name (or 'No quest')
                on every chat bubble so the user can tell
                which quest a message belongs to at a glance.
                Without this, messages from different quests
                in the same bucket can look indistinguishable,
                and the user has to rely on the chat header /
                Quests panel to know which quest they're
                seeing. Tobe 2026-09-24 21:33: 'Let us put in
                the current quest name at the upper right of
                each text bubble so one can see what chat it
                actually is.'

                The label comes from item.activeQuestName
                (stamped at append time by the desktop) or
                falls back to a name lookup via
                activeQuestIdRef if activeQuestName is
                missing. For messages with no quest
                attribution (legacy / DEFAULT bucket), shows
                'No quest' so the user can distinguish
                pre-v3.3.11 legacy chat from per-quest chat.

                The label is rendered as a small chip on the
                right side of the agent-label row. Both
                styles share the row, so layout is unaffected
                for short agent names. */}
            {/* v3.11.18: always render the per-bubble quest pill
                so the user can see which quest each message
                belongs to at a glance. Tobe's 2026-09-28 12:37
                feedback on v3.11.17: 'the text to show which
                quest chat it is, is gone' — every bubble in the
                active quest's chat lost its pill because v3.11.17
                suppressed it when bubble.activeQuestId ===
                activeChatQuestId. The active-quest name in the
                chat header was not a substitute; Tobe wanted the
                pill on every bubble.

                For bubbles with no quest attribution (legacy /
                DEFAULT bucket, or messages stamped before the
                user activated a quest), we DO NOT render the
                pill at all — no Text node, no flexbox slot, no
                visual label. v3.11.17's '— No quest' /
                '— Legacy (no quest)' string was the original
                visual-noise complaint; rendering nothing
                addresses that AND keeps the bubble width stable
                (no shifting layout as a legacy bubble scrolls
                past a stamped bubble).

                For bubbles with a quest stamp we render the
                quest name as an inline tinted pill (🎯 prefix
                preserved from the v3.11.5–v3.11.17 era). The
                pill text falls back to the broadcast's
                activeQuestName; if that is missing we look up
                the name from the questNameById map populated
                by onQuestsList. If we still don't have a name,
                we suppress the pill rather than render
                '(unnamed quest)'.

                v3.11.25: Tobe 2026-10-01 07:18 — 'change back
                to the previous quest text style in the chat
                bubbles'. The v3.11.22 absolute-positioned solid
                orange chip was too prominent (overrode the
                bubble border-color identity, ate vertical
                header space on small bubbles, and looked
                stuck-on). Reverting to the v3.11.5–v3.11.17
                inline pill: tinted background (alpha-overlay
                of the bubble's accent color, not solid), small
                font, flex row with `space-between` so it sits
                to the right of the agent label. Per-side
                variants (orange tint for AI bubbles, sky tint
                for user bubbles) so the pill reads as
                'quest context' without clobbering the bubble
                border-color identity. The 🎯 emoji prefix is
                restored (v3.11.18 had removed it for width;
                the inline pill has room). */}
            {(() => {
              if (item.activeQuestId == null) return null;
              const name = item.activeQuestName
                || questNameFromId(item.activeQuestId);
              if (!name) return null;
              return (
                <Text
                  style={[
                    styles.bubbleQuestLabel,
                    item.isUser ? styles.bubbleQuestLabelUser : styles.bubbleQuestLabelAi,
                  ]}
                  numberOfLines={1}
                >
                  🎯 {name}
                </Text>
              );
            })()}
          </View>
          {/* v3.10.127: selectable={true} lets the user tap-and-
              hold to bring up the system text-selection
              handles and then copy. Without it React Native
              renders Text as a single non-selectable block
              (you can highlight the whole bubble but not
              individual characters). Tobe 2026-08-02 20:34:
              'i meant on mobile actually ... just so i can
              select characters and copy the text is what i
              want.'
              selectTextOnFocus is intentionally NOT set —
              we want the user to be able to tap-and-hold,
              not have every text field auto-select on
              focus. Tap-and-hold is the standard mobile
              gesture for text selection in iOS/Android
              when selectable=true is on the Text. */}
          <Text
            style={[styles.messageText, item.isUser ? styles.userText : styles.aiText]}
            selectable={true}
          >{item.text}</Text>
          {/* v3.10.177.1: error-only diagnostic footer.
              Tobe 2026-08-28 11:51 clarification: this is
              ONLY for errors. Successful replies should
              render normally without any badge or extra
              footer — the user doesn't need a progress
              recap when the task completed fine.

              When the bubble carries a `taskSummary` with
              status === 'failed', render a structured card
              showing category (timeout / crash / network /
              generic), duration, the captured steps that
              ran before the failure, and Retry / Copy
              buttons for recovery. The original error text
              is preserved above the card so no information
              is lost.

              Successful bubbles never get any summary
              attachment in the first place (see onChat
              handler — taskSummary is only attached when
              the session closes as 'failed'). For user
              bubbles this section never renders.

              v3.10.180: collapsed state. Once the user
              sends a NEW message after the failure, the
              card auto-collapses to a one-line "ⓘ failed
              after X · tap to expand" pill. The Retry /
              Copy buttons are hidden in collapsed state
              because they apply to a stale task — the
              user has moved on. Tap the pill to
              re-expand and access the actions. */}
          {item.taskSummary && !item.isUser && item.taskSummary.status === 'failed' && (
            collapsedTaskCards.has(item.id) ? (
              <TouchableOpacity
                style={styles.taskErrorCardCollapsed}
                onPress={() => {
                  setCollapsedTaskCards(prev => {
                    const next = new Set(prev);
                    next.delete(item.id);
                    return next;
                  });
                }}
              >
                <Text style={styles.taskErrorCollapsedText}>
                  ⓘ Failed attempt · {formatTaskDuration(item.taskSummary.durationMs)} ago · tap to expand
                </Text>
              </TouchableOpacity>
            ) : (
            <View style={styles.taskErrorCard}>
                <Text style={styles.taskErrorHeader}>
                  {item.taskSummary.errorCategory === 'timeout' ? '⏱️ Model timed out' :
                   item.taskSummary.errorCategory === 'crash' ? '💥 Model crashed' :
                   item.taskSummary.errorCategory === 'network' ? '🌐 Network error' :
                   item.taskSummary.errorCategory === 'ratelimit' ? '🚦 Rate limited — the AI provider is busy' :
                   '⚠️ Error'}
                  {'  ·  '}
                  <Text style={styles.taskErrorDuration}>
                    failed after {formatTaskDuration(item.taskSummary.durationMs)}
                  </Text>
                </Text>
                {item.taskSummary.stepCount > 0 && (
                  <View style={styles.taskStepsBlock}>
                    <Text style={styles.taskStepsHeader}>
                      {item.taskSummary.stepCount} step{item.taskSummary.stepCount === 1 ? '' : 's'} completed before failure:
                    </Text>
                    {item.taskSummary.steps.slice(-6).map((s, idx) => (
                      <Text key={idx} style={styles.taskStepLine}>• {s}</Text>
                    ))}
                  </View>
                )}
                {item.taskSummary.stepCount === 0 && (
                  <Text style={styles.taskStepsHeader}>
                    No steps captured — the model likely failed before it started.
                  </Text>
                )}
                <View style={styles.taskActionsRow}>
                  <TouchableOpacity
                    style={styles.taskActionButton}
                    onPress={() => {
                      // Retry re-fires the user's previous message text (captured in the task session).
                      const last = getLastFinishedTaskSession();
                      if (!last || !last.requestText || last.requestText === '[voice or remote trigger]') {
                        addLogEntry('Cannot retry: original message not captured (likely a voice/remote trigger)', 'warn');
                        setChatVoiceStatus('Cannot retry — original message not captured');
                        return;
                      }
                      setInputText(last.requestText);
                      setChatVoiceStatus('Retrying...');
                      addLogEntry(`🔁 Retrying: ${last.requestText.substring(0, 60)}`, 'info');
                      // Use the same sendMessage path
                      // the Send button uses.
                      setTimeout(() => {
                        try { sendMessageRef.current?.(); } catch (_) {}
                      }, 300);
                    }}
                  >
                    <Text style={styles.taskActionText}>↻ Retry</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.taskActionButton}
                    onPress={() => {
                      // Copy a structured summary to the clipboard so the user can paste it into a bug report or share it.
                      const last = getLastFinishedTaskSession();
                      const parts = [
                        `[${item.taskSummary!.errorCategory || 'error'}] ${formatTaskDuration(item.taskSummary!.durationMs)}`,
                        (item.taskSummary!.errorText || item.text || '').replace(/^Error:\s*/, ''),
                        item.taskSummary!.stepCount > 0
                          ? `Steps: ${item.taskSummary!.steps.join(', ')}`
                          : '',
                      ].filter(Boolean);
                      const summary = parts.join('\n');
                      try {
                        const { default: Clipboard } = require('@react-native-clipboard/clipboard');
                        Clipboard.setString(summary);
                        setChatVoiceStatus('Error details copied');
                      } catch (e) {
                        addLogEntry(`Clipboard copy failed: ${(e as any)?.message}`, 'error');
                      }
                    }}
                  >
                    <Text style={styles.taskActionText}>📋 Copy details</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )
          )}
          {/* v3.10.20: render attachment previews. Images
              show inline with a tap-to-open-fullscreen
              handler; non-image attachments (audio, video,
              files) show as a tap-to-open card with the
              filename. The user can preview before sending
              AND after — same component in both states. */}
          {item.attachments && item.attachments.length > 0 && (
            <View style={styles.attachmentsRow}>
              {item.attachments.map((att, idx) => {
                const isImage = att.type?.startsWith('image/');
                return (
                  <TouchableOpacity
                    key={`${item.id}-att-${idx}`}
                    style={isImage ? styles.attachmentImageWrap : styles.attachmentFileWrap}
                    onPress={() => setFullscreenAttachment(att)}
                    activeOpacity={0.8}
                  >
                    {isImage ? (
                      <Image
                        // Prefer a data: URI when we have the base64 inline.
                        source={att.data
                          ? { uri: `data:${att.type};base64,${att.data}` }
                          : { uri: att.uri }}
                        style={styles.attachmentImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={styles.attachmentFileInner}>
                        <Text style={styles.attachmentFileIcon}>📎</Text>
                        <Text style={styles.attachmentFileName} numberOfLines={1}>
                          {att.name}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          <Text style={styles.timestamp}>{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
        </View>
        {item.isUser && item.id === lastUserMsgId && !!item.text && (
          <TouchableOpacity
            style={styles.resendBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => {
              const clean = item.text.replace(/^\[From:[^\]]*\]\s*/, '');
              setInputText(clean);
              addLogEntry('🔁 Resending last message', 'info');
              setTimeout(() => { try { sendMessageRef.current?.(); } catch (_) {} }, 80);
            }}
          >
            <Text style={styles.resendText}>↻ Resend</Text>
          </TouchableOpacity>
        )}
      </View>
    );
    // Also depend on `agents` so the message label re-renders when the agents state is hydrated from cache or refreshed by a fresh `agents_list`…
  }, [messages, agents, questNameById, lastUserMsgId]);

  const renderLog = useCallback(({ item, index }: { item: LogEntry; index: number }) => {
    // Show date separator when bucket changes (Today/Yesterday/This Week/Last Week/Older date)
    let showDateSeparator = false;
    if (index === 0 || !logEntries[index - 1]) {
      showDateSeparator = true;
    } else {
      const prevBucket = getDateBucket(logEntries[index - 1].ts);
      const currBucket = getDateBucket(item.ts);
      showDateSeparator = prevBucket !== currBucket;
    }

    const dateStr = getDateBucketLabel(item.ts);

    return (
      <View>
        {showDateSeparator && <Text style={styles.dateSeparator}>{dateStr}</Text>}
        <Text style={[styles.logLine,
          item.type === 'sent' && styles.logSent,
          item.type === 'received' && styles.logReceived,
          item.type === 'error' && styles.logError,
        ]}>
          [{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] {item.text}
        </Text>
      </View>
    );
  }, [logEntries]);

  const statusLabel = connState === 'connected' ? 'Connected' :
    connState === 'reconnecting' ? 'Connected' :
    connState === 'connecting' ? 'Connecting...' :
    connState === 'lost' ? 'Lost' : 'Offline';

  // Removed the per-companionId WebView reload.

  // When the agents list updates, push it into the WebView so the arena can render one sprite per agent.
  useEffect(() => {
    if (agents.length === 0) return;
    if (!webViewRef.current) return;
    const slim = agents.map((a) => ({
      id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null,
    }));
    try {
      webViewRef.current.injectJavaScript(
        `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
      );
    } catch (_) {}
  }, [agents]);

  // Periodic sync - request state from desktop every 60 seconds
  useEffect(() => {
    if (connState !== 'connected') return;

    const syncInterval = setInterval(() => {
      addLogEntry('Requesting latest state from desktop', 'info');
      syncClient.requestState();
    }, 60000); // Every 60 seconds

    return () => clearInterval(syncInterval);
  }, [connState]);


  return (
    <View style={isLandscape ? [styles.container, { flex: 1 }] : styles.container}>
      <StatusBar hidden={isLandscape} />
      {/* Header */}
      {!fullscreen && !isLandscape && (
        <View style={styles.headerBar}>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerTitle}>🐾 CyberClaw</Text>
            <Text style={styles.versionTag}>v{APP_VERSION}</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={[styles.statusDot, isConnected ? styles.dotOnline : connState === 'lost' ? styles.dotLost : styles.dotOffline]} />
            <Text style={styles.statusLabel}>{statusLabel}</Text>
            <TouchableOpacity style={styles.settingsBtn} onPress={onOpenSettings}>
              <Text style={styles.settingsIcon}>⚙️</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* v3.10.115: sky gradient strip between the header and the
          arena. Tobe's spec (2026-07-30 21:45 GMT+2): a sky-blue
          gradient above the arena, reading as 'looking up through
          the trees'. Hidden in fullscreen / landscape like the
          header. The gradient is implemented as a View with a
          solid bg.skyLight bg + a thin bg.skyDeep bottom-border
          (no LinearGradient dep needed — keeps the bundle lean). */}
      {/* v3.10.121: skyStrip removed entirely (was hidden on dark
          in v3.10.120). Tobe's follow-up (2026-08-01 12:37):
          "Yeah we dont need that cloud pill in light mode
          either, it looks terrible." Confirmed — the cloud
          silhouette in the upper-right was the same element
          that looked like a slider on dark mode; on light
          mode it just looked like a misplaced white pill.
          Removing the whole skyStrip also lets the arena sit
          closer to the header. ARENA_HEIGHT bumps further to
          fill the freed ~16dp. */}
      {/* skyStrip REMOVED in v3.10.121 */}

      {/* Arena - Conditional rendering based on fullscreen, landscape, or arenaHidden.
          v3.10.122: arenaHidden (Tobe's 13:52 follow-up: "we
          should also add a hide arena button, perhaps in the
          bottom middle of the arena") collapses the arena to a
          thin strip with the active companion's icon + a "Show
          arena" button. Chat list gets the freed vertical
          space. Fullscreen/landscape modes still take
          precedence (those are for voice mode, which needs the
          arena). */}
      {!keyboardVisible && (
        arenaHidden && !fullscreen && !isLandscape ? (
          <View style={styles.arenaStrip}>
            <Text style={styles.arenaStripLabel}>
              {companionIconForActive(agentsRef.current, activeChatAgentIdRef.current)}{' '}
              {(agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current)?.name || 'Companion'}
            </Text>
            <TouchableOpacity style={styles.arenaShowButton} onPress={toggleArenaHidden}>
              <Text style={styles.arenaShowButtonText}>▼ Show arena</Text>
            </TouchableOpacity>
          </View>
        ) : (
        <View style={fullscreen || isLandscape ? [styles.arenaFrameFullscreen, { zIndex: 100 }] : styles.arenaFrame}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            // Include APP_VERSION in the URI so Android WebView doesn't serve a cached arena.html after an app upgrade.
            source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&platform=mobile` }}
            // Sleeping companions render desaturated + dim.
            style={
              sleepOverlay
                ? { flex: 1, backgroundColor: '#0a0a2e', opacity: 0.65, transform: [{ scale: 1 }] }
                : { flex: 1, backgroundColor: '#0a0a2e' }
            }
            scrollEnabled={false}
            bounces={false}
            javaScriptEnabled
            allowFileAccess
            originWhitelist={['*']}
            onMessage={handleArenaMessage}
            // Re-init the arena canvas whenever the WebView's container is laid out (tilt, fullscreen toggle, arena show/hide).
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              if (width <= 0 || height <= 0) return;
              const prev = webViewSizeRef.current;
              if (prev && prev.w === width && prev.h === height) return;
              webViewSizeRef.current = { w: width, h: height };
              // Only inject if the WebView has finished loading.
              // On the first onLayout before onLoadEnd, the script
              // isn't ready yet — we'll re-init in onLoadEnd below.
              if (webViewRef.current) {
                const initJs = `window.Arena && window.Arena.init(${width}, ${height}); true;`;
                webViewRef.current.injectJavaScript(initJs);
              }
            }}
            onLoadEnd={() => {
              // Tell the WebView its actual rendered size so it doesn't have to rely on window.innerWidth/Height (which on Android WebView returns the…
              const live = webViewSizeRef.current;
              const initW = live?.w ?? SCREEN_WIDTH;
              const initH = live?.h ?? ARENA_HEIGHT;
              const initJs = `window.Arena && window.Arena.init(${initW}, ${initH}); true;`;
              webViewRef.current?.injectJavaScript(initJs);
              Promise.all([
                AsyncStorage.getItem('cyberclaw-arena-bg'),
                AsyncStorage.getItem('cyberclaw-arena-comp'),
              ]).then(([bgId, compId]) => {
                const prefs = { type: 'loadPrefs', bgId: bgId || 'forest', compId: compId || 'fox' };
                // v3.1.37: use window.Arena.setBackground directly
                // instead of dispatchEvent (which the WebView
                // doesn't reliably handle for 'loadPrefs' either).
                const bgJs = `window.Arena && window.Arena.setBackground(${JSON.stringify(bgId || 'forest')}); true;`;
                webViewRef.current?.injectJavaScript(bgJs);
                // Also seed the agents list at load so the arena can show all companions immediately.
                if (agents.length > 0) {
                  const slim = agents.map((a) => ({
                    id: a.id, name: a.name, sprite: a.sprite || null, scale: a.scale || null,
                  }));
                  webViewRef.current?.injectJavaScript(
                    `window.Arena && window.Arena.setAgents(${JSON.stringify(slim)}); true;`,
                  );
                }
              });
            }}

  />
          {sleepOverlay && (
            <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 12, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#a78bfa' }}>
              <Text style={{ color: '#a78bfa', fontSize: 14, fontWeight: '700' }}>💤 sleeping</Text>
            </View>
          )}
          {/* v3.10.123: hide-arena button. Moved from bottom-center
              to TOP-center of the arena. Tobe's 2026-08-01
              15:22 follow-up: "Lets put the hide arena in the
              top of the arena Instead." The bottom-center was
              overlapping the Quests/Voice Mode buttons on
              some screens and the "Where am I" label
              (Clawsuu) on others. Top-center is clear of all
              existing UI elements. Only rendered in
              non-fullscreen + non-landscape mode (voice mode
              owns the arena in fullscreen). */}
          {!fullscreen && !isLandscape && (
            <TouchableOpacity
              style={styles.arenaHideButton}
              onPress={toggleArenaHidden}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.arenaHideButtonText}>▲ Hide arena</Text>
            </TouchableOpacity>
          )}
          {/* Close button removed - using arena Exit button instead */}
          {/* Voice status indicator in fullscreen mode */}
          {fullscreen && (
            <View style={styles.voiceStatusOverlay} pointerEvents="none">
              <Text style={styles.voiceStatusText}>
                {voiceStatus === 'listening' ? '🎧 Listening for audio...' :
                 voiceStatus === 'recording' ? '🔴 Recording...' :
                 voiceStatus === 'silence_countdown' ? `⏳ Sending in ${silenceCountdown}s...` :
                 voiceStatus === 'transcribing' ? '📝 Transcribing...' :
                 voiceStatus === 'thinking' ? '💭 Thinking...' :
                 voiceStatus === 'responding' ? '💬 Response incoming...' :
                 '🎧 Listening for audio...'}
              </Text>
            </View>
          )}
          {/* v3.1.89: voice log overlay shows last 5 lines (was 3) */}
          {fullscreen && (
            <View style={styles.voiceLogOverlay} pointerEvents="none">
              <Text style={styles.voiceLogText}>
                {voiceLogs.slice(-5).map((log, i) => `${log}`).join('\n')}
              </Text>
            </View>
          )}
        </View>
        )
      )}

      {/* Thinking indicator - Hidden when fullscreen */}
      {/* v3.10.69: removed. The orange "💭 Clawsuu is
          thinking..." bar above the tabs duplicated the
          chat-side status (chatStatusBar / chatVoiceStatus)
          and used a hard-coded "Clawsuu" name even when
          the user was chatting with Lamasuu. Tobe
          reported it as redundant. The arena WebView's
          sprite animation (driven by setArenaThinking in
          the onTyping handler) is unchanged — the
          companion still looks like it's thinking on
          screen, just without the redundant React text
          bar. */}

      {/* Tabs - Hidden when fullscreen or landscape */}
      {!fullscreen && !isLandscape && (
        <View style={styles.tabBar}>
          {(['chat', 'events', 'log'] as TabId[]).map(tab => (
            <TouchableOpacity key={tab} style={[styles.tab, activeTab === tab && styles.tabActive]} onPress={() => setActiveTab(tab)}>
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'chat' ? '💬 Chat' : tab === 'events' ? '📜 Events' : '📋 Log'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* v3.1.17: companion tab bar. Shows one tab per companion
          (dynamically built from the `agents` state populated by the
          desktop's `agents_list` sync event). Tapping a tab switches
          the active chat companion and loads that companion's chat
          history. Unread badges appear when a different companion
          received a message while the user is on this tab.
          v3.1.19: while the agents list is still loading, show a
          single 'Clawsuu' tab so the user can see the bar is there
          and we can tell from the device whether the rest of the
          flow is working.
          v3.1.16: removed the fake 'Clawsuu' fallback tab. It was
          misleading (looked like a real companion tab but had no
          data behind it) and it stayed visible even when the
          desktop's agents_list never arrived, masking the missing
          Lamasuu bug. Now the tab bar is hidden until at least one
          real companion is in the list, and a small inline
          'Loading companions…' placeholder takes its place so the
          chat area still has clear context. */}
      {!fullscreen && !isLandscape && (() => {
        if (agents.length === 0) {
          return (
            <View style={styles.companionTabBar}>
              <View style={styles.companionTabBarContent}>
                <Text style={styles.companionTabPlaceholder}>
                  {isConnected ? 'Loading companions…' : 'Connect to desktop to see companions'}
                </Text>
              </View>
            </View>
          );
        }
        return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.companionTabBar}
          contentContainerStyle={styles.companionTabBarContent}
        >
          {agents.map(a => {
            const isActive = activeChatAgentId === a.id;
            const unread = chatUnreadByAgent[a.id] || 0;
            return (
              <TouchableOpacity
                key={a.id}
                style={[styles.companionTab, isActive && styles.companionTabActive]}
                onPress={() => switchToAgent(a.id)}
              >
                {/* v3.1.47: companion tab no longer shows the robot emoji
                    fallback when a.emoji is missing. The companion name is
                    the only label now. If a.emoji is set we use it; if not,
                    we just show the name.
                    v3.1.68: fall back to the sprite icon (sent by the
                    desktop's agents_list payload) so newly added companions
                    show a meaningful icon next to the name without the user
                    having to set an emoji manually.
                    v3.1.69: prefer the bundled Twemoji SVG (iconFile)
                    when available — it renders smoothly at any size and
                    looks identical across all devices, unlike system
                    emoji fonts which vary by OS. */}
                {/* v3.1.73: drop the <Image>/SVG path and always render
                    the catalog emoji as text. The mobile doesn't have
                    react-native-svg installed, so a.iconDataUri (an
                    SVG data URI) silently failed to load in <Image> —
                    the chat tab rendered nothing while the chat label
                    used a.icon directly and worked. Same chain as the
                    chat label: a.emoji (per-agent override) → a.icon
                    (sprite catalog emoji) → nothing. */}
                {(() => {
                  // v3.11.44: a.emoji came through as template prose ('_your signature — pick one…_')
                  // and stretched the tab across the screen. Only accept short, letter-free values.
                  const e = a.emoji && a.emoji !== '🤖' && Array.from(a.emoji).length <= 4 && !/[A-Za-z]/.test(a.emoji) ? a.emoji : a.icon;
                  return e ? <Text style={styles.companionTabEmoji}>{e}</Text> : null;
                })()}
                <Text style={[styles.companionTabName, isActive && styles.companionTabNameActive]} numberOfLines={1}>
                  {a.name}
                </Text>
                {unread > 0 && (
                  <View style={styles.companionTabBadge}>
                    <Text style={styles.companionTabBadgeText}>{unread > 9 ? '9+' : unread}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        );
      })()}

      {/* Tab content - Hidden when fullscreen or landscape */}
      {!fullscreen && !isLandscape && (
      // KeyboardAvoidingView on iOS only.
      <KeyboardAvoidingView style={styles.tabContent} behavior='padding' enabled={Platform.OS === 'ios'}>
        {/* v3.11.39: keep all tab contents mounted (only
            toggle visibility via display:none) so the
            chat tab's FlatList scroll position, input
            text, and other transient state survive
            tab-switch round-trips. Tobe 2026-10-07 16:03:
            "iy resets some what after i go into settings
            for example. It should stay where it was left."
            Previously the conditional `activeTab === 'chat'
            && (...)` UNMOUNTED the chat tab when the user
            went to Settings, then re-mounted it at scrollY=0
            on return. Wrapping in display:none preserves
            the FlatList's internal scroll state. Each tab
            content is its own sibling inside the
            KeyboardAvoidingView; only the active one
            occupies layout space. */}
        <View style={{ flex: 1, display: activeTab === 'chat' ? 'flex' : 'none' }}>
          <>
            {/* v3.4.8: wrapped FlatList in a flex:1 View so
                the "↓ N new messages" floating badge can sit
                at the bottom of THIS container (i.e. above
                the input row) instead of at the bottom of
                the whole chat tab (which put it overlapping
                the input field). Previously the badge's
                `bottom: 8` was relative to the entire
                KeyboardAvoidingView tabContent, putting it
                inside the inputContainer area. */}
            <View style={styles.chatScrollContainer}>
              {/* v3.10.90: always show the "↓ N new messages" badge
                  when there are unread messages, even if the user is
                  already at the bottom. Previously it only showed when
                  !chatAtBottom, so when the user was at the bottom
                  and missed messages arrived (e.g. from a v3.2.23
                  reconnect replay after WS disconnect), they had no
                  visual cue that new content existed below.

                  Tobe's request (2026-07-23 23:26): "do we have a
                  update function when scrolling to the bottom? A
                  refresh for new messages like function?" — wants
                  an explicit affordance to discover and jump to new
                  messages, not just an auto-scroll. The badge
                  satisfies both: it's a tap target that scrolls to
                  the bottom (clearing the unread count), and it's
                  the visual indicator that "there are N messages you
                  haven't seen yet."

                  Behavior:
                  - User at bottom + unread count > 0: badge shows.
                    Tap → scrollToEnd + clear unread. Useful when
                    the WS briefly disconnected and replayed
                    messages after reconnect — the user might not
                    have noticed new content below.
                  - User scrolled up + unread count > 0: badge shows.
                    Same tap behavior — same goal.
                  - User at bottom + unread count = 0: badge hidden.
                    No need to scroll if there's nothing new.
              */}
              {chatUnreadCount > 0 && (
                <TouchableOpacity
                  style={styles.chatScrollToBottomBtn}
                  onPress={() => {
                    chatRef.current?.scrollToOffset({ offset: 0, animated: true });
                    setChatUnreadCount(0);
                  }}
                >
                  <Text style={styles.chatScrollToBottomText}>
                    ↓ {chatUnreadCount} new message{chatUnreadCount !== 1 ? 's' : ''}
                  </Text>
                </TouchableOpacity>
              )}
              {/* v3.10.138: persistent "jump to bottom" button.
                  Distinct from the unread badge above (which only
                  shows when chatUnreadCount > 0 and is centered).
                  This one is a small circular ⬇ icon pinned to the
                  LOWER RIGHT of the chat list and is visible
                  whenever the user is NOT at the bottom — regardless
                  of whether there are new messages. Tobe's report
                  2026-08-06 10:52: "add a go to bottom button in
                  the lower right side of the chat".

                  Why both: the unread badge is the celebratory
                  "you have new messages!" affordance (centered,
                  wider, mentions the count). The persistent
                  button is the always-available scroll handle for
                  long history scrolls — even when there are no new
                  messages, the user might be 200 lines up reading
                  old context and want a quick way back down. */}
              {!chatAtBottom && (
                <TouchableOpacity
                  style={styles.chatJumpToBottomBtn}
                  onPress={() => {
                    chatRef.current?.scrollToOffset({ offset: 0, animated: true });
                    setChatUnreadCount(0);
                  }}
                  accessibilityLabel="Jump to latest message"
                  accessibilityRole="button"
                >
                  <Text style={styles.chatJumpToBottomText}>↓</Text>
                </TouchableOpacity>
              )}
              {/* v3.11.42: image gallery button in the top
                  right of the chat. Shows a count of
                  images in the current chat. Tapping opens
                  a grid overlay with all images
                  (galleryOpen state). The button is
                  hidden when there are no images in the
                  current chat so it doesn't clutter the UI
                  for chats that never had image
                  attachments. */}
              {chatImages.length > 0 && (
                <TouchableOpacity
                  style={styles.chatGalleryBtn}
                  onPress={() => setGalleryOpen(true)}
                  accessibilityLabel={`View ${chatImages.length} images from this chat`}
                  accessibilityRole="button"
                >
                  <Text style={styles.chatGalleryText}>🖼 {chatImages.length}</Text>
                </TouchableOpacity>
              )}
            <FlatList
              ref={chatRef}
              data={chatData}
              extraData={visibleCount}
              keyExtractor={i => i.id}
              renderItem={renderMessage}
              // "Load more" button at the top of the chat, only shown when there are more older messages to reveal.
              ListFooterComponent={
                messages.length > visibleCount ? (
                  <TouchableOpacity
                    style={styles.chatLoadMoreBtn}
                    onPress={handleLoadMore}
                    accessibilityLabel={`Load ${Math.min(VISIBLE_BATCH, messages.length - visibleCount)} more messages`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chatLoadMoreText}>
                      ↑ Load older messages
                    </Text>
                  </TouchableOpacity>
                ) : null
              }
              // Footer-height estimate 56 → 44 to match the slimmer input row (paddingVertical 8→4 + paddingBottom-closed 8+insets→insets = ~12dp shorter).
              contentContainerStyle={[styles.chatList, {
                // inverted: paddingTop sits visually at the bottom
                paddingTop: 4 + 44 + insets.bottom,
                paddingBottom: 8,
              }]}
              onEndReached={() => { if (messages.length > visibleCount) handleLoadMore(); }}
              onEndReachedThreshold={0.5}
              // v3.11.51: keep the list pinned for the FIRST real new message only.
              // History re-syncs and live activity pings were causing the chat to
              // shift a pixel or two every ~30 s. Subsequent updates use undefined,
              // so the user's scroll position is preserved.
              maintainVisibleContentPosition={autoScrollMaintainConfig}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={true}
              scrollEnabled={true}
              // Simple chronological FlatList (not inverted).
              inverted
              onScroll={(e) => {
                // SCROLL HANDLER SIMPLIFIED.
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                lastScrollYRef.current = contentOffset.y;
                lastViewportHeightRef.current = layoutMeasurement.height;
                // v3.11.45: inverted → offset 0 is the newest message.
                const isAtBottom = contentOffset.y < 50;
                if (chatScrollKeyRef.current && pendingRestoreRef.current === null) setChatScrollPos(chatScrollKeyRef.current, contentOffset.y);
                setChatAtBottom(isAtBottom);
                // V3.10.96 kept: clear the unread badge + the per-companion tab badge when the user scrolls to the bottom.
                if (isAtBottom) {
                  setChatUnreadCount(0);
                  const aid = activeChatAgentIdRef.current;
                  if (aid) {
                    setChatUnreadByAgent(prev => {
                      if ((prev[aid] || 0) === 0) return prev;
                      return { ...prev, [aid]: 0 };
                    });
                  }
                }
              }}
              // NO AUTO-SCROLL on content size changes.
              onContentSizeChange={(_w, h) => {
                // v3.11.45: when a chat opens, jump to where the user left it
                // (0 = newest). New messages stay pinned via
                // maintainVisibleContentPosition — no scrollToEnd latches.
                const k = pendingRestoreRef.current;
                if (k !== null && h > 0) {
                  pendingRestoreRef.current = null;
                  pendingScrollKeyRef.current = null;
                  const y = getChatScrollPos(k);
                  chatRef.current?.scrollToOffset({ offset: y, animated: false });
                  const atBottom = y < 50;
                  chatAtBottomRef.current = atBottom;
                  setChatAtBottom(atBottom);
                  if (atBottom) setChatUnreadCount(0);
                }
              }}
              onLayout={() => { /* no-op — v3.11.40 scroll lives in onContentSizeChange */ }}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>
                    {!isConnected
                      ? "Connect to desktop CyberClaw to chat"
                      : !activeChatAgentId
                        ? "Pick a companion tab to start chatting"
                        : (() => {
                            const a = (agents || []).find(x => x.id === activeChatAgentId);
                            const name = a?.name || activeChatAgentId;
                            return `Say hi to ${name}! ${a?.emoji || a?.icon || '🐾'}`;
                          })()}
                  </Text>
                </View>
              }
            />
            </View>
            {/* v3.10.121: chat-footer overlay (status bar +
                attachment previews + cross-agent banner +
                input row) now floats at the bottom of the
                chatScrollContainer via styles.footerOverlay.
                The chat list extends behind it (chatList
                contentContainer paddingBottom reserves the
                space for the overlay). Tobe: "there is a
                tiny bit of room at the bottom also, that
                space could be used by the chat. Lets
                optimize space more." The footer overlay has
                backgroundColor: t.bg.primary so chat content
                behind it is hidden — the chat just gets
                more vertical room for messages. */}
            <View style={styles.footerOverlay}>
            {chatVoiceStatus && (
              // Claude-style thinking bar.
              <Animated.View style={[styles.chatStatusBar, { opacity: indicatorOpacity }]}>
                <View style={styles.chatStatusRow}>
                  <Animated.View
                    style={[
                      styles.chatStatusDot,
                      {
                        opacity: thinkPulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.35, 1],
                        }),
                        transform: [
                          {
                            scale: thinkPulse.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.7, 1.15],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                  <Text style={styles.chatStatusText} numberOfLines={1}>{chatVoiceStatus}</Text>
                  {thinkingElapsed >= 3 && (
                    <Text style={styles.chatStatusElapsed}>
                      {thinkingElapsed < 60 ? thinkingElapsed + 's' : Math.floor(thinkingElapsed / 60) + 'm ' + (thinkingElapsed % 60) + 's'}
                    </Text>
                  )}
                </View>
                {chatActions.length > 0 && (
                  <View style={styles.chatActionsRow}>
                    {chatActions.map((act, idx) => (
                      <Text
                        key={`${idx}-${act}`}
                        style={[
                          styles.chatActionText,
                          // Dim older actions; the most recent one stays at full opacity.
                          idx < chatActions.length - 1 && styles.chatActionTextFaded,
                        ]}
                        numberOfLines={1}
                      >
                        {idx < chatActions.length - 1 ? '✓ ' : '› '}{act}
                      </Text>
                    ))}
                  </View>
                )}
              </Animated.View>
            )}
            {/* v3.10.30: attachment preview row. When
                the user has attached a file/image, we
                show a small thumbnail strip ABOVE the
                input row with a × button to remove.
                v3.10.20 added attachment support but
                didn't show previews in the input area
                — the user had no idea their attachment
                was even there, and the send button was
                disabled when text was empty (so they
                couldn't send the attachment). Tobe:
                "one still cannot see the pasted picture
                in the chat. It might not even attach
                since i cannot hit send after adding it."
                Fixed in v3.10.30 by:
                1. Rendering this preview row
                2. Enabling the send button when
                   attachments exist (see sendMessage
                   enabled check below) */}
            {attachments.length > 0 && (
              <View style={styles.attachmentPreviewRow}>
                {attachments.map(att => {
                  const isImage = att.type?.startsWith('image/');
                  return (
                    <View key={att.id} style={styles.attachmentPreviewItem}>
                      {isImage ? (
                        // Tap the pending thumbnail to open the same fullscreen viewer the chat-history attachments use.
                        <TouchableOpacity
                          onPress={() => setFullscreenAttachment({
                            uri: att.uri,
                            type: att.type,
                            name: att.name,
                          })}
                          activeOpacity={0.7}
                          style={styles.attachmentPreviewThumbWrap}
                        >
                          <Image
                            source={{ uri: att.uri }}
                            style={styles.attachmentPreviewThumb}
                          />
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          onPress={() => setFullscreenAttachment({
                            uri: att.uri,
                            type: att.type,
                            name: att.name,
                          })}
                          activeOpacity={0.7}
                          style={styles.attachmentPreviewFile}
                        >
                          <Text style={styles.attachmentPreviewFileText} numberOfLines={1}>
                            {att.name}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={styles.attachmentPreviewRemove}
                        onPress={() => removeAttachment(att.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={styles.attachmentPreviewRemoveText}>×</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}
            {/* v3.10.36: cross-agent chat banner. Shows above
                the input row when OTHER agents have unread
                messages (unread > 0 for an agentId !=
                activeChatAgentId). One banner per unread
                agent; tapping switches to that agent's tab
                via switchToAgent() (same effect as tapping
                the companion tab itself — loads messages,
                clears unread, swaps arena sprite, requests
                fresh history). See styles.crossAgentBanner
                for visual styling. Closes the v3.10.35 Tobe
                report: "I noticed when receiving a new
                message that it did not appear in the chat
                but clawsuu had a red sign meaning he has
                sent a new message. Clicked that red and it
                appeared in the chat. This should just appear
                in the chat automatically, and it should
                appear an update button in the chat at the
                bottom if we must". */}
            {activeTab === 'chat' && agents
              .filter(a => a.id !== activeChatAgentId && (chatUnreadByAgent[a.id] || 0) > 0)
              .map((a) => {
                // Per-quest buckets.
                const aidBuckets = messagesByAgentAndQuest[a.id] || {};
                const previewQid: string | null =
                  activeChatQuestId === undefined ? null : activeChatQuestId;
                const previewKey = questKeyForStorage(previewQid);
                const lastMsg = (aidBuckets[previewKey] || []).slice(-1)[0];
                const preview = lastMsg?.text
                  ? (lastMsg.text.length > 48 ? lastMsg.text.substring(0, 45) + '…' : lastMsg.text)
                  : '(no preview)';
                const unreadCount = chatUnreadByAgent[a.id] || 0;
                return (
                  <TouchableOpacity
                    key={a.id}
                    style={styles.crossAgentBanner}
                    onPress={() => switchToAgent(a.id)}
                  >
                    <Text style={styles.crossAgentBannerEmoji}>{a.emoji || a.icon || '💬'}</Text>
                    <Text style={styles.crossAgentBannerText} numberOfLines={1}>
                      {a.name} — {unreadCount} new {unreadCount === 1 ? 'message' : 'messages'}
                      {'\n'}
                      <Text style={styles.crossAgentBannerPreview}>&ldquo;{preview}&rdquo;</Text>
                    </Text>
                    <Text style={styles.crossAgentBannerAction}>View →</Text>
                  </TouchableOpacity>
                );
              })}
            {/* v3.10.105: removed the "Recent" pill row
                (added in v3.10.103, Tobe asked for it
                gone — see CHANGES_3.10.105.md). The full
                chat history is still scrollable above
                the input; if a recovery shortcut is
                wanted later we can add it back as a
                single button instead of a row. */}
            {activeQuestInfo && (
              <View style={styles.ctxRow}>
                <View style={[styles.ctxPill, chatCasual ? styles.ctxPillCasual : styles.ctxPillQuest]}>
                  <Text style={[styles.ctxPillText, chatCasual ? styles.ctxPillTextCasual : styles.ctxPillTextQuest]} numberOfLines={1}>
                    {chatCasual ? '💬 Casual' : '📜 ' + activeQuestInfo.name}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.ctxSwitch}
                  onPress={() => { const next = !chatCasual; setChatCasual(next); syncClient.setChatContext(next); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.ctxSwitchText} numberOfLines={1}>↔ {chatCasual ? activeQuestInfo.name : 'Casual'}</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={[styles.inputContainer, {
              // Android keyboard avoidance.
              paddingBottom: Platform.OS === 'android' && keyboardHeight > 0
                ? keyboardHeight
                : insets.bottom,
            }]}>
              {/* v3.10.183: local-LLM status pill. Sits above the
                  input row so it doesn't shift the keyboard.
                  Hidden when no status is known or the active
                  companion doesn't use a local model. The pill
                  itself returns null in those cases. */}
              <LlmStatusPill
                status={llmStatus}
                activeAgentId={activeChatAgentId}
                onAction={async ({ model, action }) => {
                  try {
                    syncClient.sendLlmAction(model, action);
                  } catch (e: any) {
                    addLogEntry(`LLM pill action failed: ${e?.message}`, 'error');
                  }
                }}
              />
              <TouchableOpacity style={styles.micButton} onPress={handleAttach}>
                <Text style={[styles.micButtonText, styles.micButtonPlusText]}>+</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.micButton, isVoiceListening && styles.micButtonActive]}
                onPress={toggleVoiceInput}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.6}
              >
                <Text style={[styles.micButtonText, styles.micButtonMicText, isVoiceListening && { color: '#ef4444' }]}>
                  {isVoiceListening ? '⏹' : '🎙️'}
                </Text>
              </TouchableOpacity>
              {pendingAudioPath ? (
                <View style={styles.voicePreview}>
                  <Text style={styles.voicePreviewText}>🎤 Voice message ready</Text>
                  <TouchableOpacity onPress={() => setPendingAudioPath(null)}>
                    <Text style={styles.voicePreviewDiscard}>✕</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TextInput
                  style={styles.textInput}
                  value={inputText}
                  onChangeText={setInputText}
                  placeholder={!isConnected
                    ? "Not connected"
                    : !activeChatAgentId
                      ? "Pick a companion tab first"
                      : (() => {
                          const a = (agents || []).find(x => x.id === activeChatAgentId);
                          return `Message ${a?.name || activeChatAgentId}...`;
                        })()}
                  placeholderTextColor="#555"
                  editable={isConnected}
                  multiline
                  maxLength={2000}
                  returnKeyType="send"
                  onSubmitEditing={sendMessage}
                  blurOnSubmit={false}
                />
              )}
              <TouchableOpacity
                style={[styles.sendButton, (!pendingAudioPath && !inputText.trim() && attachments.length === 0 || !isConnected) && styles.sendButtonDisabled]}
                onPress={sendMessage}
                disabled={!pendingAudioPath && !inputText.trim() && attachments.length === 0 || !isConnected}
              >
                <Text style={styles.sendButtonText}>▶</Text>
              </TouchableOpacity>
            </View>
            </View>
          </>
        </View>

        <View style={{ flex: 1, display: activeTab === 'events' ? 'flex' : 'none' }}>
          <FlatList
            ref={eventsRef}
            data={events}
            keyExtractor={(_, i) => `ev-${i}`}
            renderItem={({ item }) => <Text style={styles.eventLine}>{item}</Text>}
            contentContainerStyle={{ padding: 12 }}
            onContentSizeChange={() => eventsRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={<Text style={[styles.emptyChatText, { padding: 20 }]}>No events yet</Text>}
          />
        </View>

        <View style={{ flex: 1, display: activeTab === 'log' ? 'flex' : 'none' }}>
          <>
            <View style={styles.wakeDebugBar}>
              {/* v3.10.39: renamed 'Mic:' prefix to 'Wake:'.
                  The wakeDebug stream catches EVERY wake-module
                  emit (mic init, OWW load, sample-match event,
                  TTS init, recorder WAV write, etc.), so
                  prefixing it 'Mic:' was misleading — the only
                  mic-specific error was one of several possible
                  states. 'Wake:' labels the underlying stream
                  accurately. Tobe noticed v3.10.38 showed
                  'Mic: error: TTS init failed' which made no
                  sense for a wake-debug label. */}
              <Text style={styles.wakeDebugText} numberOfLines={1}>Wake: {wakeDebug}</Text>
            </View>
            <FlatList
              ref={logRef}
              data={logEntries}
              keyExtractor={i => i.id}
              renderItem={renderLog}
              contentContainerStyle={styles.logList}
              showsVerticalScrollIndicator={false}
              onScroll={(e) => {
                // Detect whether the user is at the bottom.
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
                logStickyBottomRef.current = distanceFromBottom < 32;
              }}
              scrollEventThrottle={16}
              onContentSizeChange={() => {
                // Only auto-scroll if the user was already at the bottom when new content arrived.
                if (logStickyBottomRef.current) {
                  logRef.current?.scrollToEnd({ animated: false });
                }
              }}
              ListEmptyComponent={<Text style={[styles.emptyChatText, { padding: 20 }]}>No log entries</Text>}
            />
          </>
        </View>
      </KeyboardAvoidingView>
      )}

      {/* v3.10.20: fullscreen attachment viewer. Opens
          when the user taps an attachment preview in
          the chat. Shows the image at its natural size
          (capped at the screen dimensions) with a dark
          background and a close button. Tap the close
          button OR the image to dismiss. */}
      <Modal
        visible={fullscreenAttachment !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreenAttachment(null)}
      >
        <TouchableOpacity
          style={styles.fullscreenAttachmentBackdrop}
          activeOpacity={1}
          onPress={() => setFullscreenAttachment(null)}
        >
          {fullscreenAttachment && (
            <View style={styles.fullscreenAttachmentContent}>
              {fullscreenAttachment.type?.startsWith('image/') ? (
                <Image
                  // Prefer the inline base64 data URI over the cached file path.
                  source={fullscreenAttachment.data
                    ? { uri: `data:${fullscreenAttachment.type};base64,${fullscreenAttachment.data}` }
                    : { uri: fullscreenAttachment.uri }}
                  style={styles.fullscreenAttachmentImage}
                  resizeMode="contain"
                />
              ) : (
                <View style={styles.fullscreenAttachmentFileCard}>
                  <Text style={styles.fullscreenAttachmentFileIcon}>📎</Text>
                  <Text style={styles.fullscreenAttachmentFileName}>
                    {fullscreenAttachment.name}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                style={styles.fullscreenAttachmentClose}
                onPress={() => setFullscreenAttachment(null)}
              >
                <Text style={styles.fullscreenAttachmentCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
      </Modal>

      {/* v3.11.42: image gallery overlay. Shows all images
          from the current chat in a 3-column grid. Tap a
          thumbnail to open the fullscreen viewer (reusing
          the existing fullscreenAttachment state). The
          header has a close button (✕) to dismiss. */}
      <Modal
        visible={galleryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGalleryOpen(false)}
      >
        <View style={styles.galleryBackdrop}>
          <View style={styles.galleryHeader}>
            <Text style={styles.galleryTitle}>
              {chatImages.length === 1
                ? '1 image'
                : `${chatImages.length} images`}
            </Text>
            <TouchableOpacity
              onPress={() => setGalleryOpen(false)}
              accessibilityLabel="Close gallery"
              accessibilityRole="button"
            >
              <Text style={styles.galleryClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={chatImages}
            keyExtractor={(item, i) => `${item.msgId}-${i}`}
            numColumns={3}
            contentContainerStyle={styles.galleryGrid}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.galleryItem}
                onPress={() => {
                  // Open the existing fullscreen viewer.
                  setFullscreenAttachment(item.att);
                  // Don't close the gallery — the user closes it via the fullscreen viewer's ✕ button (or back button on Android).
                  setGalleryOpen(false);
                }}
                activeOpacity={0.7}
              >
                <Image
                  source={
                    item.att.data
                      ? { uri: `data:${item.att.type};base64,${item.att.data}` }
                      : { uri: item.att.uri }
                  }
                  style={styles.galleryItemImage}
                  resizeMode="cover"
                />
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={[styles.emptyChatText, { textAlign: 'center', padding: 20 }]}>
                No images in this chat yet.
              </Text>
            }
          />
        </View>
      </Modal>

      {/* v3.10.75: the feed picker Modal is gone. The
          🍖 button, feed menu, drag-and-drop ghost,
          and tap-to-drop all live inside the WebView
          (arena.html). Tobe asked on 2026-07-22 that
          "the menu should open inside the arena" — the
          HTML menu inside the WebView shares the same
          coordinate space as the canvas, so tap-to-
          drop or drag-to-place is one step (no
          cross-boundary coordinate translation). The
          React Native side just listens for
          treat_placed / treat_eaten from the WebView
          and forwards them to the desktop so the AI
          text replies can match. */}
    </View>
  );
}

// Short time-ago for the recent-pills row.
function formatTimeAgoShort(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return '1d ago';
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // SkyStrip + skyStripCloud styles removed.
  arenaFrame: {
    height: ARENA_HEIGHT,
    borderWidth: 3,
    // Arena frame border per theme.
    borderColor: t.name === 'dark' ? t.brand.accent : t.border.strong,
    borderRadius: 6,
    // Arena fill per theme.
    backgroundColor: t.name === 'dark' ? 'transparent' : t.bg.forestDark,
  },
  arenaFrameFullscreen: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 100,
  },
  // Collapsed-arena strip.
  arenaStrip: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    backgroundColor: t.bg.primary,
    borderBottomWidth: 1,
    borderBottomColor: t.border.subtle,
  },
  arenaStripLabel: {
    color: t.text.primary,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  arenaShowButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: t.brand.accent,
    backgroundColor: 'rgba(247, 147, 26, 0.12)',
  },
  arenaShowButtonText: {
    color: t.brand.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  // Hide-arena button overlay (TOP-center of the arena, per Tobe's 15:22 follow-up).
  arenaHideButton: {
    position: 'absolute',
    top: 6,
    left: '50%',
    marginLeft: -44,  // half of 88px width — visually centered
    width: 88,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.4)',
    alignItems: 'center',
  },
  arenaHideButtonText: {
    color: '#f7931a',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  container: { flex: 1, backgroundColor: t.bg.primary },
  wakeModeBadge: {
    color: '#f7931a',
    fontSize: 11,
    fontWeight: 'bold',
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(247, 147, 26, 0.15)',
    borderRadius: 4,
  },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 44,
    // 6 → 2 AND borderBottom removed.
    paddingBottom: 2,
    backgroundColor: t.bg.primary,
  },
  headerTitle: { color: t.brand.accent, fontSize: 16, fontWeight: 'bold' },
  headerTitleContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  versionTag: {
    color: '#666',
    fontSize: 10,
    fontWeight: '500',
  },
  headerTitleGroup: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    flex: 1,
  },
  headerTitleLeft: { color: t.brand.accent, fontSize: 16, fontWeight: 'bold' },
  headerTitleRight: { color: t.brand.accent, fontSize: 16, fontWeight: 'bold' },
  headerCameraSpace: { width: 32 }, // room for camera cutout
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  dotOnline: { backgroundColor: t.brand.success },
  dotOffline: { backgroundColor: t.text.dim },
  dotLost: { backgroundColor: t.brand.danger },
  statusLabel: { color: t.text.muted, fontSize: 12, marginRight: 10 },
  settingsBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: t.bg.tertiary,
    borderWidth: 1, borderColor: t.border.mid,
    justifyContent: 'center', alignItems: 'center',
  },
  settingsIcon: { fontSize: 16 },
  wakeDebugBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.bg.tertiary, paddingHorizontal: 10, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: t.border.subtle,
  },
  wakeDebugText: { flex: 1, color: t.brand.success, fontSize: 11, fontFamily: 'monospace' },
  tabBar: {
    flexDirection: 'row', backgroundColor: t.bg.primary,
    borderBottomWidth: 1, borderBottomColor: t.border.subtle,
  },
  tab: { flex: 1, paddingVertical: 4, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: t.brand.accent },
  tabText: { color: t.text.dim, fontSize: 13 },
  tabTextActive: { color: t.brand.accent, fontWeight: 'bold' },
  // Companion tab bar (one tab per companion).
  companionTabBar: {
    // Forest green to match the arena frame, reading as a single 'forest zone' above the chat.
    backgroundColor: t.name === 'light' ? t.bg.skyLight
                   : t.name === 'forest' ? t.bg.ground
                   : t.bg.forestDark,
    borderBottomWidth: 1,
    // v3.10.119: tab bar border per theme. Sun uses
    // border.mid (pale blue), Forest uses border.brown
    // (bark), Moon uses border.strong (deep forest).
    borderBottomColor: t.name === 'light' ? t.border.mid
                     : t.name === 'forest' ? t.border.brown
                     : t.border.strong,
    maxHeight: 36,
  },
  companionTabBarContent: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignItems: 'center',
  },
  // Small inline label that shows in place of the tab bar while the desktop's agents list is still loading.
  companionTabPlaceholder: {
    color: t.text.muted,
    fontSize: 12,
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  // v3.1.48: tighter companion tab — less padding, smaller margins.
  companionTab: {
    maxWidth: 160,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#15151f',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 4,
    borderWidth: 1,
    borderColor: '#222',
  },
  companionTabActive: {
    // Was rgba(247,147,26,0.18) bg + #f7931a border.
    backgroundColor: t.bg.forestDark,
    borderColor: t.border.strong,
  },
  // v3.1.48: tighter companion tab emoji and name.
  companionTabEmoji: {
    fontSize: 12,
    marginRight: 4,
  },
  // Twemoji SVG icon for the companion tab.
  companionTabIconImg: {
    width: 20,
    height: 20,
    marginRight: 4,
  },
  companionTabName: {
    color: '#888',
    fontSize: 11,
    fontWeight: '600',
    maxWidth: 80,
  },
  companionTabNameActive: {
    // Was #f7931a (brand accent orange).
    color: t.text.primary,
  },
  companionTabBadge: {
    marginLeft: 6,
    backgroundColor: '#ef4444',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    minWidth: 16,
    alignItems: 'center',
  },
  companionTabBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  tabContent: { flex: 1 },
  // Chat list bg is the soft cream (matches the 'chat can be more of the White' spec from Tobe).
    chatList: {
    // Bumped paddingBottom from 8 to ~64+insets so the last chat message can scroll above the floating input row.
    padding: 12,
    paddingBottom: 8,
    backgroundColor: t.name === 'forest' ? t.bg.ground : t.bg.primary,
  },
  dateSeparator: {
    color: t.brand.accent,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
    marginVertical: 10,
    opacity: 0.85,
  },
  // Quest-change separator.
  questSeparator: {
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 4,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(247, 147, 26, 0.25)',
  },
  questSeparatorText: {
    color: '#f7931a',
    fontSize: 11,
    fontWeight: '600',
    opacity: 0.7,
  },
  // White bubbles with sky/forest borders per Tobe's spec ('the chat can be more of the White.
  messageBubble: { maxWidth: '85%', padding: 10, borderRadius: 12, marginBottom: 8, backgroundColor: t.bg.secondary, borderWidth: 1, borderColor: t.border.mid },
  userBubble: { alignSelf: 'flex-end', backgroundColor: t.bg.secondary, borderBottomRightRadius: 4, borderColor: t.brand.cyan, borderWidth: 1.5 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: t.bg.secondary, borderBottomLeftRadius: 4, borderColor: t.brand.accent, borderWidth: 1.5 },
  // Task summary footer styles.
  taskErrorCard: { marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: 'rgba(255, 80, 80, 0.08)', borderWidth: 1, borderColor: t.brand.danger },
  taskErrorCardCollapsed: { marginTop: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: 'rgba(255, 80, 80, 0.04)', borderWidth: 1, borderColor: 'rgba(255, 80, 80, 0.25)' },
  taskErrorCollapsedText: { fontSize: 11, color: t.text.muted, fontStyle: 'italic' },
  taskErrorHeader: { fontSize: 13, fontWeight: '700', color: t.brand.danger, marginBottom: 6 },
  taskErrorDuration: { fontWeight: '400', color: t.text.muted },
  taskStepsBlock: { marginBottom: 8 },
  taskStepsHeader: { fontSize: 11, color: t.text.muted, marginBottom: 4 },
  taskStepLine: { fontSize: 11, color: t.text.primary, marginLeft: 4, marginTop: 1 },
  taskActionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  taskActionButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: t.bg.tertiary, borderWidth: 1, borderColor: t.border.mid },
  taskActionText: { fontSize: 11, color: t.brand.cyanDim, fontWeight: '600' },
  agentLabel: { fontSize: 10, fontWeight: '700', marginBottom: 4, color: t.text.muted },
  userLabel: { color: t.brand.cyanDim, fontWeight: 'bold' },
  aiLabel: { color: t.brand.accent, fontWeight: 'bold' },
  // Bubble header row hosts the agent label on the left and the quest chip on the right.
  bubbleHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  // The quest chip: small, tinted (NOT solid), rounded.
  bubbleQuestLabel: { fontSize: 9, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden', marginLeft: 6, maxWidth: '60%' },
  bubbleQuestLabelAi: { backgroundColor: t.brand.accentDim + '22', color: t.brand.accent },
  bubbleQuestLabelUser: { backgroundColor: t.brand.cyanDim + '22', color: t.brand.cyanDim },
  // Text follows the bubble border color so user messages read as 'from you' (sky blue text) and AI as 'from companion' (forest green text).
  messageText: { fontSize: 13, lineHeight: 18, color: t.text.primary },
  userText: { color: t.brand.cyanDim, fontWeight: '500' },
  aiText: { color: t.brand.accentDim, fontWeight: '500' },
  timestamp: { color: t.text.muted, fontSize: 9, marginTop: 4, textAlign: 'right' },

  // Attachment rendering.
  attachmentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 6,
  },
  attachmentImageWrap: {
    // Bigger image preview for chat attachments (Tobe's request 2026-07-23: "Click the image that i have attached to inspect it like one can on…
    width: 180,
    height: 180,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.4)',
  },
  attachmentImage: {
    width: '100%',
    height: '100%',
  },
  attachmentFileWrap: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(247,147,26,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(247,147,26,0.4)',
    minWidth: 96,
  },
  attachmentFileInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  attachmentFileIcon: { fontSize: 16 },
  attachmentFileName: { fontSize: 12, color: '#f7931a', flexShrink: 1 },
  fullscreenAttachmentBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenAttachmentContent: {
    flex: 1,
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenAttachmentImage: {
    width: '100%',
    height: '100%',
  },
  fullscreenAttachmentFileCard: {
    padding: 32,
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    alignItems: 'center',
    gap: 12,
  },
  fullscreenAttachmentFileIcon: { fontSize: 48, color: '#f7931a' },
  fullscreenAttachmentFileName: { fontSize: 16, color: '#fff' },
  fullscreenAttachmentClose: {
    position: 'absolute',
    top: 48,
    right: 24,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenAttachmentCloseText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
  },
  emptyChat: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 },
  emptyChatText: { color: t.text.muted, fontSize: 14, textAlign: 'center' },
  // v3.11.44: casual/quest toggle row
  ctxRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 6, paddingHorizontal: 12 },
  ctxPill: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14, borderWidth: 1, maxWidth: 200 },
  ctxPillQuest: { backgroundColor: 'rgba(247,147,26,0.14)', borderColor: '#f7931a' },
  ctxPillCasual: { backgroundColor: 'rgba(148,163,184,0.12)', borderColor: '#64748b' },
  ctxPillText: { fontSize: 12, fontWeight: '700' },
  ctxPillTextQuest: { color: '#f7931a' },
  ctxPillTextCasual: { color: '#cbd5e1' },
  ctxSwitch: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: '#334155', maxWidth: 170 },
  ctxSwitchText: { color: '#94a3b8', fontSize: 12 },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12,
    // PaddingVertical 8 → 4.
    paddingVertical: 4,
    borderTopWidth: 1, borderTopColor: t.border.subtle, backgroundColor: t.bg.primary,
  },
  // v3.10.30: attachment preview row (sits above
  // the inputContainer). Horizontal scroll of
  // thumbnails with a small × on each.
  attachmentPreviewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    backgroundColor: t.bg.primary,
    borderTopWidth: 1,
    borderTopColor: t.border.subtle,
    gap: 8,
  },
  attachmentPreviewItem: {
    position: 'relative',
    width: 60,
    height: 60,
    borderRadius: 6,
    // Removed `overflow: 'hidden'` so the floating ×-remove button (positioned at top: 2, right: 2 with negative offsets in earlier versions)…
  },
  // Inner image gets its own borderRadius (slightly smaller than the container's 6 so the rounded corners still show).
  attachmentPreviewThumbWrap: {
    width: '100%',
    height: '100%',
  },
  attachmentPreviewThumb: {
    width: '100%',
    height: '100%',
    // Match the container's borderRadius so the image is visually clipped to the same rounded shape.
    borderRadius: 6,
  },
  attachmentPreviewFile: {
    width: '100%',
    height: '100%',
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  attachmentPreviewFileText: {
    color: '#888',
    fontSize: 9,
    textAlign: 'center',
  },
  attachmentPreviewRemove: {
    position: 'absolute',
    // Was top: -4, right: -4 (outside the 60×60 container that had overflow:hidden) which clipped the button.
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentPreviewRemoveText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  textInput: {
    flex: 1,
    backgroundColor: t.input.bg, color: t.text.primary,
    borderColor: t.input.border, borderWidth: 1,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 15, maxHeight: 100,
  },
  sendButton: {
    marginLeft: 8, width: 40, height: 40, borderRadius: 20,
    backgroundColor: t.brand.accent, justifyContent: 'center', alignItems: 'center',
  },
  sendButtonDisabled: { backgroundColor: t.border.mid },
  sendButtonText: { color: t.text.inverse, fontSize: 16, fontWeight: 'bold' },
  eventLine: { color: t.brand.cyan, fontSize: 12, fontFamily: 'monospace', lineHeight: 18, marginBottom: 4, fontWeight: '500' },
  logList: { padding: 12, backgroundColor: t.bg.primary },
  logLine: { color: t.text.muted, fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  logSent: { color: t.brand.cyan },
  logReceived: { color: t.brand.success },
  logError: { color: t.brand.danger },
  micButton: {
    backgroundColor: t.brand.accentGlow, borderRadius: 18,
    width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: t.brand.accent, marginRight: 6,
  },
  micButtonActive: {
    backgroundColor: 'rgba(239,68,68,0.25)', borderColor: '#ef4444',
  },

  micButtonText: { color: '#f7931a', fontWeight: '600' },
  // Different sizes for the + vs mic-icon labels so each renders cleanly inside the smaller 36x36 button.
  micButtonPlusText: { fontSize: 22, lineHeight: 24 },
  micButtonMicText: { fontSize: 18, lineHeight: 20 },
  voicePreview: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(247,147,26,0.12)', borderRadius: 12, paddingHorizontal: 14,
    paddingVertical: 10, marginRight: 6, borderWidth: 1, borderColor: 'rgba(247,147,26,0.4)',
  },
  voicePreviewText: { color: '#f7931a', fontSize: 14, fontWeight: '600' },
  voicePreviewDiscard: { color: '#888', fontSize: 18, paddingLeft: 12 },
  chatStatusBar: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: 'rgba(247,147,26,0.10)',
    borderTopWidth: 1, borderTopColor: 'rgba(247,147,26,0.18)',
  },
  chatStatusRow: {
    flexDirection: 'row', alignItems: 'center',
  },
  // Pulsing dot.
  chatStatusDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#f7931a',
    marginRight: 8,
  },
  chatStatusText: {
    color: 'rgba(247,147,26,0.95)', fontSize: 13, fontStyle: 'italic', fontWeight: '500', flexShrink: 1,
  },
  resendBtn: { alignSelf: 'flex-end', marginTop: 3, marginRight: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(34,211,238,0.35)' },
  resendText: { color: 'rgba(34,211,238,0.85)', fontSize: 11, fontWeight: '600' },
  chatStatusElapsed: {
    marginLeft: 'auto', paddingLeft: 10, color: 'rgba(247,147,26,0.6)', fontSize: 11, fontVariant: ['tabular-nums'],
  },
  // Action log row.
  chatActionsRow: {
    marginTop: 4, marginLeft: 16,
  },
  chatActionText: {
    color: 'rgba(247,147,26,0.95)', fontSize: 11, fontStyle: 'italic',
    lineHeight: 14,
  },
  chatActionTextFaded: {
    color: 'rgba(247,147,26,0.55)',
  },
  // Wrapper View for the chat FlatList.
  chatScrollContainer: { flex: 1, flexDirection: 'column' },
  // Floating footer overlay.
  footerOverlay: {
    backgroundColor: t.bg.primary,
  },
  // v3.1.14: "↓ N new messages" floating badge shown above the chat
  // when the user has scrolled up to read history and incoming
  // messages arrive.
  chatScrollToBottomBtn: {
    position: 'absolute',
    bottom: 8,
    left: 0, right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  chatScrollToBottomText: {
    backgroundColor: '#f7931a',
    color: '#000',
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
  },
  // Persistent circular jump-to-bottom button.
  chatJumpToBottomBtn: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 11,  // one above the unread badge (zIndex 10)
    // Subtle drop shadow so the button reads as floating above
    // the chat content rather than embedded in it.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  chatJumpToBottomText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,  // vertical-center the ↓ glyph in the 40px circle
  },
  // "Load more" button at the top of the chat.
  chatLoadMoreBtn: {
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  chatLoadMoreText: {
    color: t.text.secondary ?? '#aaa',
    fontSize: 12,
    fontWeight: '500',
  },
  // v3.11.42: image gallery button. Top right of the chat
  // FlatList, similar in style to chatJumpToBottomBtn but
  // mirrored horizontally and at the top.
  chatGalleryBtn: {
    position: 'absolute',
    right: 12,
    top: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  chatGalleryText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  // v3.11.42: image gallery overlay. Dark backdrop with a
  // grid of thumbnails. Tapping a thumbnail opens the
  // fullscreen image viewer.
  galleryBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
  },
  galleryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  galleryTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  galleryClose: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
    paddingHorizontal: 8,
  },
  galleryGrid: {
    paddingHorizontal: 8,
    paddingBottom: 24,
  },
  galleryItem: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 4,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  galleryItemImage: {
    width: '100%',
    height: '100%',
  },
  // Cross-companion chat banner.
  crossAgentBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(247, 147, 26, 0.12)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(247, 147, 26, 0.4)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(247, 147, 26, 0.4)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginVertical: 4,
    borderRadius: 10,
  },
  crossAgentBannerEmoji: {
    fontSize: 22,
    marginRight: 10,
  },
  crossAgentBannerText: {
    flex: 1,
    color: '#f7931a',
    fontSize: 13,
    fontWeight: '600',
  },
  crossAgentBannerPreview: {
    color: '#ddd',
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
  },
  crossAgentBannerAction: {
    color: '#0a0a0a',
    backgroundColor: '#f7931a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 8,
    overflow: 'hidden',
  },
  voiceModeBtnText: {
    color: '#f7931a', fontSize: 14, fontWeight: '600',
  },
  // Voice Mode Close Button
  voiceModeCloseBtn: {
    position: 'absolute', top: 24, right: 16,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 2, borderColor: '#ef4444',
    justifyContent: 'center', alignItems: 'center',
  },
  voiceModeCloseBtnText: {
    color: '#ef4444', fontSize: 24, fontWeight: 'bold',
  },
  // Voice status indicator during recording/transcribing
  voiceStatusOverlay: {
    position: 'absolute', top: 80, left: 0, right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  voiceStatusText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 16,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    textAlign: 'center',
  },
  voiceLogOverlay: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    maxHeight: 200,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderLeftWidth: 3,
    borderLeftColor: '#00ff00',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 4,
  },
  voiceLogText: {
    color: '#00ff00',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 14,
  },
  voiceExitButton: {
    position: 'absolute',
    top: 40,
    right: 40,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(247, 147, 26, 0.9)',
    borderWidth: 2,
    borderColor: '#f7931a',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1001,
    elevation: 20,
  },
  voiceExitButtonText: {
    fontSize: 32,
    color: '#fff',
    fontWeight: 'bold',
  },
  loadMoreBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(247,147,26,0.2)',
  },
  loadMoreText: {
    color: 'rgba(247,147,26,0.7)',
    fontSize: 12,
    fontWeight: '600',
  },
});
