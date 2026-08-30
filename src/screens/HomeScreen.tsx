/**
 * HomeScreen - CyberClaw mobile companion
 * Arena (real sprites) + Chat/Events/Log tabs + TTS + background service
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, StyleSheet, Image,
  Platform, Keyboard, Dimensions, KeyboardAvoidingView, Alert, Modal,
  NativeModules, StatusBar, NativeEventEmitter, BackHandler, AppState,
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
// v3.10.113: theme support. The container, top bar, and
// chat input bar follow the active theme. The arena (WebView)
// and chat messages are media content and stay dark — they
// ship their own backgrounds via the WebView's CSS.
import { useTheme } from '../theme/ThemeContext';
import { Theme } from '../theme/tokens';

// Native modules
const { BackgroundService, AppControl, WakeWordModule } = NativeModules;
// Lazy getter - NativeEventEmitter must not be instantiated at module eval time
// (bridge may not be ready). Create on first use instead.
let _wakeWordEmitter: NativeEventEmitter | null = null;

// Module-level wake-recovery state. These survive React re-renders (and
// the per-render watcher effect below uses them to re-apply fullscreen
// whenever the state gets wiped). They do NOT survive a full component
// unmount, but that's handled by the AsyncStorage-based recovery in
// the useEffect above.
let moduleLevelWakePending = false;
let moduleLevelWakePendingAt = 0;

// v3.5.1: in-memory guard so HomeScreen's checkPending
// effect cannot immediately re-trigger voice mode after
// the user just exited it. The AsyncStorage-based check
// is racy (removeItem in App.tsx's onExit is async; HomeScreen's
// mount runs getItem in parallel and can see the still-set
// flag). This guard survives re-mounts within the same JS
// process but is intentionally NOT persisted — the
// AsyncStorage flag is still the source of truth for the
// "activity-torn-down" case where the JS process was killed.
//
// v3.5.2: bumped default window 3s → 5s. Tobe reported
// v3.5.1 still re-opened voice mode twice after exit,
// suggesting the OWW detector (still running across the
// screen change) emits a queued owwWakeDetected within
// ~2-4s of the close. 5s gives ample headroom for the
// detector to settle past its 2s cooldown and the JS
// event queue to drain, without keeping the user locked
// out of a re-trigger for an unreasonably long time.
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

// v3.1.29: lookup the most recent training samples across all
// phrases. Used as a fallback when the user has trained for
// "hey clawsuu" but the settings say "hey claw" (or any
// other mismatch). Scans AsyncStorage for the
// cyberclaw-wake-samples-* keys and returns the first one
// with valid training data. Returns `null` if no training
// data exists for any phrase.
//
// We don't try to migrate the keys when the phrase changes
// in settings — that would silently re-train the user on a
// different phrase without their consent. The fallback is
// for "I had it working, the settings got reset, I don't
// want to re-train right now". The user can re-train to
// permanently fix the mismatch.
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
  // v3.1.95: replaced DTW-based sample matcher with openWakeWord
  // TFLite inference. The native side runs ML inference on the
  // audio stream and emits 'owwWakeDetected' when a wake word
  // is recognized. This is far more accurate than the DTW
  // matcher (~95%+ vs ~30%) and has near-zero false positives.
  //
  // The 'companionsTraining' parameter is kept for API
  // compatibility but no longer used for matching — the
  // companionId routing is now done by the active companion
  // when the wake word fires (any wake word → active companion).
  // Per-companion wake words with custom-trained models are
  // the next step (requires the desktop training pipeline).
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
  // The init is async but the start call is fire-and-forget — if init
  // fails, the wake listener just won't fire (logged in onLog).
  // v3.2.30: thread the caller's threshold through to
  // initOww. Previously the threshold parameter was
  // accepted but ignored, hardcoding 0.5 (50% confidence)
  // regardless of what the foreground/background settings
  // said. With the fix, the caller's threshold (0.55 FG,
  // 0.65 BG by default; user-configurable in Settings) is
  // passed to the native detector, which the v3.2.30
  // Kotlin-side fix now actually reads (previously the
  // listening loop ignored the threshold field and just
  // hardcoded 0.5f).
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
      // v3.10.4: prefer the trained wake phrase from
      // the active set (the manager's source of truth)
      // over `cyberclaw-audio-settings.wakeWord`. The
      // audio-settings key is correct MOST of the time
      // (the trainer / manager write it on every wake
      // update), but if it's stale — e.g. the user
      // toggled BG listening on BEFORE training their
      // first wake phrase, or the key was wiped by a
      // test path that bypassed the v3.10.1 sync — the
      // BG service would fall back to the
      // 'hey clawsuu' default and false-trigger on
      // any Vosk partial containing 'hey'. The active
      // set is the actual bound phrase the OWW
      // detector is using; passing it through keeps
      // BG service in lockstep with the foreground
      // detector.
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
  // v3.10.132: pre-read base64 of the file. Read at picker
  // time so the send path doesn't have an async race or
  // silent failure. Optional — if the read at picker time
  // failed, the send path will retry from `uri`.
  data?: string;
  size?: number;
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
  // v3.10.177.1: error-only diagnostic metadata attached
  // when this bubble closes a task session as 'failed'.
  // Tobe's 2026-08-28 clarification: this is ONLY for
  // errors. Successful agent replies render normally
  // without any summary footer, so the renderer only
  // needs to handle the failed branch.
  //
  // The renderer swaps the bubble's visual treatment
  // with a structured error card (category icon +
  // duration + captured steps + Retry + Copy buttons).
  // The original error text is preserved above the card
  // so no information is lost.
  //
  // Undefined on successful bubbles, user bubbles, and
  // any chat bubble that didn't close a task session.
  taskSummary?: {
    status: 'failed';
    durationMs: number;
    stepCount: number;
    // Distinct labels in chronological order. Use
    // these for the steps list in the renderer.
    steps: string[];
    // Error category classified by pattern-match on
    // the desktop's "Error: <text>" wire format.
    errorCategory: 'timeout' | 'crash' | 'network' | 'error';
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
// v3.10.123: reduced from 0.68×w (cap 320) to 0.61×w
// (cap 290). Tobe's 2026-08-01 15:22 follow-up: "lets
// reduce the Height a bit but keep same gap to
// settings. By perhaps 10% such that we lift the chat
// Height to replace. Chat needs to be taller while
// arena smaller." ~10% reduction. Cap at 290 keeps
// it from getting too small on wider phones. The
// ~30dp savings goes to the chat list (more
// messages visible above the input row).
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

// v3.10.177: per-turn task session tracking. While the
// agent is "thinking" (typing:true from the desktop), we
// capture every log entry into a `taskSession`. When the
// reply arrives (or an error bubble arrives), we close
// the session and attach a summary to the resulting
// chat bubble so the user can see:
//
//   - how long the task took
//   - which mobile-side events happened during it
//     (audio sent, tools referenced in logs, errors
//     encountered before the bubble)
//   - whether the task ran to completion or hit a
//     timeout/crash
//
// Why this lives here (vs. inside HomeScreen): HomeScreen
// unmounts when the user navigates to Settings/Wake mode,
// but the agent's work continues running on the desktop.
// Module scope survives unmounts so the captured task
// session is still there when the user comes back.
//
// Captures mobile-side log entries (which include:
// typing:true, agent_tool events if any, any error
// log entries from the IPC path, and the agent reply's
// 📨 arrival log). The desktop's in-app chat pipeline
// doesn't currently broadcast per-step tool progress
// (only Discord-routed sessions do, and those are
// suppressed per v3.2.25). When the desktop wires
// `task_progress` events for in-app pipelines in the
// future, the same log capture picks them up with no code
// change here.
//
// Pattern from v3.10.133 (thinkingEscalateTimerRef) and
// v3.10.120 (chatDraft module-scope) — module scope is
// the right tool for state that has to outlive a single
// HomeScreen instance.
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
  // Snapshot of the user's request at the moment we
  // opened the session, so the summary bubble can show
  // "Task: <first 60 chars>..." even after the user has
  // cleared the input or navigated away.
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
  // Map common patterns from addLogEntry call sites to
  // compact step labels. We don't try to be exhaustive —
  // anything we don't recognize just shows as its full
  // text in the steps list.
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
  // v3.10.177: when a task session is open, mirror the
  // entry into it as a step. We do it inline (vs. via a
  // wrapper function) so every call site automatically
  // participates — adding a new addLogEntry site doesn't
  // require updating a tracking list.
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

// v3.10.120: module-scoped chat draft. Persists the typed
// text across HomeScreen unmounts so navigating to Settings
// and back doesn't wipe the user's in-progress message.
// Tobe's report (2026-08-01): "when i type, then go check
// settings, my text disappears, it should be remembered."
//
// Module-scoped because HomeScreen unmounts on navigation
// (App.tsx switches screen='home' -> 'settings'), so any
// useState inside the component resets to '' on remount.
// Module scope survives unmounts. Cleared on send.
let chatDraft = '';
export function getChatDraft() { return chatDraft; }
export function setChatDraft(s: string) { chatDraft = s; }

// v3.10.122: arenaHidden persistence. Same module-scope
// pattern as chatDraft (v3.10.120) — survives HomeScreen
// unmount on Settings navigation. Default false (arena
// shown) so existing users see no change until they tap
// the hide-arena button.
let arenaHiddenPersistent = false;
export function getArenaHidden() { return arenaHiddenPersistent; }
export function setArenaHiddenPersistent(v: boolean) { arenaHiddenPersistent = v; }

type TabId = 'chat' | 'events' | 'log';

// v3.1.17: per-companion chat helper. We use this in two ways:
//   1. Append a freshly arrived message to a specific companion's
//      history (server tells us which agent it belongs to).
// v3.10.122: helper for the arenaStrip's left-side label
// (active companion's icon + name). Mirrors the desktop's
// companion-tab visual. Falls back to 🐾 emoji when the
// active agent isn't found in the agents list (e.g. boot
// race before the first agents_list broadcast lands).
function companionIconForActive(
  agents: Array<{ id: string; emoji?: string | null; icon?: string | null }>,
  activeId: string | null,
): string {
  if (!activeId) return '🐾';
  const a = (agents || []).find(x => x.id === activeId);
  return a?.emoji || a?.icon || '🐾';
}

//   2. Update the `messages` view-state when the user switches
//      companion tabs, so the FlatList re-renders.
//
// Both updates are batched into a single setMessagesByAgent call so
// the agent's array never gets out of sync with the view.
function appendAgentMessage(
  msg: ChatMessage,
  agentId: string,
  setMessagesByAgent: React.Dispatch<React.SetStateAction<Record<string, ChatMessage[]>>>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  activeAgentId: string | null,
) {
  setMessagesByAgent(prev => {
    const list = prev[agentId] || [];
    // v3.10.17: expanded dedupe. Was (ts within 2s AND
    // same text). Tobe's v3.10.16 report: voice messages
    // appeared twice in chat — once as a local add and
    // once as the desktop echo. The 2s window was too
    // tight because the desktop echo's timestamp can
    // lag the mobile-side timestamp by several seconds
    // (network + STT + IPC round-trip).
    //
    // v3.10.42 (Tobe's v3.10.38+ report): voice transcripts
    // STILL doubled despite the 30s defensive window.
    // Two distinct reasons:
    //  1. The mobile's local voice-mode add uses
    //     `text: msg.transcript` (raw transcript). The
    //     desktop's `addChatMsg('user', msg.transcript)`
    //     prepends `🎤 ` before pushing into the chat
    //     history and broadcasting the event. Result:
    //     mobile's local text (no prefix) vs the desktop
    //     echo's text (with emoji prefix) — they differ
    //     by exactly the prefix chars. Strict equality
    //     misses.
    //  2. Old sessions linger across desktop restarts.
    //     The mobile's cyberclaw-chat-byagent cache
    //     survives app restarts and includes old user
    //     messages. The desktop's chatHistoryByAgent is
    //     empty after restart, but agent_history requests
    //     read the persisted localStorage history (which
    //     has both the old messages with `ts = yesterday`
    //     AND recent messages). A message with yesterday's
    //     ts that now appears alongside a fresh ts from
    //     after the restart passes the 30s window
    //     because the ts diff is hours, not seconds.
    //
    // v3.10.42 fix: dedupe by NORMALIZED text. Strip
    // leading non-alphanumeric chars (emojis, "[From X]"
    // prefixes, whitespace) before comparing. Same text
    // on both sides after normalization = duplicate,
    // regardless of timestamps. Plus a 1-hour window
    // for ts-tolerant cases (cross-restart).
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
    // Stage 2: same text + same isUser + within 1h —
    // catches cross-restart cases where mobile ts
    // (yesterday) and desktop-rebroadcast ts (boot time)
    // differ by minutes.
    if (list.some(m =>
      matchingText(m) &&
      m.isUser === msg.isUser &&
      Math.abs(m.ts - msg.ts) < dupWindowMsCrossRestart
    )) {
      return prev;
    }
    // Stage 3: same normalized text within 5 minutes —
    // catches the mobile-local ↔ desktop-echo pair
    // when timestamps drift far apart (slow network, STT
    // backlog). 5 minutes is enough for the echo round-
    // trip in normal conditions; longer than that means
    // it's a fresh send, not an echo.
    //
    // v3.10.89 fix: removed the "anywhere in history"
    // version of Stage 3 that was in v3.10.42..v3.10.88.
    // Tobe reported (2026-07-23 17:54 then 18:03): "Hey"
    // sent via mobile chat didn't appear because Stage 3
    // matched the new "Hey" against an OLD cached "Hey"
    // in cyberclaw-chat-byagent and dropped it. The
    // local append returned prev (no state change), so
    // the message never appeared in the chat — even
    // though the desktop received the message, ran the
    // agent pipeline, and echoed a reply. The agent's
    // reply also matched the dedupe path so no "Hey"
    // showed up at all.
    //
    // The 5-minute window matches typical echo round-trips
    // (network + IPC + agent response). If the round-trip
    // ever exceeds 5 minutes we have bigger problems
    // (the desktop is hung). Past 5 minutes we trust
    // that any matching text is a re-send by the user,
    // not an echo.
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
    const next = { ...prev, [agentId]: [...list, msg] };
    if (agentId === activeAgentId) {
      setMessages(next[agentId]);
    }
    return next;
  });
}

// v3.1.52: added onActiveCompanionChange prop. HomeScreen reports
// the currently selected chat companion (activeChatAgentId) back to
// App.tsx so the App-level state stays in sync. This is what the
// wake mode / voice mode uses to know which companion to show.
export default function HomeScreen({ onOpenSettings, onOpenVoiceMode, onOpenQuests, onOpenSkills, onActiveCompanionChange, onAgentsChange }: { onOpenSettings: () => void; onOpenVoiceMode?: () => void; onOpenQuests?: () => void; onOpenSkills?: () => void; onActiveCompanionChange?: (id: string) => void; onAgentsChange?: (agents: Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>) => void }) {
  // v3.10.113: theme-aware container + chrome. The arena
  // (WebView) and chat messages are media content and stay
  // dark — they ship their own backgrounds via the
  // WebView's CSS — but the rest of the screen (top bar,
  // chat input, modals) follows the active theme.
  const { theme } = useTheme();
  const t = theme;
  // Build the styles from the active theme. The styles
  // object is rebuilt only when the theme changes (memo).
  const styles = useMemo(() => makeStyles(t), [t]);
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // v3.1.17: per-companion chat history. The mobile companion tab
  // bar lets the user switch between companions; each companion has
  // its own chat history on the desktop that we mirror locally.
  // `messages` above is a view of `messagesByAgent[activeChatAgentId]`.
  const [isThinking, setIsThinking] = useState(false);
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>({});
  // v3.1.17: which companion's chat is currently shown. The
  // companion tab bar updates this when the user taps a tab.
  const [activeChatAgentId, setActiveChatAgentId] = useState<string | null>(null);

  // v3.1.52: report the active chat companion back to App.tsx so
  // WakeModeScreen knows which companion to display. Fires on
  // mount (with the initial value) and every time the user taps
  // a different companion tab.
  useEffect(() => {
    if (activeChatAgentId) onActiveCompanionChange?.(activeChatAgentId);
  }, [activeChatAgentId, onActiveCompanionChange]);
  // v3.1.17: unread message count per companion, used to badge
  // companion tabs when the user is on a different one.
  const [chatUnreadByAgent, setChatUnreadByAgent] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([...syncLog]);
  // v3.10.120: inputText persists across Settings navigation
  // via module-scope `chatDraft`. Tobe's 2026-08-01 feedback:
  // "when i type, then go check settings, my text disappears,
  // it should be remembered." Initializing from chatDraft
  // restores on remount; the local setInputText wrapper keeps
  // the module-scope copy in sync so the next remount sees it.
  const [inputText, setInputTextLocal] = useState(() => getChatDraft());
  const setInputText = (s: string) => {
    setChatDraft(s);
    setInputTextLocal(s);
  };
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  // v3.10.20: fullscreen attachment viewer. When the user
  // taps an image preview in the chat, we open this modal
  // with the full-size image and a close button. Tobe's
  // v3.10.19 feedback: "images dont attach themselves to
  // the chat, such that one can Click them and look at them
  // also, like discord does".
  const [fullscreenAttachment, setFullscreenAttachment] = useState<{ uri: string; type: string; name: string; data?: string } | null>(null);

  const [connState, setConnState] = useState<string>(syncClient.state);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // v3.10.80: keyboard height tracking. v3.10.71 disabled
  // KeyboardAvoidingView on Android and relied on
  // windowSoftInputMode="adjustResize" to push the chat
  // input up. That worked on older Android, but Android 15+
  // (the app's targetSdk is 36) enforces edge-to-edge and
  // SILENTLY DISABLES adjustResize when the system bars are
  // transparent — which is forced on edge-to-edge apps.
  // Result: the chat input sits at the bottom of the
  // unresized window and the keyboard covers it
  // (Tobe reported 2026-07-23, "input field etc seems stuck
  // on the bottom now. It should be above the keyboard").
  //
  // The fix is to track the keyboard height ourselves and
  // apply it as paddingBottom on the inputContainer. This
  // works regardless of adjustResize / edge-to-edge mode
  // because we're moving the input up directly via padding,
  // not relying on the OS to resize the window.
  //
  // iOS still uses KeyboardAvoidingView with behavior=
  // 'padding' (above the KeyboardAvoidingView), so we only
  // apply the manual padding on Android.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [chatVoiceStatus, setChatVoiceStatus] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // v3.10.122: arena can be hidden to give the chat list
  // more vertical room. Tobe's 2026-08-01 13:52 follow-up:
  // "we should also add a hide arena button, perhaps in the
  // bottom middle of the arena." When true, the arena
  // collapses to a thin strip (~64dp) with the active
  // companion sprite + a "▼ Show" button to bring it back.
  // Persisted in module scope so it survives Settings
  // round-trip (mirrors the chatDraft pattern in v3.10.120).
  const [arenaHidden, setArenaHidden] = useState(getArenaHidden());
  const toggleArenaHidden = () => {
    const next = !arenaHidden;
    setArenaHidden(next);
    setArenaHiddenPersistent(next);
  };
  const [silenceCountdown, setSilenceCountdown] = useState(0);
  const [isLandscape, setIsLandscape] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string>('idle');
  const [voiceLogs, setVoiceLogs] = useState<string[]>([]);
  const [companionId, setCompanionId] = useState('boar');
  // v3.1.15: full list of agents (id, name, sprite) broadcast by the
  // desktop so the mobile arena can show all companions, not just
  // the active one. Empty array = unknown (still works in single-
  // companion fallback).
  // v3.1.18: initialise from AsyncStorage so the companion tab bar
  // shows immediately on mount, even before the desktop's
  // agents_list replay arrives. The desktop broadcast (or the
  // on-mount requestAgentsList call) refreshes the cached list
  // shortly after.
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
  const eventsRef = useRef<FlatList>(null);
  const logRef = useRef<FlatList>(null);
  // v3.1.57: only auto-scroll the log to the bottom if the
  // user is already near the bottom. If the user has scrolled
  // up to read older entries, new log entries should NOT jump
  // them to the bottom. We track the last-known content offset
  // + content size in the onScroll handler, and only call
  // scrollToEnd if the user was within ~32px of the bottom
  // when the new content was added.
  const logStickyBottomRef = useRef(true);
  const webViewRef = useRef<WebView>(null);
  // v3.1.14: chat auto-scroll state — only auto-scroll to the newest
  // message when the user is already at (or near) the bottom of the
  // chat. When they've scrolled up to read history, leave them there
  // and show a "↓ new messages" badge so they can jump back down.
  const [chatAtBottom, setChatAtBottom] = useState(true);
  // v3.8.6: mirror `chatAtBottom` into a ref so the
  // FlatList's `onContentSizeChange` handler can read the
  // latest value without a stale closure. The previous
  // version captured `chatAtBottom` directly inside the
  // inline arrow; on a race between onScroll (which
  // updates chatAtBottom) and a new message arriving (which
  // triggers onContentSizeChange), the handler would see
  // the stale "true" value and scroll even though the user
  // had actually scrolled up. The inverse race was the
  // one Tobe hit: onScroll set chatAtBottom to false
  // before our scrollToEnd had a chance to land.
  const chatAtBottomRef = useRef(true);
  useEffect(() => { chatAtBottomRef.current = chatAtBottom; }, [chatAtBottom]);
  // v3.10.111: tracks whether the chat FlatList has ever been
  // laid out, so onLayout's "force scroll to bottom" only runs
  // on the FIRST layout (initial mount when the chat tab opens
  // for the first time, or after a hard remount). Subsequent
  // layouts (font scale change, keyboard show/hide, rotation,
  // companion re-render) leave the user's scroll position alone
  // instead of yanking them back to the latest message.
  // Resets only when the component unmounts (the ref's lifecycle
  // is tied to the FlatList's tree position via the ref hook).
  const chatLayoutSeenRef = useRef(false);
  // v3.10.126: persisted scroll position per agent. The chat
  // is a FlatList with `inverted={false}` (newest at the
  // bottom). When the user navigates away from Home and
  // back, the FlatList re-mounts and would lose its scroll
  // position. Tobe's 2026-08-02 17:28 report: "each time
  // home screen comes the chat Auto scrolls to the bottom,
  // but why does it even start at the top. Cant it just
  // stay where it got left?"
  //
  // We persist the scroll offset to AsyncStorage keyed by
  // agentId (so each companion's chat remembers its own
  // scroll position), and restore on first layout of the
  // FlatList. If the user was at the bottom when they left,
  // the auto-scroll-to-end behavior handles the restore (no
  // change). If they were scrolled up, we restore the exact
  // offset so they land where they left off.
  const [chatScrollOffsetByAgent, setChatScrollOffsetByAgent] = useState<Record<string, number>>({});
  // v3.10.126: ref mirror so the debounced write can read the
  // latest offset without a stale-closure. Updated by the
  // scroll handler at every onScroll event.
  const chatScrollOffsetRef = useRef<Record<string, number>>({});
  // v3.10.126: which agent's offset to restore on first layout.
  // Captured at mount so a mid-flight agent switch doesn't
  // restore the wrong offset.
  const chatRestoreAgentRef = useRef<string | null>(null);
  const chatRestoreOffsetRef = useRef<number | null>(null);
  // v3.10.178: gate the onLayout scroll-restore until the
  // AsyncStorage hydrate of `cyberclaw-chat-scroll-byagent`
  // has completed. Without this gate, there's a race:
  //   1. FlatList mounts and `onLayout` fires.
  //   2. The async hydrate effect is still in flight;
  //      `chatRestoreOffsetRef.current` is still null.
  //   3. The onLayout handler falls into the
  //      `else { scrollToEnd() }` branch because no
  //      restoreOffset is available — yanking the user
  //      to the bottom even when they had a saved
  //      scroll-up position.
  //
  // Hydrate is fire-and-forget so we can't await it; we
  // poll the ref a few times with a short backoff before
  // giving up and falling through. Polling only happens
  // on the very first onLayout (gated by chatLayoutSeenRef)
  // so the cost is bounded to a single mount.
  const chatHydrateDoneRef = useRef(false);
  // v3.10.126: debounce timer for the scroll-offset write.
  // Null = no write pending. Set when a scroll fires; the
  // timer fires once and writes the latest offset to
  // AsyncStorage. This keeps fast swipe gestures from
  // writing to storage on every frame.
  const chatScrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const fullscreenRef = useRef(false);
  // v3.10.70: mirror of activeTab so the chat-event
  // handler can check whether the chat tab is the
  // currently visible tab without a stale-closure
  // bug. Used to decide whether to fire a system
  // notification for a companion reply.
  const activeTabRef = useRef<TabId>('chat');
  const isWakeWordStoppedRef = useRef<boolean>(true);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false); // true while recording/transcribing in wake mode
  // v3.1.17: stable refs that mirror the per-companion state so the
  // sync-event handlers (defined inside the main useEffect) can
  // read the latest values without a stale-closure bug.
  const activeChatAgentIdRef = useRef<string | null>(null);
  const messagesByAgentRef = useRef<Record<string, ChatMessage[]>>({});
  // v3.10.103: forward-declared ref to sendMessage so the
  // recent-pills long-press handler (defined inline in the
  // JSX) can call the latest sendMessage without re-rendering
  // the JSX tree. The ref is set inside sendMessage's
  // useCallback body on every render.
  const sendMessageRef = useRef<(() => Promise<void>) | null>(null);
  // v3.1.16: same trick for the agents list so onTyping and
  // other handlers can read the latest names without a stale
  // closure over the `agents` state.
  const agentsRef = useRef<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null; icon?: string | null; iconFile?: string | null; iconDataUri?: string | null }>>([]);
  // v3.1.59: report the latest agents list to App.tsx so
  // WakeModeScreen (which mounts a fresh WebView) can call
  // setAgents with the same data. Without this, the wake
  // mode WebView has no companions in its array and the
  // companion is missing from wake mode. Use a ref so the
  // useEffect can read the latest value without re-running
  // on every state change.
  const onAgentsChangeRef = useRef(onAgentsChange);
  onAgentsChangeRef.current = onAgentsChange;
  // v3.1.27: the companion id the WebView was initialised with.
  // The WebView's source URI includes this on first mount so it
  // knows which sprite to render on first paint. After that, the
  // WebView keeps its own active companion state and is swapped
  // via `injectJavaScript('setCompanion(id)')` — the URI MUST NOT
  // change or react-native-webview will re-mount the WebView and
  // re-trigger the ping-pong. This ref captures the value used
  // on first mount so subsequent `companionId` state changes
  // don't affect the URI.
  const initialArenaCompanionRef = useRef<string | null>(null);
  if (initialArenaCompanionRef.current === null) {
    initialArenaCompanionRef.current = companionId;
  }
  // v3.1.27: set to true the first time agents_list arrives, so
  // we only inject the initial companion sprite into the WebView
  // once. Subsequent agents_list broadcasts (e.g. after a
  // settings change) don't re-swap the active sprite, since the
  // user may have clicked a different tab in the meantime.
  const initialArenaInjectedRef = useRef(false);

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // v3.1.17: keep stable refs in sync with the per-companion state
  // so the sync-event handlers in the main useEffect don't capture
  // stale values.
  useEffect(() => { activeChatAgentIdRef.current = activeChatAgentId; }, [activeChatAgentId]);
  useEffect(() => { messagesByAgentRef.current = messagesByAgent; }, [messagesByAgent]);

  // v3.10.85: snapshot of the active quest at any given moment.
  // Updated by a quests_list listener below (same broadcast
  // QuestsScreen subscribes to). Used to stamp each new chat
  // message with `activeQuestId` / `activeQuestName` at append
  // time so the chat history shows which quest (if any) was
  // active when each message was sent. `null` = no active
  // quest (the v3.10.82 default state). `undefined` =
  // quests haven't loaded yet from the desktop.
  const activeQuestRef = useRef<{ id: string; name: string } | null | undefined>(undefined);
  // v3.10.108: sticky thinking flag. Mirrors Discord's
  // server-authoritative typing indicator: once set true
  // by a `typing: true` from desktop, stays true (and
  // the React chatStatusBar keeps showing "X is
  // thinking...") until EITHER:
  //   (a) desktop sends `typing: false` (success path
  //       from sendChatMessage's finally block), OR
  //   (b) a fresh agent message lands in this chat
  //       (appendAgentMessage call clears it).
  // Replaces the previous behavior where HomeScreen
  // unmount/remount on foreground transition wiped the
  // bubble — Tobe's 2026-07-29 complaint that the
  // thinking indicator "disappears after i went into
  // another app and back again".
  const thinkingStickyRef = useRef(false);
  // v3.10.133: long-wait escalation refs.
  //   - thinkingStartedAtRef: timestamp the typing bubble went
  //     up, so we can show "still working..." / "taking longer
  //     than usual..." escalations at 30s/90s/4min. Without
  //     this, the mobile user sees the same generic
  //     "Clawsuu is thinking..." string for the whole wait and
  //     has no signal that progress is being made. Tobe
  //     2026-08-04 wanted observable progress on long waits.
  //   - thinkingEscalateTimerRef: the currently-armed escalation
  //     setTimeout. Cleared on agent-message arrival (the
  //     bubble goes away) or on a fresh typing=true (the bubble
  //     text resets and the timer re-arms).
  const thinkingStartedAtRef = useRef<number | null>(null);
  const thinkingEscalateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // v3.10.79: sync the visible `messages` view to the
  // active agent's bucket whenever activeChatAgentId
  // changes. Tobe reported on 2026-07-22 that a new
  // companion reply didn't appear in the chat until he
  // manually clicked the red badge on the companion tab,
  // even though his UI showed that companion tab as
  // already active. The root cause was that some
  // activeChatAgentId updates (e.g. the agents-list
  // boot path) set the active agent without going
  // through switchToAgent — leaving `messages` set to a
  // stale agent's chat. This effect guarantees they
  // stay in sync.
  //
  // We depend on `activeChatAgentId` only (NOT
  // `messagesByAgent`) to avoid the loop where adding
  // a message causes messagesByAgent to change,
  // which re-runs this effect, which calls setMessages
  // again with the same content. We use the ref to
  // read the latest bucket without subscribing.
  useEffect(() => {
    if (activeChatAgentId == null) {
      // No active agent — leave `messages` as-is, in
      // case the user is in the middle of typing and we
      // don't want to wipe the visible chat. The empty
      // case is rare (only happens before the first
      // agents list loads).
      return;
    }
    const bucket = messagesByAgentRef.current[activeChatAgentId] || [];
    setMessages(bucket);
  }, [activeChatAgentId]);

  // v3.10.126: hydrate the persisted per-agent scroll
  // offsets from AsyncStorage on mount. The map is keyed
  // by agentId so Clawsuu's chat remembers its position
  // independent of Lamasuu's. We mirror the loaded map
  // into chatScrollOffsetRef so the onScroll handler can
  // read it without re-renders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-chat-scroll-byagent');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        if (cancelled) return;
        // Sanitize: only keep finite numeric offsets.
        const cleaned: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) cleaned[k] = n;
        }
        chatScrollOffsetRef.current = cleaned;
        setChatScrollOffsetByAgent(cleaned);
        // Capture the offset for the current active agent so
        // the FlatList's onLayout handler can restore it.
        if (activeChatAgentId && cleaned[activeChatAgentId] !== undefined) {
          chatRestoreAgentRef.current = activeChatAgentId;
          chatRestoreOffsetRef.current = cleaned[activeChatAgentId];
        }
      } catch (_) { /* ignore corrupt storage */ }
      // v3.10.178: flip the hydrate gate regardless of
      // whether data was found. The onLayout handler
      // uses this to know when it's safe to make the
      // restore decision. Setting it AFTER the await
      // (instead of synchronously) ensures the FlatList's
      // synchronous `onLayout` (which can fire before
      // this useEffect's async work resolves) sees the
      // gate as `false` and waits. After this fires,
      // any subsequent polling ticks read the populated
      // `chatRestoreOffsetRef.current`.
      //
      // The AsyncStorage hydrate takes ~5-50ms on a warm
      // device; the onLayout polling backoff (in onLayout)
      // waits up to ~600ms before falling through, so we
      // have a comfortable margin.
      finally {
        if (!cancelled) chatHydrateDoneRef.current = true;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-once load; activeChatAgentId read inside is the initial value

  // v3.1.63: inject setCentered(true) when voice mode
  // (fullscreen) is entered, setCentered(false) when exited.
  // Tobe: "voice mode should have the same look as wake mode"
  // (centered companion on black bg). v3.1.62 added the
  // setCentered function to window.Arena, but the useEffect
  // that calls it was lost in the diff. Without this, voice
  // mode keeps the regular home view (forest bg, both
  // companions in default layout) instead of the wake-mode
  // look. The wake listener is NOT involved — this is purely
  // visual; voice mode keeps its VAD + recorder logic.
  //
  // v3.1.65: voice mode now uses a dedicated VoiceModeScreen
  // (same component as WakeModeScreen, voiceMode prop), so
  // the home screen's fullscreen mode is unused for voice.
// (no setCentered injection needed)

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
          // v3.1.59: propagate cached agents to App.tsx too,
          // so WakeModeScreen has the list immediately if the
          // user opens wake mode before the WebSocket delivers
          // a fresh agents_list.
          onAgentsChangeRef.current?.(parsed);
          addLogEntry(`Loaded ${parsed.length} companion(s) from local cache`, 'info');
        }
      } catch (_) {}
    }).catch(() => {});
  }, []);

  // v3.1.18: persist the agents list whenever it changes so a
  // remount (e.g. user opens Wake Mode and comes back) can
  // rebuild the tab bar from cache while waiting for the desktop
  // to send a fresh list.
  useEffect(() => {
    if (agents.length === 0) return;
    AsyncStorage.setItem('cyberclaw-agents-cache', JSON.stringify(agents)).catch(() => {});
  }, [agents]);

  // v3.10.44: derive a sleep styling flag from the active
  // agent's sleepState. Tobe's report (v3.10.43): "the
  // companions dont sleep on the phone, they should".
  // Computed at the top of the component (not in JSX) so
  // the arena conditional below can stay flat — v3.10.43
  // tried to wrap the arena block in an IIFE to compute this
  // inline, but the IIFE left the outer <View> unclosed and
  // the build broke. The flat form below is the same logic
  // without the JSX-balance risk.
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

    // v3.1.17: ask the desktop for the current agents list on every
    // mount. This rebuilds the companion tab bar when the user
    // comes back from Wake Mode (HomeScreen unmounts/remounts),
    // reconnects after a network blip, or the desktop was restarted
    // while the app was in the background. The desktop's sync server
    // caches the last agents_list and replays it.
    // v3.1.18: retry a few times in case the WebSocket isn't open
    // yet on the very first mount (the SyncClient may still be
    // connecting when this effect runs).
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

  // NOTE: Scroll handled by hasInitialScrolled effect below

  // Stop speech and cleanup when component unmounts
  useEffect(() => {
    return () => {
      try {
        if (webViewRef?.current) {
          webViewRef.current.injectJavaScript('if (window.speechSynthesis) { window.speechSynthesis.pause?.(); window.speechSynthesis.cancel?.(); } true;');
        }
      } catch (e) {
        // Silently fail - component is unmounting
      }
      try {
        isWakeWordStoppedRef.current = true;
      } catch {}
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
    // v3.10.3: kick the active companion awake on any voice-mode
    // entry. The user is about to start talking, so a sleeping
    // companion should wake up before their first utterance
    // arrives. Wrapped in try/catch — failure here just means
    // the sprite stays sleeping until the first user message
    // arrives and triggers the explicit wake in
    // sendChatMessage() on the desktop side.
    try {
      const aid = activeChatAgentIdRef.current || 'companion';
      syncClient.sendWakeAgent(aid);
    } catch (_) {}
    // For wakeword, route to the dedicated WakeModeScreen — same as the
    // user tapping the Wake Mode button. The in-home "voice input"
    // fullscreen was a separate leftover UI from before Wake Mode was a
    // thing; the user expects wake word → Wake Mode → recording, all in
    // the same fullscreen, and to ALWAYS land on Wake Mode regardless of
    // what screen they were on (chat, settings, etc).
    if (source === 'wakeword') {
      // Clear the in-home fullscreen state — we're handing off to the
      // dedicated screen which manages its own UI and recording.
      if (fullscreenRef.current) {
        setFullscreen(false);
        fullscreenRef.current = false;
      }
      setIsWakeWordMode(false);
      isWakeWordModeRef.current = false;
      // v3.1.26: the per-render watcher that depended on this
      // module-level flag is gone. The AsyncStorage 'wake-pending'
      // flag is still the recovery signal for the activity-torn-
      // down case (App.tsx + HomeScreen's wakePendingCheckCounter
      // both watch it).
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

        await recorder.start(recPath, 5000); // 5s silence timeout
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
      // v3.1.12: openArenaSettings is a no-op now. The mobile is just an
      // extension of the desktop, which owns arena background / companion
      // show/hide. If a stale WebView still sends this, ignore gracefully
      // so we don't crash on undefined onOpenArenaSettings.
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
        // v3.1.65: route to the dedicated VoiceModeScreen
        // (same component as WakeModeScreen but with the wake
        // listener replaced by the VAD + recorder). This gives
        // voice mode the same visual as wake mode (centered
        // companion on black bg) while keeping its own
        // functionality (VAD + recorder + auto-send). Tobe:
        // "wake mode looks good, just copy the style of wake
        // mode. It should look exactly the same."
        // v3.2.18: Wake Mode is gone. The arena's "Voice Mode" button
        // is the only fullscreen entry point. The `wakeword`
        // message type from the arena is also routed to voice
        // mode (kept for backwards compatibility with any saved
        // arena state).
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
        // X button in Voice Mode — Voice Mode owns its own
        // onExit handler. The arena's exitFullscreen is a no-op
        // for the dedicated screen; the wake module close button
        // goes through WakeModeScreen.onExit directly.
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
        // v3.7.6: arena Quests button (top-left, mirrors Voice
        // Mode at top-right). Routes to the GLOBAL Quests page
        // — Quests are not per-companion on the desktop, so
        // they shouldn't be per-companion on the mobile either.
        // Tobe: "the quests are still within the companion
        // settings for some reason. It should be separated."
        if (onOpenQuests) {
          addLogEntry('📜 Arena Quests → global Quests page', 'debug');
          onOpenQuests();
        } else {
          addLogEntry('📜 Arena Quests ignored — no handler', 'debug');
        }
      }
      if (msg.type === 'skills') {
        // v3.10.173: arena Skills button → global Skills page
        // (mirror of the Quests flow). Skills live on the
        // desktop's left sidebar; on the mobile they get their
        // own top-level screen so the per-companion toggle UI
        // doesn't have to share space with companion settings.
        if (onOpenSkills) {
          addLogEntry('📚 Arena Skills → global Skills page', 'debug');
          onOpenSkills();
        } else {
          addLogEntry('📚 Arena Skills ignored — no handler', 'debug');
        }
      }
      if (msg.type === 'treat_placed') {
        // v3.10.72: arena forwarded a treat_drop success.
        // Forward to desktop so the AI can react ("I just
        // gave you X. What do you think?"). Tobe's
        // screenshot in v3.10.70 had no companion reply
        // for treats because there was no path at all —
        // this is the new path.
        // v3.10.137: pass the object directly to
        // syncClient.send() — it already calls
        // JSON.stringify internally. The previous
        // syncClient.send(JSON.stringify({...})) double-
        // stringified, so the desktop's JSON.parse
        // returned the inner string, msg.type was
        // undefined, and the case dispatch silently
        // fell through. That's why no companion reaction
        // fired even though the WebView→RN handoff
        // worked correctly. Tobe 2026-08-05 12:45.
        // v3.10.138: forward the arena's `companionId`
        // (which sprite the food was dropped near) so the
        // desktop can route the chat reaction to that
        // companion specifically, instead of defaulting
        // to whichever companion's chat tab is open.
        syncClient.send({
          type: 'arena_treat_placed',
          treat: msg.treat,
          ...(msg.companionId ? { companionId: msg.companionId } : {}),
        });
      }
      if (msg.type === 'treat_eaten') {
        // v3.10.72: companion ate a treat. Forward to
        // desktop so the AI can react ("Yum, that was
        // good. Thanks!"). Mirrors the desktop's
        // promptCompanionEat(eatenType) callback that
        // fires from inside the seek-and-eat logic.
        // v3.10.137: same double-stringify fix as
        // treat_placed above.
        // v3.10.138: forward the arena's `companionId`
        // (which sprite actually ate it) so the desktop
        // routes the reaction to the right companion's
        // chat. Tobe 2026-08-06: "track which companion
        // that actually eats the food and make it
        // comment it".
        syncClient.send({
          type: 'arena_treat_eaten',
          treat: msg.treat,
          ...(msg.companionId ? { companionId: msg.companionId } : {}),
        });
      }
    } catch {}
  }, [closeFullscreen, onOpenQuests]);

  // Handle Android back button in fullscreen mode
  // v3.2.18: Wake Mode is gone. Back in Voice Mode goes
  // through the WakeModeScreen's own back handler. Home
  // Screen's fullscreen exit closes the in-home fullscreen
  // overlay (legacy, kept for parity).
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

  // Wake word → enter voice mode with lock screen
  // Wake word → hand off to the dedicated WakeModeScreen
  //
  // v3.1.26: this is now a thin wrapper. The previous version
  // toggled setIsWakeWordMode(true) + moduleLevelWakePending +
  // setFullscreen(false) before routing to onOpenWakeMode, and a
  // per-render watcher would re-apply the in-home fullscreen state
  // if React state got wiped. That caused the OLD in-home fullscreen
  // overlay (with Voice Mode / Wake Mode buttons) to flash on top of
  // the new WakeModeScreen for ~50ms whenever a wake event fired.
  //
  // The wake path now has exactly one destination — the dedicated
  // WakeModeScreen. We:
  //   1. Stop the in-home sample listener (it conflicts with the
  //      WakeModeScreen's own recorder).
  //   2. Show a toast + log so the user can confirm the event
  //      reached JS.
  //   3. Set busyRef so the sample listener's own restart-after-
  //      error path doesn't double-fire.
  //   4. Hand off to onOpenWakeMode, which switches App.tsx's screen
  //      to 'wake-mode' and unmounts HomeScreen.
  //   5. Restart the sample listener on the WakeModeScreen's
  //      teardown (not here, because we won't be around).
  //
  // The AsyncStorage 'cyberclaw-wake-pending' flag is still set
  // because the App.tsx polling effect and HomeScreen's own
  // wake-pending check both watch it as a fallback for the
  // activity-torn-down case.
  const handleWakeWord = useCallback(async (matchedCompanionId?: string) => {
    // v3.5.2: also respect the just-exited guard at the
    // listener level, not just in checkPending. v3.5.1's
    // fix only short-circuited the AsyncStorage-flag
    // path; if the OWW detector itself fires
    // owwWakeDetected shortly after voice mode closes
    // (the detector was running through voice mode and
    // may have audio frames already classified), this
    // listener would still trigger a re-open. The
    // checkPending guard alone is not enough.
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

    // Persist the wake event. This is the safety net for the
    // activity-torn-down case: App.tsx's checkPending and
    // HomeScreen's wakePendingCheckCounter both watch this flag and
    // will switch to the wake-mode screen on the next tick.
    try { await AsyncStorage.setItem('cyberclaw-wake-pending', '1'); } catch (_) {}
    setTimeout(() => { AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {}); }, 30000);

    // Route to Voice Mode (the new single fullscreen entry).
    try { onOpenVoiceMode?.(); } catch (_) {}

    // wakeWordBusyRef is cleared in WakeModeScreen's onExit handler.
  }, [onOpenVoiceMode]);

  // Check for a pending wake event from a previous mount or state wipe.
  // The wake-event handler persists a flag to AsyncStorage, and we read
  // it here. Runs on mount, on every app-state change, and on every
  // render (via the `wakePendingCheckCounter` dep, incremented every
  // 2s). This catches all three cases: re-mount, app-state change, and
  // silent state wipe while component stays mounted.
  const [wakePendingCheckCounter, setWakePendingCheckCounter] = useState(0);
  useEffect(() => {
    let consumed = false;
    const checkPending = () => {
      if (consumed) return;
      // v3.5.1: skip the check entirely if we just exited
      // voice mode within the last few seconds. The
      // AsyncStorage clear in App.tsx's onExit is async and
      // can race the getItem here; this guard closes that
      // race without needing to make the storage layer
      // synchronous. Without it, HomeScreen's first mount
      // after exit can re-open voice mode within ~300ms.
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

  // v3.1.26: the per-render watcher that re-applied setFullscreen(true)
  // during a wake event was REMOVED. It was a leftover from the old
  // architecture (v3.1.11 and earlier) where wake mode was an in-home
  // fullscreen overlay and the watcher was the safety net for state
  // wipes. In v3.1.12+ the wake path is App-level (App.tsx switches to
  // the dedicated WakeModeScreen), so re-applying setFullscreen(true)
  // here was actively breaking the new flow: it would briefly render
  // the OLD in-home fullscreen overlay (the one with Voice Mode / Wake
  // Mode buttons) before the App-level screen switch could unmount
  // HomeScreen. Wake now has exactly one destination — the
  // WakeModeScreen — and no in-home path to "restore".
  //
  // The module-level `moduleLevelWakePending` flag and the
  // `wakePendingCheckCounter` polling effect (above) are still here
  // because App.tsx's checkPending effect AND the new
  // wakePendingCheckCounter re-entry both use the AsyncStorage
  // 'cyberclaw-wake-pending' flag (the shared recovery signal) —
  // the module-level variable is dead but harmless to keep for now.

  // Load persisted chat
  //
  // v3.1.27: also load into `messagesByAgent` (per-agent) so tab
  // switching doesn't lose history. v3.1.26 (and earlier) only
  // loaded into the single `messages` view, so when the user
  // clicked a different companion tab the new tab's
  // `setMessages(messagesByAgent[a.id] || [])` would see an empty
  // slot and wipe the visible chat. The desktop restart also
  // drops the in-memory `chatHistoryByAgent`, so the mobile's
  // own copy is the only persistent record.
  //
  // The legacy `cyberclaw-chat-history` key holds the pre-
  // per-agent flat array (with `agentId` on each message). We
  // group by `agentId` and seed `messagesByAgent` from it. We
  // also save a per-agent key `cyberclaw-chat-byagent` for
  // future loads (the persist effect below writes both for
  // compatibility, but the per-agent one is the new source of
  // truth).
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
        // v3.1.16 migration: v3.1.15 stored the array in reversed
        // (newest→oldest) order for an inverted FlatList. v3.1.16
        // uses chronological order. If the stored data starts with
        // a ts that's later than the last item, it's reversed —
        // flip it back. This is non-destructive (no chat clearing)
        // and handles persisted data from any prior version.
        let ordered = filtered;
        if (filtered.length >= 2) {
          const firstTs = filtered[0].ts;
          const lastTs = filtered[filtered.length - 1].ts;
          if (firstTs > lastTs) ordered = filtered.slice().reverse();
        }
        if (cancelled) return;
        // Group by agentId. Pre-per-agent data typically has
        // `agentId = 'clawsuu'` (or undefined). Route anything
        // without an agentId to 'clawsuu' for backwards compat.
        const grouped: Record<string, ChatMessage[]> = {};
        for (const m of ordered) {
          const aid: string = m.agentId || 'clawsuu';
          if (!grouped[aid]) grouped[aid] = [];
          grouped[aid].push({
            id: m.id || `hist-${m.ts}-${Math.random()}`,
            text: m.text,
            isUser: m.isUser,
            agentId: aid,
            agentName: m.agentName,
            ts: m.ts,
          });
        }
        // v3.1.27: also seed the visible `messages` from the
        // first non-empty slot so the chat isn't blank on
        // startup. (The tab bar's onPress will switch this if
        // the user clicks a different tab.)
        setMessagesByAgent(prev => {
          // Merge: prefer the new grouped data for slots that
          // are currently empty, but don't overwrite slots
          // that already have messages (in case the user has
          // a fresh agent that arrived via agents_list while
          // we were loading the legacy cache).
          const next = { ...prev };
          for (const [aid, msgs] of Object.entries(grouped)) {
            if (!next[aid] || next[aid].length === 0) {
              next[aid] = msgs;
            }
          }
          return next;
        });
        // Show the first non-empty slot (or the active tab's
        // slot, if any) as the visible chat.
        setMessages(prev => {
          if (prev.length > 0) return prev; // already populated
          const aid = activeChatAgentIdRef.current;
          if (aid && grouped[aid]?.length) return grouped[aid];
          // otherwise the first non-empty slot
          const firstAid = Object.keys(grouped)[0];
          return firstAid ? grouped[firstAid] : prev;
        });
      } catch (e) {
        console.log('Error loading messages:', e);
      }
    };

    // v3.1.27: also load the per-agent key (the new source of
    // truth). The legacy key still works as a fallback for users
    // upgrading from v3.1.26.
    const seedFromPerAgent = async () => {
      try {
        const raw = await AsyncStorage.getItem('cyberclaw-chat-byagent');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return false;
        if (cancelled) return true;
        setMessagesByAgent(prev => {
          const next = { ...prev };
          for (const [aid, msgs] of Object.entries(parsed)) {
            if (Array.isArray(msgs) && msgs.length > 0) {
              // Replace slot with the persisted one (it's the
              // newer / more recent data).
              next[aid] = msgs.map((m: any) => ({
                id: m.id || `hist-${m.ts}-${Math.random()}`,
                text: m.text,
                isUser: !!m.isUser,
                agentId: m.agentId || aid,
                agentName: m.agentName,
                ts: m.ts,
              }));
            }
          }
          return next;
        });
        setMessages(prev => {
          if (prev.length > 0) return prev;
          const aid = activeChatAgentIdRef.current;
          if (aid && parsed[aid]?.length) return parsed[aid];
          // first non-empty slot
          for (const [aid, msgs] of Object.entries(parsed)) {
            if (Array.isArray(msgs) && msgs.length > 0) return msgs;
          }
          return prev;
        });
        return true;
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

  // v3.1.27: persist the per-agent chat cache so tab switching
  // can restore history even if the desktop is offline / has
  // been restarted. The legacy single-list persist above still
  // runs for backward compat (and the Log / archive key), but
  // this is the new source of truth for the tab-switch UX.
  // We debounce writes (every 1.5s after a messagesByAgent
  // change) so rapid incoming messages don't hammer storage.
  useEffect(() => {
    const handle = setTimeout(() => {
      // Snapshot via the ref so we always read the latest, even
      // if the effect closure was captured before the change.
      const snapshot = messagesByAgentRef.current || {};
      // Don't write empty caches (avoids wiping storage on a
      // transient empty state).
      const nonEmpty = Object.entries(snapshot).filter(
        ([, v]) => Array.isArray(v) && v.length > 0,
      );
      if (nonEmpty.length === 0) return;
      const out: Record<string, ChatMessage[]> = {};
      for (const [aid, msgs] of nonEmpty) {
        // Keep the last 200 per agent.
        out[aid] = msgs.slice(-200);
      }
      AsyncStorage.setItem('cyberclaw-chat-byagent', JSON.stringify(out))
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(handle);
  }, [messagesByAgent]);

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
      // v3.10.81: compute the keyboard's visual height
      // from `endCoordinates.screenY` rather than
      // `endCoordinates.height`. On Android 15+ with
      // edge-to-edge, `height` is the keyboard's content
      // area only and EXCLUDES the suggestion bar (~50-
      // 60dp on Gboard, ~70-80dp on Samsung Keyboard)
      // and any top decoration. `screenY` is the Y
      // position of the keyboard's actual top edge in
      // screen coordinates, so `screen_height - screenY`
      // gives the true visible height including the
      // suggestion bar. Tobe hit this on v3.10.80
      // (2026-07-23): the input row sat right at the
      // top of the keys area, with the suggestion bar
      // covering its bottom edge.
      //
      // Fall back to `endCoordinates.height` if screenY
      // is missing (older RN versions / iOS). Use
      // `Dimensions.get('screen').height` (full physical
      // screen) rather than `Dimensions.get('window').height`
      // because the window may be resized by adjustResize
      // (in case it ever starts working again on some
      // devices) and we want the full-screen reference.
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

      // v3.1.36: de-spam. AppState 'change' can fire MANY times in
      // a row (e.g. when the keyboard opens/closes, when the
      // WebView mounts, or just on Android lifecycle churn), and
      // each fire used to (a) re-apply the sample listener
      // setup and (b) log 'App foregrounded / backgrounded'.
      // Both are wasteful when nothing material changed. Skip the
      // no-op transition entirely, and rate-limit any actual
      // transition to at most once per 1.5s so a quick back-and-
      // forth (e.g. transient inactive states) doesn't double-log.
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
        // v3.10.108: re-apply the thinking-bubble state
        // when the user comes back to foreground. Tobe's
        // 2026-07-29 feedback: "the clawsuu is thinking
        // still disappears after i went into another app
        // and back again". If the desktop is still working
        // on a reply (typing active, no message yet), the
        // sticky ref re-applies the chatVoiceStatus so the
        // bubble reappears. Discord's "X is typing..."
        // indicator is the model here.
        if (thinkingStickyRef.current && !fullscreenRef.current) {
          const a = (agentsRef.current || []).find(x => x.id === activeChatAgentIdRef.current);
          const name = a?.name || 'Companion';
          // v3.10.133: pick the right "still working" label based
          // on how long the bubble has been up. Without this, a
          // foreground transition from a long wait would reset
          // the text to "is thinking..." even when we're already
          // past 30s/90s/4min into the wait — visually a
          // regression because the user just lost the
          // escalation context. Use the same 30s/90s/4min
          // thresholds as the onTyping escalation.
          const elapsed = thinkingStartedAtRef.current ? (Date.now() - thinkingStartedAtRef.current) : 0;
          let label = 'is thinking...';
          if (elapsed >= 240000) label = 'is taking very long (model may retry in the background)...';
          else if (elapsed >= 90000) label = 'is taking longer than usual...';
          else if (elapsed >= 30000) label = 'is still working...';
          setChatVoiceStatus(`${name} ${label}`);
          setIsThinking(true);
          setArenaThinking(true);
          // Re-arm the next escalation if we just transitioned
          // to a new tier (e.g. user backgrounded at 60s, came
          // back, we just rendered "is still working..." at 60s,
          // but the next tier ("taking longer than usual...") is
          // at 90s — we still have 30s on the original timer, so
          // it's fine; no new timer needed. If the original
          // timer already fired and was a no-op because
          // thinkingStickyRef was already false at that moment,
          // the next tier is now stranded. That's a
          // contradiction because we just re-applied sticky=true,
          // so the no-op couldn't have happened. Leave the
          // existing timer to fire as scheduled.).
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
            // v3.1.30: log the threshold change so the user
            // can see why a previously-stable 60% (or
            // whatever) suddenly becomes 55%. The
            // foreground threshold is intentionally lower
            // (more lenient) than the background one
            // because the phone mic is closer to the
            // user and the audio is cleaner when the app
            // is foregrounded.
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
            // v3.1.29: removed the Vosk fallback here. If
            // there's no training data, just skip — the
            // user will need to train or the foreground
            // restart will pick it up.
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
        // v3.1.29: first try the specific phrase the settings
        // ask for; if that has no training data, fall back to
        // any trained phrase (so the user doesn't lose wake
        // detection just because the settings got reset).
        // Vosk is no longer a fallback — it requires a 50MB
        // model download and the sample matcher is more
        // reliable. If neither path has data, just don't
        // start wake detection and tell the user to train.
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

    // v3.1.12: wake event listening moved to App.tsx. App-level listener
    // switches to the dedicated WakeModeScreen, which has its own
    // wake + recording + audio-response flow. HomeScreen no longer
    // handles the wake event (it would race with App.tsx).
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
        // v3.1.17: re-request the agents list on every reconnect. The
        // desktop caches and replays the last agents_list, so this
        // rebuilds the companion tab bar even if we lost connection
        // mid-session or the desktop was restarted.
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
      // v3.10.11: allow user messages through to the chat
      // history. Previously we skipped them, which meant
      // voice-message transcriptions (the desktop sends
      // these back via sync-broadcast-chat with isUser=true)
      // never appeared in the chat. Tobe reported "I saw my
      // interpreted voice message in the chat but it
      // vanished. It should stay in the chat." The
      // vanishing was because:
      //   1. Voice audio is sent via sendAudioInput (no
      //      local appendAgentMessage call)
      //   2. Desktop transcribes + calls
      //      sync-broadcast-chat with isUser=true
      //   3. Mobile receives chat event, this handler
      //      filtered it out as a duplicate-skip
      //   4. The transcript was therefore never added to
      //      the chat history at all
      //
      // Removing the skip lets voice transcriptions land
      // in the chat. The existing dedupe in
      // appendAgentMessage (ts+text within 2s) prevents
      // duplicates when the user TYPES a message — that
      // path adds locally first, then the desktop echoes
      // back, and the second append is deduped by the
      // ts+text check.
      //
      // For voice messages, the desktop's STT sometimes
      // produces a slightly different transcript than the
      // raw speech (correcting "um"s, fixing grammar),
      // so the ts+text match might miss. But the user
      // has no local copy for voice messages (we never
      // added one), so a missed dedupe just means the
      // transcription is the only entry — no duplicate.
      const aid: string = msg.agentId || activeChatAgentIdRef.current || 'companion';
      // v3.10.85: stamp the message with which quest was
      // active when it landed. The desktop echo can lag
      // the mobile's local copy by a few seconds (network
      // + STT + IPC round-trip), so the snapshot taken at
      // append time may differ from what's active now —
      // that's correct, it reflects the state at the time
      // the user/agent actually exchanged the message.
      const aq = activeQuestRef.current;
      const incoming: ChatMessage = {
        id: `${msg.ts || Date.now()}-${Math.random()}`,
        text: msg.text,
        isUser: !!msg.isUser,
        agentId: aid,
        agentName: msg.agentName,
        ts: msg.ts || Date.now(),
        activeQuestId: aq === undefined ? undefined : (aq?.id ?? null),
        activeQuestName: aq === undefined ? undefined : (aq?.name ?? null),
      };
      appendAgentMessage(incoming, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
      // v3.10.177: classify error bubbles so the chat
      // can render a structured card with category,
      // duration, and partial-step list. The desktop
      // prefixes error bubbles with "Error:" (see
      // app.js addChatMsg('error', ...) call sites).
      // We classify into timeout / crash / network /
      // generic-error based on substring patterns in
      // the error text.
      let errorCategory: 'timeout' | 'crash' | 'network' | 'error' | null = null;
      if (!incoming.isUser && typeof incoming.text === 'string') {
        const t = incoming.text;
        if (/^Error:\s/.test(t)) {
          if (/timed?\s*out/i.test(t) || /timeout/i.test(t)) {
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
      // v3.10.177.1: close the active task session when an
      // agent reply lands. We do this BEFORE the rest of
      // the onChat handling so the captured steps are
      // frozen even if the message processing throws.
      //
      // Tobe's 2026-08-28 clarification: this is ONLY for
      // errors. So we attach `taskSummary` only when the
      // message classified as an error bubble
      // (errorCategory is set). Successful replies
      // render normally with no summary attachment.
      if (!incoming.isUser) {
        const finished = closeTaskSession(errorCategory ? 'failed' : 'done', incoming.text);
        // Attach taskSummary only when the bubble is an
        // error. The captured steps (from the Log tab
        // events during typing) let the user see what
        // the agent had already done before failing.
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
          // Mutate the bubble we just appended via the
          // messagesByAgent state for this agent.
          setMessagesByAgent(prev => {
            const list = prev[aid] || [];
            const idx = list.findIndex(m => m.id === incoming.id);
            if (idx < 0) return prev;
            const updated = [...list];
            updated[idx] = { ...updated[idx], taskSummary: summary };
            return { ...prev, [aid]: updated };
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
      // v3.10.108: any new message (user or agent) lands
      // here. If it's an agent message, the typing
      // indicator should clear — the response arrived. If
      // it's a user message echo from the desktop, the
      // sticky flag is also reset (it'll be set again on
      // the next typing:true).
      //
      // v3.10.133: same clearing now handles the new
      // long-wait escalate timer (and the started-at ref).
      // Without this, a {active:true} escalation that
      // scheduled a 30s/90s/4min setTimeout would keep
      // firing after the bubble already went away — the
      // pre-v3.10.133 mobile design relied on the bubble
      // vanishing via explicit typing=false, so any
      // active timer was cleared implicitly with the
      // bubble's render. Now that typing=false is a no-op,
      // we have to clear the timer explicitly. Same effect
      // for the started-at ref (so the next typing:true
      // restarts the clock from zero).
      if (!incoming.isUser) {
        thinkingStickyRef.current = false;
        thinkingStartedAtRef.current = null;
        if (thinkingEscalateTimerRef.current) {
          clearTimeout(thinkingEscalateTimerRef.current);
          thinkingEscalateTimerRef.current = null;
        }
        setIsThinking(false);
        setArenaThinking(false);
        setChatVoiceStatus(null);
      }
      if (aid !== activeChatAgentIdRef.current) {
        setChatUnreadByAgent(prev => ({ ...prev, [aid]: (prev[aid] || 0) + 1 }));
      }
      // v3.10.70: fire a system notification when a
      // companion replies and the user isn't actively
      // watching the chat for that companion. Skips:
      //   - User messages (isUser=true) — we don't ping
      //     ourselves
      //   - App is in foreground AND chat tab is active
      //     AND agent matches — user can already see it
      //   - Voice mode is open — the voice response is
      //     playing through the audio system, a separate
      //     notification would just clash
      //   - Wake mode is open and idle — same logic as
      //     voice mode: there's already audio
      //   - v3.10.120: replay=true (sync-server tagged
      //     this chat_message as a reconnect-replay of a
      //     cached AI reply). The user wasn't there when
      //     the reply landed; we still want the chat
      //     history to fill in (handled above by the
      //     appendAgentMessage call), but a system
      //     notification would just spam the tray. Tobe
      //     reported (2026-08-01): "for some reason i get
      //     notification from earlier messages" — that
      //     was the 50-message rolling-buffer replay
      //     firing one notification per cached reply on
      //     reconnect.
      const isOwnReply = !msg.isUser;
      if (isOwnReply && !msg.replay) {
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

          // Desktop sends audio_response (synthesized WAV) - onAudioResponse plays it
          // and will call restartWakeListening via audioPlayerFinished event.
          // Don't call speak() here - it would conflict with startPlayer().
          // Fallback: if audio_response never arrives, restart after estimated duration.
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
      setChatVoiceStatus(null); // clear status when response arrives
      // v3.1.17: incoming message already appended to messagesByAgent[aid]
      // and (if active) `messages` at the top of onChat. The legacy
      // duplicate-detection log entry still helps when debugging the
      // sync layer.
      addLogEntry(`📨 Chat updated, total: ${(messagesByAgentRef.current[aid] || []).length + 1}`, 'received');
      // audio_response from desktop handles spoken replies
    };

    const onTyping = (msg: any) => {
      setIsThinking(!!msg.active);
      setArenaThinking(!!msg.active);
      // v3.10.177: when typing starts (and a session
      // isn't already open), open one. This catches
      // voice-mode paths and any future path that
      // doesn't go through the typed-send button.
      // The sendMessage() call site also opens a
      // session; opening twice is fine — the second
      // start is a no-op when a session is already
      // open.
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
        // v3.10.133: stamp the moment the indicator went up so
        // the long-wait escalation (below) can flip the text to
        // "still working..." after 30s, 90s, and 4min. The
        // desktop already escalates via the typing bubble text,
        // but the mobile receives the bubble verbatim — for
        // long tasks where the desktop is wedged on a sub-task
        // (Tobe 2026-08-04: "there is a small delay or issue on
        // mobile with the clawsuu is thinking still"), the
        // mobile user sees the same generic string for the
        // whole wait. The mobile-side escalation gives them
        // observable progress.
        thinkingStartedAtRef.current = Date.now();
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
            // the desktop is still typing (sticky ref). If we
            // already cleared (agent message arrived, error
            // arrived, etc.), no-op.
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
      // v3.10.108: keep the thinking bubble sticky across
      // app foreground/background cycles. Tobe's 2026-07-29
      // feedback: "the clawsuu is thinking still disappears
      // after i went into another app and back again". What
      // was happening: the mobile's chatVoiceStatus state was
      // wiped when HomeScreen's useEffect re-ran on foreground
      // (every WebSocket reconnect), and the previous code
      // dropped the `{active:false}` message without restoring
      // the bubble — even though the desktop might still be
      // working on the reply. Discord's "X is typing..."
      // indicator is server-authoritative: once the typing
      // stream starts, the bubble stays until either an
      // explicit `typing: false` arrives OR an agent message
      // lands. We're mirroring that model: keep the bubble
      // visible until the next agent message or an explicit
      // {active:false} arrives, regardless of foreground
      // transitions.
      //
      // v3.10.133: when the desktop sends {active:false} we
      // still KEEP the bubble visible. Reasoning: the desktop
      // side sometimes clears typing slightly before the agent
      // reply round-trips through `addChatMsg('agent', ...)`,
      // OR the typing=false arrives while the reply is still
      // in flight (Tobe 2026-08-04: "It says that he is
      // thinking for about 5-10 seconds, then it takes some
      // time before the reply comes"). With strict
      // server-authoritative clearing, the bubble would vanish
      // mid-flight and the user thinks the agent died.
      //
      // New rule: typing=false is informational only. Clear
      // the bubble ONLY when a real terminal event lands:
      //   (a) an agent message arrives via onChat
      //       (appendAgentMessage path)
      //   (b) the user sends a new message (which will
      //       fire its own typing=true shortly, replacing the
      //       bubble)
      //   (c) onSendError fires (e.g. audio_input error)
      // Set a client-side sticky flag the moment we receive
      // {active:true}; clear it ONLY when a real terminal
      // event lands. {active:false} from the desktop does
      // NOT clear the sticky flag on its own.
      if (msg.active) {
        thinkingStickyRef.current = true;
        thinkingStartedAtRef.current = Date.now();
      }
      // v3.10.133: explicit {active:false} is now a no-op
      // on its own. The bubble stays until an agent message
      // or error arrives. The desktop still sends it so the
      // renderer-side 'isThinking' flag mirrors the desktop's
      // state, but the user-visible text persists. See the
      // onChat handler below for the agent-message clearing
      // path.
    };

    // v3.10.87: tool-call events from the desktop's
    // OpenClaw session tailer. When the agent runs an
    // exec/read/write/etc. tool, the desktop emits
    // `agent_tool` with a short, concise friendly name
    // (e.g. "Running command..."). We use this to show
    // a more accurate indicator than the generic
    // "thinking..." — the user sees what the agent is
    // actually doing.
    //
    // Tobe asked for "short and concise" — the desktop
    // caps each friendly text at ~25 chars. We don't
    // add a prefix like "💭" — the indicator bar is
    // already visually distinct, and a prefix makes
    // it longer than necessary.
    //
    // Falls back to "thinking..." if the desktop sends
    // an unknown tool. Clears the indicator when the
    // agent finishes (typing=false clears it).
    const onAgentTool = (msg: any) => {
      if (!msg || typeof msg.friendly !== 'string') return;
      setChatVoiceStatus(msg.friendly);
      // v3.10.177: also capture this as a task step so
      // the structured error/timeout bubble can show
      // which tools the agent ran before failing. The
      // desktop currently only emits agent_tool events
      // for Discord-routed sessions (those are
      // suppressed per v3.2.25), but if/when that
      // changes for in-app pipelines, this listener is
      // already wired up.
      appendTaskStep({ label: `tool: ${msg.friendly.substring(0, 40)}` });
    };

    const onChatHistory = (msg: any) => {
      if (Array.isArray(msg.messages) && msg.messages.length > 0) {
        addLogEntry(`← Loaded ${msg.messages.length} messages from desktop`, 'info');
        // v3.1.16: data is stored in chronological order (oldest→newest).
        // The desktop sends it that way; we keep it as-is.
        // v3.10.107: preserve attachments through the
        // history re-deserialization. Tobe's 2026-07-29
        // feedback: image previews "sometimes get into the
        // message and other times it vanishes and its only
        // the text which gets sent". The local bubble HAS
        // the attachments when the user sends the message
        // (we set them right above), but on the next
        // chat-history pull (reconnect, foreground, tab
        // switch, desktop-echo reconcile), this map wiped
        // them — so the second you backgrounded the app
        // and reopened it, every image preview vanished.
        // Forwarding the field is the minimal fix; the
        // long-term fix (desktop-side image rendering)
        // is out of scope for this release.
        const loaded = msg.messages.map((m: any) => ({
          id: `hist-${m.ts}-${Math.random()}`,
          text: m.text,
          isUser: m.isUser,
          agentId: m.agentId,
          agentName: m.agentName,
          ts: m.ts,
          attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
        }));
        // v3.1.17: route the legacy flat chat_history response to
        // the active companion. The desktop sends this on first
        // connect; the per-agent request fires afterwards for each
        // tab in the companion bar.
        const aid = activeChatAgentIdRef.current || 'companion';
        setMessagesByAgent(prev => ({ ...prev, [aid]: loaded }));
        setMessages(loaded);
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

        // v3.10.161: use the shared playCachedGreeting
        // helper for consistent audio focus + lifecycle
        // handling across all desktop-synthesized audio
        // (greeting, response, exit reply, attachment
        // viewer). Previously we inlined startPlayer
        // here AND in WakeModeScreen, both with their
        // own lifecycle quirks. Centralizing on one
        // helper means a fix in one place applies
        // everywhere.
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

            await recorder.start(recPath, 5000);
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

    // v3.1.27: the v3.1.26 version of onCompanionChange set
    // `companionId` state, which triggered the per-companionId
    // useEffect to reload the WebView. Combined with the
    // desktop echoing the companionId back, this caused a
    // reload ping-pong every 3-8 seconds (visible in the Log
    // tab as "Companion updated: hare / boar"). The v3.1.27
    // WebView doesn't need React state for its active
    // companion — it keeps its own state and handles
    // setCompanion() calls injected from the React side. The
    // `companionId` state is now ONLY used for the initial
    // query param on WebView mount (see <WebView source=
    // `?companion=${companionId}` below).

    syncClient.on('typing', onTyping);
    // v3.10.87: tool-call events (see comment on the
    // onAgentTool handler above for the design rationale).
    syncClient.on('agent_tool', onAgentTool);
    syncClient.on('chat_history', onChatHistory);
    syncClient.on('arena', onArena);
    syncClient.on('audio_response', onAudioResponse);
    // v3.2.29: cache the desktop-synthesized audio for
    // both the wake greeting AND the exit reply. These
    // come back as `audio_response` messages with
    // requestId='greeting' or requestId='exit_reply' on a
    // sibling channel; SyncClient re-emits them as
    // 'greeting_audio' and 'exit_reply_audio'. The save
    // functions write the WAV to DocumentDirectoryPath so
    // the next wake/close can play from cache without
    // waiting for a fresh synthesis round-trip.
    const onGreetingAudio = (msg: any) => {
      if (msg?.text && msg?.audio) {
        const { saveGreetingAudio } = require('../services/GreetingAudioCache');
        // v3.10.166: forward msg.voice from the desktop so
        // the cache writes to the same (phrase, voice)
        // slot the desktop synthesized against. If absent,
        // saveGreetingAudio falls back to the resolved
        // current voice (via getCurrentVoiceIdForCache).
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
      // Display transcript in UI. v3.10.17: use the
      // shared appendAgentMessage helper so the local
      // voice-add goes to BOTH messages (view) and
      // messagesByAgent (per-companion store). Without
      // this, the local add lives only in messages, and
      // the desktop echo (which appends via the same
      // helper but with the desktop's timestamp) doesn't
      // see the local entry in messagesByAgent — its
      // dedupe misses, and the user sees their message
      // twice. Tobe's v3.10.16 screenshot showed exactly
      // this: 'The windows build does not create the
      // hive_control...' appearing as two consecutive
      // user bubbles.
      //
      // Why not drop the local add entirely? Without it,
      // there's a visible delay between the user speaking
      // and the message appearing in chat (waiting for
      // the desktop echo round-trip). The local add makes
      // the UI feel instant; the dedupe just needs to be
      // coordinated across both adds.
      const aid = activeChatAgentIdRef.current || 'companion';
      const localTs = Date.now();
      // v3.10.68: match the typed-message prefix
      // behavior — voice transcripts get the same
      // `[From: <deviceName>] ` prefix so the desktop's
      // echo dedupes correctly.
      const deviceName = syncClient.getDeviceName?.() || 'Android Phone';
      // v3.10.85: stamp with which quest was active at
      // voice-send time. See the comment on the desktop-echo
      // path for the rationale (snapshot-at-append, not at
      // render — the chat history is self-documenting).
      const aq = activeQuestRef.current;
      const localUserMsg: ChatMessage = {
        id: `user-local-${localTs}-${Math.random().toString(36).slice(2, 6)}`,
        text: `[From: ${deviceName}] ${msg.transcript}`,
        isUser: true,
        agentId: aid,
        ts: localTs,
        activeQuestId: aq === undefined ? undefined : (aq?.id ?? null),
        activeQuestName: aq === undefined ? undefined : (aq?.name ?? null),
      };
      appendAgentMessage(localUserMsg, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
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

    // v3.1.17: per-agent chat history response. Fills the
    // messagesByAgent slot for the agent named in the response.
    // If that agent is the currently active chat companion, we
    // also update the visible `messages` state so the FlatList
    // shows the loaded history immediately.
    //
    // v3.1.27: if the desktop sends back an EMPTY response
    // (`loaded.length === 0`) and we already have local
    // history (from the persisted `cyberclaw-chat-byagent`
    // cache, or from previous messages), we KEEP the local
    // history. The desktop's `chatHistoryByAgent` is in-memory
    // only and gets wiped on restart, so an empty response is
    // the normal post-restart case. Replacing the local
    // history with `[]` would clear the chat. Only adopt the
    // empty response if the local slot is also empty.
    const onAgentHistory = (msg: any) => {
      if (!msg?.agentId) return;
      const aid = msg.agentId;
      // v3.10.33: defend against legacy desktop shape.
      // Until v3.2.9 the desktop's mobile-request-agent-history
      // handler sent messages in the internal
      // `chatHistoryByAgent` shape: {type, text, name, emoji,
      // ts} — which has NO `isUser` field. The mobile's
      // renderMessage guard rejects messages where
      // `typeof item.isUser !== 'boolean'`, so the whole
      // history rendered as empty <View /> bubbles. Tobe's
      // report: "the voice mode conversation is not in the
      // chat". If a desktop older than v3.2.9 returns that
      // shape (e.g. someone updates only the mobile), infer
      // isUser from `type === 'user'` and agentName from
      // `name` as a fallback. New desktops (v3.2.9+) already
      // send the normalized shape and these fallbacks are
      // no-ops.
      const loaded: ChatMessage[] = (Array.isArray(msg.messages) ? msg.messages : []).map((m: any) => ({
        id: `hist-${m.ts}-${Math.random()}`,
        text: m.text,
        isUser: typeof m.isUser === 'boolean' ? m.isUser : (m.type === 'user'),
        agentId: m.agentId || m.name || aid,
        agentName: m.agentName || m.name || null,
        ts: m.ts,
      }));
      addLogEntry(`← Loaded ${loaded.length} messages for ${aid}`, 'info');
      const localSlot = (messagesByAgentRef.current || {})[aid] || [];
      // Decide what to put in the slot. If the desktop
      // returned messages, use them (they may include the
      // latest items we don't have yet). If the desktop
      // returned an empty list, only adopt that if we don't
      // already have local history (e.g. brand new agent);
      // otherwise keep the local copy so the chat isn't
      // wiped just because the desktop restarted.
      if (loaded.length > 0) {
        setMessagesByAgent(prev => ({ ...prev, [aid]: loaded }));
        // If this is the active companion, swap the visible
        // messages to the freshly loaded history.
        if (activeChatAgentIdRef.current === aid) {
          setMessages(loaded);
        }
      } else if (localSlot.length === 0) {
        // Empty desktop response + empty local slot =
        // genuinely empty chat. Adopt the empty state.
        setMessagesByAgent(prev => ({ ...prev, [aid]: [] }));
        if (activeChatAgentIdRef.current === aid) {
          setMessages([]);
        }
      } else {
        // Desktop says empty but we have local history
        // (e.g. the desktop restarted). KEEP the local
        // copy. The user can still see their old messages.
        addLogEntry(`← Desktop history empty for ${aid}, keeping local cache (${localSlot.length} msg)`, 'info');
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
        // v3.1.28: the mobile trusts the desktop's list as the
        // source of truth. The desktop (v3.1.19) caps the
        // visibleOrder at 6 (MAX_ARENA_COMPANIONS) before
        // broadcasting, so the mobile should see at most 6
        // entries here. The v3.1.27 version had a redundant
        // mobile-side cap, but the cap belongs at the source
        // (the desktop) — mirroring it on the mobile hides
        // desktop-side bugs and means the mobile UI doesn't
        // agree with the desktop on what the limit is.
        setAgents(msg.agents);
        // v3.1.59: propagate to App.tsx so WakeModeScreen has
        // the current list when it mounts.
        onAgentsChangeRef.current?.(msg.agents);
        // v3.1.17: initialise per-companion chat slots and request
        // each companion's history from the desktop. The desktop
        // stores chatHistoryByAgent[id] and we mirror it locally so
        // switching tabs is instant on subsequent visits.
        setMessagesByAgent(prev => {
          const next = { ...prev };
          for (const a of msg.agents) {
            if (!next[a.id]) next[a.id] = [];
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
        // v3.1.31: the mobile arena.html is now a multi-companion
        // renderer. We tell it the FULL list of companions on every
        // agents_list broadcast, plus which one is active. The
        // WebView rebuilds its sprite list internally (cheaper than
        // trying to diff-and-update, and avoids the reload ping-
        // pong that the v3.1.26 per-companionId reload caused).
        //
        // We do this on EVERY agents_list arrival, not just the
        // first one — if a new companion is added on the desktop,
        // the next agents_list will include it and the WebView
        // will show it. No React state change, no WebView reload.
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
          // Persist the first agent's sprite for next app start
          // (only the sprite is used by the legacy persistence
          // path; the WebView now derives the active companion
          // from the agents_list + tab clicks).
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

    // v3.10.85: track the active quest so each new chat
    // message can be stamped with which quest (if any)
    // was active when it was sent. The desktop broadcasts
    // quests_list whenever a quest is created, edited,
    // set-active, deleted, or marked-complete. Same
    // broadcast QuestsScreen subscribes to (which keeps
    // the full list). We only need the active one.
    //
    // Why a ref (not state): this is read at message-append
    // time (inside the syncClient listeners and the user-
    // send handler). Using state would cause stale reads
    // because the listeners were registered with empty
    // deps. The ref is always current.
    const onQuestsList = (msg: any) => {
      try {
        const quests = Array.isArray(msg?.quests) ? msg.quests : [];
        const active = quests.find((q: any) => q && q.active);
        activeQuestRef.current = active && active.id
          ? { id: active.id, name: active.name || '(unnamed quest)' }
          : null;
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
      // v3.10.177: any send_error during an active task
      // session closes it as failed. We render an
      // Error: bubble in the chat (mirrors the desktop's
      // addChatMsg('error', ...) path) so the user sees
      // the failure inline with their conversation, not
      // just buried in the Log tab.
      const finished = activeTaskSession ? closeTaskSession('failed', e?.message || 'send error') : null;
      if (finished && finished.steps.length > 0) {
        const aid = activeChatAgentIdRef.current || 'companion';
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
        appendAgentMessage(errorMsg, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
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
      // v3.10.133: cancel any pending long-wait escalation
      // timer before tearing down listeners — otherwise an
      // unmount mid-wait leaves a dangling setTimeout that
      // tries to setState on an unmounted component.
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
  // v3.1.36: rate-limit the AppState 'foregrounded/backgrounded'
  // log so it doesn't spam. AppState 'change' can fire many times
  // in a row for spurious reasons (keyboard, WebView mount,
  // Android lifecycle churn) and we used to log every fire.
  // Now: log at most once per 1.5s, and skip no-op transitions.
  const lastAppStateLogRef = useRef<number>(0);

  // Add attachment
  const addAttachment = async (asset: any) => {
    const uri = asset.uri || '';
    const fileName = asset.fileName || 'attachment';
    const fileType = asset.type || 'image/jpeg';
    // v3.10.132: read the file to base64 immediately at
    // picker time. Previously the send path did
    // `fs.readFile(att.uri, 'base64')` inside a Promise
    // chain, which had multiple silent-failure modes:
    //  1. URI didn't start with `file://` or `content://`
    //     → no branch matched, attachment dropped without
    //     a single log line. Tobe 2026-08-03 07:08:
    //     'The image did not go through even tho it was
    //     attached to my message, but it did not show
    //     up in the chat.' Zero '[Attachment]' logs on
    //     the desktop side, confirming the mobile send
    //     silently dropped.
    //  2. `fs.readFile` returned an empty string → the
    //     `.then` fired with empty b64, sent an empty
    //     image, no error surfaced.
    //  3. Race between `setAttachments([])` clearing
    //     state and the async `.then` callback.
    // Reading at picker time eliminates all three. The
    // attachment gets the data inline, the bubble
    // preview can render, and the send path is just a
    // synchronous call.
    let dataBase64: string | undefined;
    let fileSize: number | undefined;
    if (uri) {
      try {
        const fs = require('react-native-fs');
        // RNFS readFile accepts both `file://` and
        // bare absolute paths. Some pickers return
        // `content://` URIs that RNFS can't read
        // directly; we strip the prefix and pass the
        // path through. (react-native-image-picker
        // v8.2.1 already copies content URIs into the
        // app cache and returns a `file://` URI, so
        // this branch is rarely hit.)
        const readPath = uri.startsWith('file://') ? uri.slice(7) : uri;
        if (uri.startsWith('content://')) {
          addLogEntry(`📎 content:// URI — relying on picker copy`, 'warn');
        }
        dataBase64 = await fs.readFile(readPath, 'base64');
        fileSize = dataBase64 ? Math.floor((dataBase64.length * 3) / 4) : 0;
        addLogEntry(`📎 Read: ${fileName} (${fileSize} bytes from ${uri.slice(0, 60)}…)`, 'info');
      } catch (e: any) {
        addLogEntry(`📎 Read failed at picker time: ${fileName}: ${e?.message ?? 'unknown'}`, 'error');
        // Don't add to the list if we can't read it —
        // attaching a broken attachment is worse UX
        // than telling the user "this image couldn't
        // be opened".
        return;
      }
    }
    if (!dataBase64) {
      addLogEntry(`📎 Skipped: ${fileName} (no data)`, 'warn');
      return;
    }
    const attachment: AttachmentItem = {
      id: Date.now().toString(),
      uri,
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

  // v3.10.131: removed the auto-paste-on-focus handler and
  // the explicit 📋 clipboard paste button. Tobe 2026-08-03
  // 06:33: 'i cant use the clipboard button, i need to select
  // from gallery not clipboard, as i have said that clipboard
  // button is useless'. The clipboard path is unreliable on
  // Android (Clipboard.getImage() returns null in many cases)
  // and not what Tobe wants. Going forward the only attachment
  // path is the `+` button → gallery picker (launchImageLibrary).
  // Camera stays available via the Alert that `+` shows.

  // Toggle Wake Mode - v3.1.12: delegate to App-level navigation so the
  // wake mode UI always renders in the dedicated WakeModeScreen (not as
  // v3.2.18: Wake Mode is gone. Voice Mode is the only
  // fullscreen. The legacy `toggleWakeWordMode` is kept as
  // a no-op shim for any code paths that still call it,
  // but it just routes to Voice Mode.
  const toggleWakeWordMode = useCallback(async () => {
    addLogEntry('🗣️ Wake Mode toggle (legacy) → Voice Mode', 'info');
    if (onOpenVoiceMode) {
      onOpenVoiceMode();
    }
  }, [onOpenVoiceMode]);

  // v3.10.36: extracted from the companion tab's onPress
  // handler so the cross-agent banner can also call it.
  // The banner shows above the chat input when another
  // agent has unread messages — tapping it switches to
  // that agent's tab, exactly the same effect as
  // tapping the tab itself.
  const switchToAgent = useCallback((aid: string) => {
    setActiveChatAgentId(aid);
    setMessages(messagesByAgent[aid] || []);
    setChatUnreadByAgent(prev => ({ ...prev, [aid]: 0 }));
    try { syncClient.requestAgentHistory(aid); } catch (_) {}
    try {
      webViewRef.current?.injectJavaScript(
        `window.Arena && window.Arena.setActive(${JSON.stringify(aid)}); true;`,
      );
    } catch (_) {}
    AsyncStorage.setItem('cyberclaw-arena-comp', aid).catch(() => {});
  }, [messagesByAgent]);

  const handleAttach = useCallback(() => {
    Alert.alert('Attach', 'Choose source', [
      { text: 'Camera', onPress: () => launchCamera({ mediaType: 'mixed', quality: 0.8 }, (res) => {
        // v3.10.132: addAttachment is async (reads base64
        // at picker time). Fire and forget; picker callbacks
        // don't surface errors anyway, the addAttachment
        // log entries are the source of truth.
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
    // v3.10.179: if the most recent agent bubble is a
    // failed taskSummary the user may not have seen
    // yet, snap back to it before sending. Tobe
    // 2026-08-30 11:56: "the bug report should be visible
    // before I send something again". We don't block the
    // send on the scroll completing — the message
    // queueing and the scroll run in parallel. This is
    // a best-effort nudge so the next typing bubble
    // doesn't push the failure card off-screen.
    try {
      const aid0 = activeChatAgentIdRef.current || 'companion';
      const list = (messagesByAgentRef.current || {})[aid0] || [];
      // Walk backwards from the end. The very last
      // bubble is the user's just-typed message
      // (it was appended above before syncClient.sendChat).
      // Walk past it; the bubble BEFORE that is the
      // agent reply the user is most likely trying to
      // follow up on. If that's a failure, snap to it.
      for (let i = list.length - 2; i >= 0; i--) {
        const m = list[i];
        // The bubble directly above the just-typed
        // user message is the agent reply they're
        // following up on. If that's a failure, snap
        // to it. If it's a non-failure agent reply
        // (success) or a user message, don't snap
        // backwards — anything older is from a
        // previous turn and the user has already
        // seen/acknowledged it.
        if (m.isUser) break;
        if (m.taskSummary && m.taskSummary.status === 'failed') {
          // Found the most recent failure. Try to
          // scroll to it. Don't await — let the send
          // continue in parallel.
          try {
            chatRef.current?.scrollToIndex({
              index: i,
              animated: true,
              viewPosition: 0.2,
            });
          } catch (_) {
            setTimeout(() => {
              try {
                chatRef.current?.scrollToIndex({
                  index: i,
                  animated: true,
                  viewPosition: 0.2,
                });
              } catch (__) { /* best-effort */ }
            }, 120);
          }
        }
        // Either way (failure or success), we've
        // identified the most recent agent reply —
        // done.
        break;
      }
    } catch (_) { /* scroll is best-effort */ }
    // v3.10.110: log every send attempt so we can see
    // when the user presses Send on an empty input.
    // Before this, an empty-tap-Send silently returned
    // via the `if (!text && attachments.length === 0)`
    // check below, with no log, no toast, no feedback.
    // Tobe's 2026-07-29 18:30 report: "I wrote in the
    // chat but no thinking indication and no response"
    // turned out to be the empty-input silent-return
    // case. Logging both entry AND skip paths here
    // gives us a paper trail in the Log tab without
    // changing visible UI.
    addLogEntry('🟢 send: pressed', 'info');
    // v3.10.103: see the sendMessageRef declaration above.
    // The ref is updated on every render so the recent-
    // pills long-press handler (defined inline in the JSX,
    // outside the useCallback closure) can call the latest
    // sendMessage without re-rendering the JSX tree.
    sendMessageRef.current = sendMessage;
    // v3.10.177: open a task session for this turn. The
    // session lives across HomeScreen unmounts (Settings,
    // Wake Mode navigation) and is closed either by the
    // agent reply landing in onChat, by an error bubble
    // landing, or by the send_error IPC. The summary
    // gets attached to the resulting bubble so the user
    // can see "what happened" in the chat itself, not
    // just in the Log tab.
    const _sendAid = activeChatAgentIdRef.current || 'companion';
    const _sendAgent = (agentsRef.current || []).find(x => x.id === _sendAid);
    startTaskSession({
      requestText: inputText.trim() || (pendingAudioPath ? '[voice message]' : '[no text]'),
      agentId: _sendAid,
      agentName: _sendAgent?.name,
    });
    // v3.10.3: kick the active companion awake on any chat
    // submit. The desktop's sendChatMessage() also auto-wakes
    // when the text arrives, but the explicit mobile-side
    // kick ensures the sleepState flips BEFORE the agent
    // starts responding (the broadcast-back happens via
    // agents_list when the renderer flips state). Without
    // this, the sleeping sprite on the phone stays
    // grayscaled for the duration of the chat round-trip.
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
      // v3.10.110: silent empty-tap-send is confusing.
      // Log the skip path so the user can see in the
      // Log tab "send: pressed" followed by "send: empty
      // input, ignored". Optionally also show a soft
      // toast — disabled for now to avoid visual noise;
      // the log is the first step; a haptic + toast
      // can land in a later release.
      addLogEntry('⬜ send: empty input, ignored', 'warn');
      return;
    }

    if (text || attachments.length > 0) {
      // v3.1.17: tag the user message with the active companion's
      // agentId so it lands in the right slot of messagesByAgent and
      // the desktop routes the response back to the same companion.
      // v3.10.20: include attachments in the local message so the
      // image preview shows up in the chat immediately (instead of
      // disappearing after send). Also wait for attachments to be
      // read as base64 BEFORE clearing them — otherwise the user
      // sees the previews vanish before they're sent.
      // v3.10.68: prefix the local user message with
      // `[From: <deviceName>] ` to match the desktop's
      // echo format (sync-server.js:320 adds the same
      // prefix on inbound `chat` messages from non-Desktop
      // clients). Without this, the local plain text and
      // the desktop-echo prefixed text look like
      // different messages to the dedupe check and both
      // land in the chat. Tobe reported this as a
      // duplicate-bubble bug.
      const aid = activeChatAgentIdRef.current || 'companion';
      const deviceName = syncClient.getDeviceName?.() || 'Android Phone';
      // v3.10.85: stamp with which quest was active at
      // typed-send time. Same snapshot-at-append pattern
      // as the desktop-echo and voice paths.
      const aq = activeQuestRef.current;
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        text: text ? `[From: ${deviceName}] ${text}` : text,
        isUser: true,
        agentId: aid,
        ts: Date.now(),
        attachments: attachments.map(a => ({ uri: a.uri, type: a.type, name: a.name, data: a.data, size: a.size })),
        activeQuestId: aq === undefined ? undefined : (aq?.id ?? null),
        activeQuestName: aq === undefined ? undefined : (aq?.name ?? null),
      };
      appendAgentMessage(userMsg, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
      if (text) {
        syncClient.sendChat(text, aid);
        addLogEntry(`→ [${aid}] ${text.substring(0, 80)}`, 'sent');
      }
    }

    for (const att of attachments) {
      // v3.10.132: send the pre-read base64 from
      // addAttachment(). The previous code did an async
      // file read here with multiple silent-failure modes
      // (no branch match for the URI scheme, empty result,
      // race with setAttachments([])). Reading at picker
      // time stores the data inline so the send path is
      // synchronous and observable.
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
  }, [inputText, isConnected, pendingAudioPath]);

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

        await recorder.start(recPath, 5000);
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

  // Auto-scroll to bottom when switching to chat tab or getting new messages
  // v3.1.14: track incoming (non-user) messages so we can surface a
// "↓ new messages" badge when the user has scrolled up to read
// history. User-sent messages don't count.
// v3.1.16: data is stored in chronological order (oldest→newest). The
// newest message is at index length-1, not 0. FlatList is NOT
// inverted — scrollToEnd jumps to the bottom of the screen.
//
// v3.8.6: read chatAtBottom via the ref (chatAtBottomRef)
// instead of the closure. The closure captures the value at
// effect-run time, but the FlatList's onScroll updates
// chatAtBottom via setState, which can race with this
// effect on the same render. The ref is updated in the
// useEffect above and is always current.
const lastMessageIdRef = useRef<string | null>(null);
useEffect(() => {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.id === lastMessageIdRef.current) return;
  const isInitial = lastMessageIdRef.current === null;
  lastMessageIdRef.current = last.id;
  if (isInitial) return; // first mount: just record, no auto-scroll/bump
  // Skip user-sent messages: the user just typed them, they know.
  if (last.isUser) {
    // ...but still scroll to the new (their) message at the bottom.
    if (chatAtBottomRef.current) {
      setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
    }
    return;
  }
  // v3.10.90: increment the unread badge whenever a new message
  // arrives — even when the user is already at the bottom. The
  // previous behaviour ("at bottom = no badge") made the
  // v3.2.23 missed-broadcast replay invisible: the replay
  // arrived while the user was at the bottom, auto-scrolled
  // them there, but they had no visual cue that messages had
  // been added. Tobe's request (2026-07-23 23:26): "do we have
  // a update function when scrolling to the bottom? A refresh
  // for new messages like function?"
  //
  // New behaviour: always increment the badge when a new
  // message arrives. At bottom: still auto-scroll + show badge
  // (badge fades after a tap or when count clears). Scrolled up:
  // same as before — stay put + show badge.
  //
  // We DO NOT auto-scroll when at bottom if the new message
  // looks like a replay (e.g. text is identical to the last
  // one). The dedupe in appendAgentMessage catches most cases,
  // but defensively skipping the scroll when the last message
  // already matches prevents nudging the chat for every
  // miss-and-recover.
  // v3.10.179: when the new (last) bubble carries a
  // failed taskSummary, force-scroll to it so the user
  // sees the diagnostic card immediately — even if they
  // were scrolled up reading history. Tobe's
  // 2026-08-30 11:56 feedback: "the bug report card
  // should be visible before I send something again".
  // Without this, a failure that arrives while the user
  // is mid-history stays out of view until they happen
  // to scroll to the bottom, by which point they may
  // have already started typing a follow-up and the
  // typing bubble pushes the error card further
  // off-screen.
  //
  // The trick: scrollToIndex needs the item to be
  // measured first. We do a small retry loop because
  // FlatList measures lazily — first attempt often
  // returns 'item-0' before measurement completes.
  // Two attempts ~80ms apart is enough on real
  // hardware; fall back to scrollToEnd if even the
  // second attempt can't find the item (very rare,
  // only if the FlatList was just mounted).
  if (!last.isUser && last.taskSummary && last.taskSummary.status === 'failed') {
    const failedIndex = messages.length - 1;
    const scrollToFailed = () => {
      try {
        chatRef.current?.scrollToIndex({
          index: failedIndex,
          animated: true,
          viewPosition: 0.2, // a bit below the top so the card is fully visible
        });
      } catch (_) {
        // scrollToIndex throws if the item isn't
        // measured yet — retry once after a short
        // delay, then fall back to scrollToEnd.
        setTimeout(() => {
          try {
            chatRef.current?.scrollToIndex({
              index: failedIndex,
              animated: true,
              viewPosition: 0.2,
            });
          } catch (__) {
            chatRef.current?.scrollToEnd({ animated: true });
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
  if (chatAtBottomRef.current) {
    setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
  }
  setChatUnreadCount(c => c + 1);
}, [messages.length]);

// v3.10.178: when the user switches to the chat tab, ONLY
// clear the unread badge — do NOT scroll to end.
// v3.1.16 / v3.10.111: used to scroll-to-bottom here for
// "open at the bottom" behaviour. That contradicted
// Tobe's 2026-08-28 ask: "the chat should just be where
// it last left off. Just like discord chat behaviour."
// Discord doesn't scroll-to-bottom on tab re-open — it
// preserves the channel's scroll position. We now do the
// same. If the user is mid-history and switches to
// Settings and back, they stay where they were.
//
// The FlatList is conditionally rendered in this screen
// (see `{activeTab === 'chat' && <FlatList ... />}` at
// line 4714). On the previous screen the FlatList
// unmounted when the user leaves the tab and a fresh
// FlatList mounts when they come back. The save-path
// (onScroll -> debounced AsyncStorage write at
// cyberclaw-chat-scroll-byagent) runs while the user
// scrolls; the restore-path (onLayout / v3.10.178
// hydrate gate) lands the user where they left off.
useEffect(() => {
  if (activeTab === 'chat') {
    setChatUnreadCount(0);
  }
}, [activeTab]);

// v3.10.91: periodic activity heartbeat while the chat
// tab is open + app is foregrounded. The desktop uses
// this to bump lastInteractionTs on the active companion
// so its auto-sleep timer (12 min default) doesn't fire
// while the user is actively engaged with the chat on
// mobile. Tobe's report (2026-07-23 23:28): "The
// companions should sleep on the mobile also like they
// do on desktop."
//
// Only fires when:
//   - Connected to the desktop
//   - activeTab === 'chat' (not Events / Log)
//   - appState === 'active' (app is foregrounded)
//
// 30s interval. Pinging more often wastes battery;
// pinging less often risks missing the 12-min auto-sleep
// window. 30s × 24 = 12 min budget — at the very edge
// but still safe.
//
// Note: ping does NOT wake a sleeping companion. It only
// RESETS the auto-sleep timer. To wake a sleeping companion
// the user must actively engage (chat / voice / treat).
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

// v3.8.6: explicit first-paint scroll to bottom. Belt-and-
// suspenders to the onLayout handler above. Fires once when
// messages first populate (e.g. when AsyncStorage hydration
// lands) and runs after a short delay so the FlatList has
// time to render its rows and measure contentSize. Without
// this, the initial scroll is at the mercy of onLayout's
// timing on a freshly-mounted FlatList — which can race
// with the chat history hydration (Tobe hit this: opened
// the app, chat was scrolled to the top of the history
// showing old messages, new "Late hour" message was below
// the fold). Once we run scrollToEnd here, we mark
// chatAtBottom true so the next incoming message will
// auto-scroll instead of bumping the unread badge.
useEffect(() => {
  if (messages.length === 0) return;
  // Only fire on the first non-empty render; we don't want
  // this re-running on every new incoming message (that's
  // the messages.length useEffect's job).
  const timer = setTimeout(() => {
    chatRef.current?.scrollToEnd({ animated: false });
    setChatAtBottom(true);
  }, 200);
  return () => clearTimeout(timer);
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [messages.length > 0]);

  const renderMessage = useCallback(({ item, index }: { item: ChatMessage; index: number }) => {
    if (!item || typeof item.text !== 'string' || !item.ts || typeof item.isUser !== 'boolean') {
      return <View />;
    }

    // v3.1.16: data is stored in chronological order (oldest→newest).
    // Show a date separator when the bucket changes from the previous
    // message (which is the one right above in the array).
    let showDateSeparator = false;
    if (index === 0 || !messages[index - 1]) {
      showDateSeparator = true;
    } else {
      const prevBucket = getDateBucket(messages[index - 1].ts);
      const currBucket = getDateBucket(item.ts);
      showDateSeparator = prevBucket !== currBucket;
    }

    // v3.10.85: quest-change separator. Shows above the
    // current message when its `activeQuestId` differs from
    // the previous message's. The label shows the quest
    // name (or "No active quest" if null) so the user can
    // see at a glance which quest was active when each
    // message was exchanged. The chat becomes self-
    // documenting: scroll back and read the conversation
    // boundaries by which quest was being worked on.
    //
    // Comparison logic:
    //   - undefined vs undefined → no separator (both legacy)
    //   - undefined vs null → no separator (legacy messages
    //     don't break the no-quest label continuity)
    //   - null vs id → separator (entering a quest)
    //   - id vs null → separator (leaving to no quest)
    //   - id1 vs id2 → separator (switching quests)
    //   - same value → no separator
    //   - undefined vs id → separator (legacy message
    //     followed by a stamped message)
    let showQuestSeparator = false;
    let questSeparatorLabel: string | null = null;
    if (index > 0 && messages[index - 1]) {
      const prevQ = messages[index - 1].activeQuestId;
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
        questSeparatorLabel = currQ == null ? 'No active quest' : `🎯 ${item.activeQuestName || '(unnamed quest)'}`;
      }
    }

    // v3.1.15: show the actual agent name (e.g. "🐾 Lamasuu") if we
    // know which agent spoke, otherwise fall back to the legacy label.
    // v3.1.15+ also reads item.agentName from the desktop payload.
    // v3.1.15: show the actual agent name (e.g. "🐾 Lamasuu") if we
    // know which agent spoke, otherwise fall back to the legacy label.
    // v3.1.15+ also reads item.agentName from the desktop payload.
    // v3.1.16: prefer a lookup against the cached `agents` list so
    // the fallback label uses the user's chosen name (customName on
    // the desktop) and emoji instead of the hard-coded 'Clawsuu'.
    // v3.1.71: always look up the agent from the cached `agents`
    // list first — `item.agentName` from the desktop is just the
    // bare name with no emoji prefix, so returning it directly
    // short-circuited the v3.1.68 emoji/icon fallback and the
    // message labels rendered without an icon. The desktop v3.1.29
    // already sends emoji + icon + iconFile + iconDataUri per
    // agent in the agents_list broadcast, so the lookup is the
    // canonical source for the rendered label.
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
          <Text style={[styles.agentLabel, item.isUser ? styles.userLabel : styles.aiLabel]}>
            {agentLabel}
          </Text>
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
              bubbles this section never renders. */}
          {item.taskSummary && !item.isUser && item.taskSummary.status === 'failed' && (
            <View style={styles.taskErrorCard}>
                <Text style={styles.taskErrorHeader}>
                  {item.taskSummary.errorCategory === 'timeout' ? '⏱️ Model timed out' :
                   item.taskSummary.errorCategory === 'crash' ? '💥 Model crashed' :
                   item.taskSummary.errorCategory === 'network' ? '🌐 Network error' :
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
                      // v3.10.177: Retry re-fires the
                      // user's previous message text
                      // (captured in the task session).
                      // We prime the input box and
                      // auto-send it after a brief
                      // delay so the user can cancel by
                      // tapping the input if they want
                      // to edit. The previous bubbles
                      // stay in the chat history so the
                      // user has full context.
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
                      // Copy a structured summary to
                      // the clipboard so the user can
                      // paste it into a bug report or
                      // share it. Uses the same clipboard
                      // helper that the rest of the app
                      // uses.
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
                        // v3.10.132: prefer a data: URI when we
                        // have the base64 inline. The `file://`
                        // path from the picker can disappear if
                        // the app's cache is cleaned, and the
                        // Image component can't load it on demand.
                        // The data URI is always available until
                        // the attachment is cleared.
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
      </View>
    );
    // v3.1.71: also depend on `agents` so the message label re-renders
    // when the agents state is hydrated from cache or refreshed by a
    // fresh `agents_list` broadcast from the desktop. Without this,
    // messages rendered with the old (stale, no-icon) agents state
    // never updated when new agent data arrived.
  }, [messages, agents]);

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

  // v3.1.27: removed the per-companionId WebView reload. The
  // old version (v3.1.26 and earlier) did
  // `setWebViewKey(k => k + 1)` on every companionId change,
  // which forced a full WebView reload. The reload triggered
  // a `companion_id` echo from the desktop (the WebView
  // announced its current companion, the desktop echoed it
  // back via the sync server, and React set the state again),
  // and the loop ran every 3-8 seconds — visible in the Log
  // tab as the "Companion updated: hare / boar" ping-pong.
  //
  // Now: tab clicks call `setArenaCompanion(id)` which
  // injects a `setCompanion(id)` call into the WebView (no
  // reload). The WebView swaps its sprite in place. The
  // desktop's echo of `companion_id` only updates a ref
  // (lastArenaCompanionFromDesktop) for diagnostic purposes
  // and does NOT trigger a reload.

  // v3.1.15: when the agents list updates, push it into the WebView so
  // the arena can render one sprite per agent. Only injects if the
  // WebView is mounted; otherwise the next onLoadEnd will pick it up
  // via the agents list sent in the prefs message.
  // v3.1.37: switched from dispatchEvent('agentsList', ...) (which
  // the WebView doesn't listen for) to calling
  // window.Arena.setAgents() directly. The old code path was a
  // no-op — the WebView only handles 'setAgents' messages, not
  // 'agentsList', so the inject was silently ignored and the user
  // saw an empty arena until the next 60s periodic sync.
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
            // v3.1.41: include APP_VERSION in the URI so Android WebView
            // doesn't serve a cached arena.html after an app upgrade. The
            // `platform=mobile` param was the only query string before, and
            // Android WebView caches file:///android_asset/ aggressively,
            // so changes to arena.html didn't show up after upgrade without
            // a clear-data or full reinstall. Adding v=APP_VERSION makes
            // each version's arena.html a distinct URL → no cache hit.
            source={{ uri: `file:///android_asset/arena.html?v=${APP_VERSION}&platform=mobile` }}
            // v3.10.43: sleeping companions render desaturated + dim.
            // The opacity 0.65 is the dim filter; combined with the
            // 💤 overlay below, this makes the sleep state visible
            // without modifying arena.html itself. `sleepOverlay` is
            // derived at the top of the component (see line ~603).
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
            onLoadEnd={() => {
              // v3.1.42: tell the WebView its actual rendered size so
              // it doesn't have to rely on window.innerWidth/Height
              // (which on Android WebView returns the full viewport,
              // not the WebView container's size — see the floating-
              // feet bug history in MEMORY.md and CHANGES_3.1.42.md).
              // We pass SCREEN_WIDTH (the full WebView width) and
              // ARENA_HEIGHT (the configured arena height). The
              // canvas inside the WebView uses these instead of
              // guessing from window.innerHeight.
              const initJs = `window.Arena && window.Arena.init(${SCREEN_WIDTH}, ${ARENA_HEIGHT}); true;`;
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
                // v3.1.15: also seed the agents list at load so the
                // arena can show all companions immediately. v3.1.37:
                // switched to window.Arena.setAgents (the dispatchEvent
                // path was a no-op — the WebView ignored 'agentsList').
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
                {(a.emoji || a.icon) ? (
                  <Text style={styles.companionTabEmoji}>{a.emoji || a.icon}</Text>
                ) : null}
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
      // v3.10.80: KeyboardAvoidingView on iOS only. The
      // v3.10.71 reasoning ("Android's adjustResize already
      // handles it natively") was correct for Android <15,
      // but the app's targetSdk is 36 — Android 15+
      // enforces edge-to-edge and silently DISABLES
      // windowSoftInputMode="adjustResize" when the system
      // bars are transparent. Result: the chat input sits at
      // the bottom of the unresized window and the keyboard
      // covers it (Tobe reported 2026-07-23, "input field
      // etc seems stuck on the bottom now. It should be
      // above the keyboard").
      //
      // The fix: track keyboard height via
      // `Keyboard.addListener('keyboardDidShow', ...)` and
      // apply it as paddingBottom on the inputContainer
      // itself (see the v3.10.80 comment at the
      // inputContainer render site). This works regardless
      // of adjustResize / edge-to-edge mode because we're
      // pushing the input up directly via padding, not
      // relying on the OS to resize the window.
      //
      // On iOS we still use KeyboardAvoidingView with
      // behavior='padding' because the iOS-native keyboard
      // avoidance path is reliable and doesn't have the
      // Android 15+ adjustResize problem.
      <KeyboardAvoidingView style={styles.tabContent} behavior='padding' enabled={Platform.OS === 'ios'}>
        {activeTab === 'chat' && (
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
                    chatRef.current?.scrollToEnd({ animated: true });
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
                    chatRef.current?.scrollToEnd({ animated: true });
                    setChatUnreadCount(0);
                  }}
                  accessibilityLabel="Jump to latest message"
                  accessibilityRole="button"
                >
                  <Text style={styles.chatJumpToBottomText}>↓</Text>
                </TouchableOpacity>
              )}
            <FlatList
              ref={chatRef}
              data={messages}
              keyExtractor={i => i.id}
              renderItem={renderMessage}
              // v3.10.123: footer-height estimate 56 → 44
              // to match the slimmer input row (paddingVertical
              // 8→4 + paddingBottom-closed 8+insets→insets =
              // ~12dp shorter). The 4dp breathing room + insets.
              // bottom stay the same. Net: chat list gains
              // ~12dp of room.
              //
              // v3.10.125: revert the v3.10.124 keyboardHeight
              // addition. The v3.10.124 patch was a band-aid
              // that grew contentSize by keyboardHeight when
              // the keyboard opened, which fired
              // onContentSizeChange → scrollToEnd → the user
              // ended up at the new padded bottom. That
              // created a "rubber-band at fake bottom" feel
              // — the user could see the last message above
              // the input but the FlatList had blank
              // paddingBottom below it, so scrolling further
              // down snapped back. Tobe hit this on 2026-08-02
              // 16:46: "when Im almost at the bottom and i
              // try to scroll further down it takes me back
              // where I started."
              //
              // The real fix (in v3.10.125) is to make
              // footerOverlay flex-flow instead of
              // position:absolute, so the FlatList flex-shrinks
              // when the keyboard opens (because the
              // footerOverlay's input grows by keyboardHeight
              // via paddingBottom). No paddingBottom trick on
              // the FlatList needed — the FlatList's visible
              // area now stops at the input's top edge, no
              // matter where the input is on screen.
              contentContainerStyle={[styles.chatList, {
                paddingBottom: 4 + 44 + insets.bottom,
              }]}
              showsVerticalScrollIndicator={true}
              scrollEnabled={true}
              // v3.1.16: simple chronological FlatList (not inverted).
              // Newest message lives at the end of the array and the
              // end of the screen, where the user reads it. We use
              // scrollToEnd to jump there.
              inverted={false}
              onScroll={(e) => {
                // v3.10.126: capture the current scroll offset for
                // persistence. We update the ref mirror on every
                // scroll event (cheap — just an object write) and
                // schedule a debounced AsyncStorage write so we
                // don't thrash storage on rapid scroll gestures.
                const aid = activeChatAgentIdRef.current;
                if (aid) {
                  chatScrollOffsetRef.current = {
                    ...chatScrollOffsetRef.current,
                    [aid]: e.nativeEvent.contentOffset.y,
                  };
                  // v3.10.126: schedule debounced write. Only
                  // write if no write is pending — the pending
                  // timer is keyed in a module-level ref so a
                  // fast flurry of scrolls coalesces into one
                  // write. 250ms feels instant to the user but
                  // skips writes during a swipe gesture.
                  if (!chatScrollSaveTimerRef.current) {
                    chatScrollSaveTimerRef.current = setTimeout(() => {
                      chatScrollSaveTimerRef.current = null;
                      AsyncStorage.setItem(
                        'cyberclaw-chat-scroll-byagent',
                        JSON.stringify(chatScrollOffsetRef.current),
                      ).catch(() => { /* swallow — best-effort */ });
                    }, 250);
                  }
                }
                // Without inversion, "at the bottom" means near the
                // end of contentSize.height (within a small threshold
                // of layoutHeight).
                // v3.10.111: 32px → 50px to better match Discord's
                // "near bottom" feel — small phone screens have
                // denser scroll budgets and 32px felt twitchy.
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                const isAtBottom = distanceFromEnd < 50;
                setChatAtBottom(isAtBottom);
                // v3.10.96: clear the "↓ N new messages" badge
                // when the user scrolls to the bottom of the
                // chat. Tobe's v3.10.90/v3.10.95 feedback: the
                // badge persisted even after the user manually
                // scrolled to the bottom, requiring a tap on
                // the badge to clear it. v3.10.90 introduced
                // the "always show" rule so missed-broadcast
                // replays were visible — but it lost the
                // implicit "scrolled to bottom = caught up"
                // semantic. The fix: the badge is "you have
                // not yet seen these new messages". The moment
                // the user is at the bottom of the chat, they
                // have seen them. The onContentSizeChange
                // handler's auto-scroll already moves them
                // there for new incoming messages, so this
                // clear is consistent with the auto-scroll
                // behavior.
                if (isAtBottom) {
                  setChatUnreadCount(0);
                  // v3.10.96 (Tobe's v3.10.95 feedback
                  // second part): also clear the
                  // per-companion tab badge for the
                  // active agent. The tab badge (the
                  // "9" red circle on the Clawsuu tab)
                  // is `chatUnreadByAgent[activeAgent]`
                  // and was persisting even after the
                  // user scrolled to the bottom of the
                  // chat. The agent_history callback
                  // clears it on tab switch, but if the
                  // history response is slow or fails
                  // the badge lingers. Treating
                  // "scrolled to bottom" as
                  // "caught up" clears both badges
                  // with the same gesture.
                  const aid = activeChatAgentIdRef.current;
                  if (aid) {
                    setChatUnreadByAgent(prev => {
                      if ((prev[aid] || 0) === 0) return prev;
                      return { ...prev, [aid]: 0 };
                    });
                  }
                }
              }}
              onContentSizeChange={() => {
                // Auto-scroll to the newest on first render and whenever
                // the user is already at the bottom when new content
                // arrives.
                if (chatAtBottomRef.current) {
                  chatRef.current?.scrollToEnd({ animated: false });
                }
              }}
              onLayout={() => {
                // v3.8.6: robust initial-scroll. The previous
                // version did a single setTimeout(150) and relied
                // on chatAtBottom already being true. The race
                // was: onScroll fires with distanceFromEnd huge
                // → chatAtBottom flips to false BEFORE the 150ms
                // timer runs → scrollToEnd's effect doesn't
                // stick. Tobe hit this on app open: a fresh chat
                // with new messages at the bottom, but the
                // FlatList landed at the top showing old
                // messages with no "↓ new messages" badge (the
                // useEffect skipped because lastMessageIdRef
                // already matched the hydrated messages).
                //
                // v3.10.111: only force-scroll-to-bottom on the
                // FIRST layout (initial mount / first time the
                // FlatList becomes visible). Tobe reported
                // (2026-07-30) that the chat "almost forcefully
                // scrolls down to the bottom" — this onLayout
                // handler was the culprit: it ran every time
                // the FlatList re-laid out (font scale change,
                // rotation, companion re-render, etc.), yanking
                // the user back to the bottom mid-read. Now
                // `chatLayoutSeenRef` guards the scroll so only
                // the FIRST onLayout does it. Subsequent layouts
                // leave the scroll position alone — Discord-
                // style "stay where you left it".
                //
                // v3.10.178: Three changes on top of v3.10.111
                // to fully match Discord's "stay where you
                // left off" behaviour:
                //
                //   1. RACE FIX. Wait for the AsyncStorage
                //      hydrate of `cyberclaw-chat-scroll-byagent`
                //      to complete before deciding whether to
                //      scroll. Previously the hydrate ran async
                //      and onLayout fired synchronously — so
                //      every cold start fell into the
                //      `else { scrollToEnd }` branch, yanking
                //      the user to the bottom even when they
                //      had a saved scroll-up position. We poll
                //      `chatHydrateDoneRef.current` with a
                //      short backoff (max ~600ms) before giving
                //      up. The cost is bounded to the first
                //      onLayout because `chatLayoutSeenRef`
                //      latches.
                //
                //   2. NO AUTO-SCROLL WHEN NO SAVED OFFSET.
                //      First-ever open (or no persisted offset
                //      because the user never scrolled) used to
                //      fall into a `scrollToEnd()` branch. Now
                //      we just leave the FlatList at its
                //      natural initial position (top). Discord
                //      does the same — it doesn't force-scroll
                //      to bottom on cold start when there's
                //      nothing to restore. The "↓ new messages"
                //      badge (line 4689) is the user's
                //      affordance to jump to the bottom if
                //      they want.
                //
                //   3. STOP ON TAB SWITCH. Removed the
                //      `useEffect on [activeTab === 'chat']`
                //      scroll-to-bottom that v3.10.111 kept
                //      "for open at the bottom". That effect
                //      fired on every tab-touch (Settings →
                //      Chat, etc.) and always scrolled to the
                //      end, contradicting the "stay where you
                //      left off" rule. Discord doesn't do this
                //      either — tab-switching leaves the
                //      channel's scroll position alone.
                if (messages.length > 0 && !chatLayoutSeenRef.current) {
                  chatLayoutSeenRef.current = true;
                  // The restore worker polls the hydrate
                  // gate and applies the scroll once we know
                  // whether the user had a saved offset.
                  // Pulled out as a closure so the polling
                  // backoff can retry it.
                  const tryRestore = () => {
                    const restoreOffset = chatRestoreOffsetRef.current;
                    if (typeof restoreOffset === 'number' && restoreOffset > 0) {
                      // The user was scrolled up last time.
                      // Restore exactly where they were.
                      chatRef.current?.scrollToOffset({ offset: restoreOffset, animated: false });
                      setTimeout(() => {
                        chatRef.current?.scrollToOffset({ offset: restoreOffset, animated: false });
                      }, 300);
                      chatRestoreOffsetRef.current = null;
                    } else {
                      // No saved offset (first ever open,
                      // or user never scrolled, or the
                      // active agent is different from the
                      // one the offset was saved under).
                      // v3.10.178: do NOT auto-scroll.
                      // Leave the FlatList at its natural
                      // initial position (top = oldest
                      // message). The "↓ new messages"
                      // badge in the footer is the
                      // user's affordance to jump to the
                      // bottom if they want.
                      //
                      // This is the Discord-equivalent
                      // default for cold starts: if you
                      // can't restore, don't pretend you
                      // know where the user wanted to be.
                    }
                  };
                  if (chatHydrateDoneRef.current) {
                    // Hydrate already done (rare on cold
                    // start, but possible if the device is
                    // blazingly fast or hydrate is cached).
                    tryRestore();
                  } else {
                    // Hydrate in flight. Poll the gate
                    // every ~75ms, max 8 attempts
                    // (~600ms total). After that we
                    // fall through to "no offset,
                    // don't scroll". Better to do
                    // nothing than to yank the user
                    // to the bottom.
                    let attempts = 0;
                    const poll = () => {
                      if (chatHydrateDoneRef.current) {
                        tryRestore();
                        return;
                      }
                      if (attempts++ >= 8) {
                        // Give up — fall through.
                        // tryRestore will see
                        // chatRestoreOffsetRef.current
                        // as null (hydrate timed out or
                        // was cancelled) and skip the
                        // auto-scroll.
                        tryRestore();
                        return;
                      }
                      setTimeout(poll, 75);
                    };
                    setTimeout(poll, 0);
                  }
                }
              }}
              ListFooterComponent={null} // Disabled: old messages mix with current session
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
              <View style={styles.chatStatusBar}>
                <Text style={styles.chatStatusText}>{chatVoiceStatus}</Text>
              </View>
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
                        // v3.10.98: tap the pending thumbnail to
                        // open the same fullscreen viewer the
                        // chat-history attachments use. Tobe's
                        // v3.10.97 feedback: "i still cannot
                        // Click the attached images to look
                        // closer before sending my message."
                        // Previously the thumb was a static
                        // <Image> with no onPress; users had
                        // to send + view the message to see
                        // the image at full size. The fullscreen
                        // viewer is already wired (setFullscreenAttachment
                        // is used for chat-history attachments);
                        // we just reuse it here.
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
                const lastMsg = (messagesByAgent[a.id] || []).slice(-1)[0];
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
            <View style={[styles.inputContainer, {
              // v3.10.80: Android keyboard avoidance. See
              // the comment at the keyboardHeight state
              // declaration for why we apply this manually
              // instead of relying on adjustResize (Android
              // 15+ disables it on edge-to-edge apps). When
              // the keyboard is open, set paddingBottom to
              // the keyboard height — this effectively pushes
              // the input row up to sit just above the
              // keyboard. When the keyboard is closed, fall
              // back to the v3.10.70 nav-bar inset handling.
              //
              // v3.10.123: closed-keyboard paddingBottom
              // dropped from 8 + insets.bottom to
              // insets.bottom. Tobe's 2026-08-01 15:22
              // follow-up: "I think there is a little more
              // room for the keyboard at the bottom, it
              // perhaps can go lower, not sure." Reading the
              // ambiguity as "the input row could sit lower
              // on the screen" — the extra 8dp of padding
              // was unused space between the input content
              // and the nav bar. Removing it lets the input
              // sit ~8dp closer to the bottom edge; the
              // chat list gains 8dp of vertical room.
              //
              // iOS keeps using KeyboardAvoidingView (the
              // wrapping component above) for keyboard
              // avoidance, so we DON'T need to add keyboard
              // height there.
              paddingBottom: Platform.OS === 'android' && keyboardHeight > 0
                ? keyboardHeight
                : insets.bottom,
            }]}>
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
        )}

        {activeTab === 'events' && (
          <FlatList
            ref={eventsRef}
            data={events}
            keyExtractor={(_, i) => `ev-${i}`}
            renderItem={({ item }) => <Text style={styles.eventLine}>{item}</Text>}
            contentContainerStyle={{ padding: 12 }}
            onContentSizeChange={() => eventsRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={<Text style={[styles.emptyChatText, { padding: 20 }]}>No events yet</Text>}
          />
        )}

        {activeTab === 'log' && (
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
                // v3.1.57: detect whether the user is at the
                // bottom. contentOffset.y is the scrolled
                // position; contentSize.height is the total
                // content height; layoutMeasurement.height is
                // the viewport. Distance from bottom =
                // contentSize - layoutMeasurement - offset.
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
                logStickyBottomRef.current = distanceFromBottom < 32;
              }}
              scrollEventThrottle={16}
              onContentSizeChange={() => {
                // v3.1.57: only auto-scroll if the user was
                // already at the bottom when new content
                // arrived. If they scrolled up to read, leave
                // them there.
                if (logStickyBottomRef.current) {
                  logRef.current?.scrollToEnd({ animated: false });
                }
              }}
              ListEmptyComponent={<Text style={[styles.emptyChatText, { padding: 20 }]}>No log entries</Text>}
            />
          </>
        )}
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
                  // v3.10.132: prefer the inline base64 data
                  // URI over the cached file path. The
                  // cached file can be cleared by Android's
                  // cache cleaner at any time, which would
                  // leave the fullscreen viewer blank.
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

// v3.10.103: short time-ago for the recent-pills row.
// Mirrors the formatTimeAgo in QuestsScreen.tsx but
// shorter ("3m ago" instead of "3 minutes ago") so it
// fits in the pill's small 9px secondary line. Caps
// at "1d ago" for anything older (the pills are short-
// term recovery, not history).
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
  // v3.10.121: skyStrip + skyStripCloud styles removed.
  // Was a decorative ~14dp pale-blue/pale-green band with a
  // white cloud silhouette rendered between the header and the
  // arena. Tobe flagged it twice (v3.10.120: "weird slider" on
  // dark mode; v3.10.121: "we dont need that cloud pill in
  // light mode either, it looks terrible"). Element is fully
  // removed from the render and the styles are now dead — left
  // in for now in case a future theme wants a different
  // decorative element between header and arena. Safe to delete
  // in a future cleanup PR.
  // v3.10.114: heavy forest green frame around the arena. Tobe's
  // spec (2026-07-30 19:16 GMT+2): "I want green and blue, especially
  // heavy around the arena and below the chat." This is the
  // border that surrounds the dark WebView (which is the arena)
  // and gives the home screen its forest depth.
  // v3.10.115: light mode uses border.strong (deep forest) instead
  // of brand.accent (orange) so the frame reads as forest, not neon.
  // Dark mode keeps brand.accent because the dark-mode arena frame
  // is meant to be a neon-accent outline on a black bg.
  arenaFrame: {
    height: ARENA_HEIGHT,
    borderWidth: 3,
    // v3.10.119: arena frame border per theme. Sun
    // (light) uses border.strong (deep blue) — a
    // sky-blue frame around the arena. Forest uses
    // border.strong (deep forest) — a forest-green
    // frame. Moon (dark) keeps the neon-accent
    // orange border — the v3.10.115 design intent
    // (neon outline on near-black). The new forest
    // theme also uses border.strong (it's not a
    // dark/light distinction anymore, just a moon
    // gets a special border).
    borderColor: t.name === 'dark' ? t.brand.accent : t.border.strong,
    borderRadius: 6,
    // v3.10.119: arena fill per theme. Sun (light) and
    // Forest both get bg.forestDark — a deep forest
    // fill that's visible while the WebView loads (the
    // WebView itself is dark, so the fill shows through
    // the brief loading gap). Moon (dark) is
    // 'transparent' so the arena dark background shows
    // through directly.
    backgroundColor: t.name === 'dark' ? 'transparent' : t.bg.forestDark,
  },
  arenaFrameFullscreen: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 100,
  },
  // v3.10.122: collapsed-arena strip. ~52dp tall bar shown
  // when arenaHidden=true (Tobe's 13:52 follow-up). Holds
  // the active companion's icon + name on the left, a
  // "▼ Show arena" button on the right. Chat list extends
  // into the freed ~260dp+ vertical space.
  //
  // v3.10.124: strip height 52 → 28 ("almost half the size").
  // Tobe's 2026-08-02 15:22 follow-up: "the hide arena can be
  // smaller. Almost half the size." The 52dp strip was
  // visually heavy and felt like the arena was still partly
  // there.
  //
  // v3.10.125: 28 → 22 ("Make it smaller." — Tobe's 16:46
  // follow-up on 2026-08-02). The 28dp strip still felt
  // chunky next to the 18-20dp tabs row. 22dp matches the
  // visual weight of a compact status row. Label and button
  // text shrunk one more step to fit comfortably.
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
  // v3.10.123: hide-arena button overlay (TOP-center of
  // the arena, per Tobe's 15:22 follow-up). Small pill
  // with "▲ Hide arena" text, dark translucent
  // background so it's readable over both the dark and
  // forest backgrounds. Was bottom:8 in v3.10.122;
  // moved to top:8 in v3.10.123.
  //
  // v3.10.125: shrink the pill itself to match the
  // slimmer arena strip aesthetic. Tobe's 16:46
  // follow-up: "the hide arena don't seem to have
  // changed size." — he was looking at this top-center
  // pill (which the v3.10.124 work didn't touch).
  // paddingVertical 6 → 3, font 11 → 10, width 104 → 88,
  // radius 14 → 10. Net: ~half the vertical footprint.
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
    // v3.10.122: 6 → 2 AND borderBottom removed. Tobe's
    // 2026-08-01 13:52 follow-up: "We can move the arena
    // even further up so close as possible to the
    // settings button so the border almost touches the
    // settings button." The arena's own top border
    // (borderWidth: 3 in arenaFrame) provides the
    // separator between header and arena — having both
    // borders was double-bordered visual noise. Padding
    // dropped to 2 to bring the arena's orange border as
    // close to the gear icon row as possible.
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
  // v3.1.17: companion tab bar (one tab per companion). Sits
  // between the system tabs and the chat content.
  // v3.1.48: companion tab bar tightened — Tobe asked for minimal
  // space between companion tabs (Clawsuu / Lamasuu / etc). Reduced
  // padding, margin, and max height.
  companionTabBar: {
    // v3.10.114: forest green to match the arena frame,
    // reading as a single 'forest zone' above the chat.
    // v3.10.115: in light mode, switch to warm brown earth
    // (bg.ground) — the tab bar sits between the arena (forest)
    // and the chat (cream/sky), so it reads as 'the ground under
    // the trees'. Border becomes earth-brown for the same reason.
    // v3.10.116: dark mode also gets the forest treatment (was
    // brand.accentDim, the dim orange) because bright orange on
    // a dark page reads as a neon ad, not a tab bar. Switching
    // to bg.forestDark (#1f3d28) keeps the home-screen dark-mode
    // aesthetic consistent (forest frame -> forest tab -> dark
    // chat) without the orange flash that Tobe flagged in
    // Discord at 2026-07-31 12:19 GMT+2.
    // v3.10.119: companion tab bar bg per theme. Each
    // theme has a distinct "ground" treatment that
    // matches its home-screen composition:
    //   - sun (light): bg.skyLight (pale blue strip —
    //     reads as "sky continuation under the arena")
    //   - forest: bg.ground (warm brown bark — reads
    //     as "ground under the tree")
    //   - moon (dark): bg.forestDark (deep forest — the
    //     v3.10.117 dark-mode forest treatment)
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
  // v3.1.16: small inline label that shows in place of the tab
  // bar while the desktop's agents list is still loading. Keeps
  // the bar's height stable so the layout doesn't jump when the
  // real tabs arrive.
  companionTabPlaceholder: {
    color: t.text.muted,
    fontSize: 12,
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  // v3.1.48: tighter companion tab — less padding, smaller margins.
  companionTab: {
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
    // v3.10.118: was rgba(247,147,26,0.18) bg + #f7931a
    // border. Tobe reported (Discord #cyber-dev
    // 2026-07-31 15:45 GMT+2) that the bright orange
    // active tab still "looks off in relation to the
    // rest" — the home screen now has forest frame +
    // forest tab bar (v3.10.114-117) and the orange
    // active state fights that palette.
    //
    // Switch to bg.forestDark bg + border.strong border
    // in BOTH light + dark mode (no `t.name === 'light'`
    // check — the contrast issue is the same in both
    // modes because the orange is on top of the
    // earth/forest tab bar bg, which is dark in both).
    // The active tab still pops (deeper green on dark
    // forest) but matches the home-screen palette
    // instead of shouting brand-accent orange.
    backgroundColor: t.bg.forestDark,
    borderColor: t.border.strong,
  },
  // v3.1.48: tighter companion tab emoji and name.
  companionTabEmoji: {
    fontSize: 12,
    marginRight: 4,
  },
  // v3.1.69: Twemoji SVG icon for the companion tab. Sized to
  // match the original chat-tab emoji cell (20x20). The SVG
  // renders crisp at any size and looks identical on every
  // device, unlike the system emoji font which varies wildly.
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
    // v3.10.118: was #f7931a (brand accent orange). Tobe
    // reported (Discord #cyber-dev 2026-07-31 15:45 GMT+2)
    // that the orange active tab "looks off in relation
    // to the rest" — the home screen is now forest-themed
    // and the orange competes with that. Switch to
    // text.primary (bright white in dark mode, deep
    // charcoal in light) so the active companion name
    // reads as "the one you're using" without shouting
    // brand-accent.
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
  // v3.10.114: chat list bg is the soft cream (matches the
    // 'chat can be more of the White' spec from Tobe). Bubbles
    // themselves are pure white with sky/forest borders so the
    // contrast is bubble -> bg, not bg -> page.
  // v3.10.119: chat list bg per theme. Sun (light)
    // and Moon (dark) use the page bg (white / near-
    // black) — the chat just sits on the page.
    // Forest uses bg.ground (warm brown) — the chat
    // becomes the "tree trunk cavity" that Tobe
    // described: "Brown in the chat area for a tree
    // trunk, and green under there again for bushes/
    // foliage." The page bg around the chat stays
    // bg.primary (forest green), so the chat looks
    // like a brown inset in a green frame.
    chatList: {
    // v3.10.121: bumped paddingBottom from 8 to ~64+insets
    // so the last chat message can scroll above the
    // floating input row. The input row is now
    // position:absolute at the bottom of
    // chatScrollContainer, so the chat list would otherwise
    // extend behind it. The paddingBottom reserves space
    // for the input + the nav-bar inset. The exact pixel
    // value is computed inline (not a style token) because
    // it depends on the live insets.bottom.
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
  // v3.10.85: quest-change separator. Centered pill with
  // a thin top/bottom border to visually mark the boundary
  // between "talking about quest A" and "talking about
  // quest B" (or "no quest"). Lighter color than the
  // dateSeparator so the date is still the primary
  // chronological landmark; quest is secondary context.
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
  // v3.10.114: white bubbles with sky/forest borders per Tobe's
  // spec ('the chat can be more of the White. Green for forest,
  // blue for sky'). User bubble: white bg, sky blue border +
  // accent. AI bubble: white bg, forest green border + accent.
  // The dark navy/old hex values are gone.
  messageBubble: { maxWidth: '85%', padding: 10, borderRadius: 12, marginBottom: 8, backgroundColor: t.bg.secondary, borderWidth: 1, borderColor: t.border.mid },
  userBubble: { alignSelf: 'flex-end', backgroundColor: t.bg.secondary, borderBottomRightRadius: 4, borderColor: t.brand.cyan, borderWidth: 1.5 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: t.bg.secondary, borderBottomLeftRadius: 4, borderColor: t.brand.accent, borderWidth: 1.5 },
  // v3.10.177: task summary footer styles. Error-only:
  //   - taskErrorCard: a structured block for error
  //     bubbles with category + duration + steps +
  //     action buttons. Visually distinct from a normal
  //     error bubble (which was just red text saying
  //     "Error: ..."); the card format makes it obvious
  //     what's actionable. Successful replies render
  //     normally without any summary footer (per
  //     Tobe's 2026-08-28 clarification).
  taskErrorCard: { marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: 'rgba(255, 80, 80, 0.08)', borderWidth: 1, borderColor: t.brand.danger },
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
  // v3.10.114: text follows the bubble border color so user
  // messages read as 'from you' (sky blue text) and AI as
  // 'from companion' (forest green text). Both on a white bg,
  // high contrast, easy to scan.
  messageText: { fontSize: 13, lineHeight: 18, color: t.text.primary },
  userText: { color: t.brand.cyanDim, fontWeight: '500' },
  aiText: { color: t.brand.accentDim, fontWeight: '500' },
  timestamp: { color: t.text.muted, fontSize: 9, marginTop: 4, textAlign: 'right' },

  // v3.10.20: attachment rendering. Inline image
  // previews (square 96px thumbnails) inside the
  // message bubble, plus a tap-to-fullscreen Modal
  // for the full-size view. Non-image attachments
  // show as a file card.
  attachmentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    gap: 6,
  },
  attachmentImageWrap: {
    // v3.10.88: bigger image preview for chat attachments
    // (Tobe's request 2026-07-23: "Click the image that i
    // have attached to inspect it like one can on discord").
    // Discord-style chat uses a larger preview with a tap-
    // to-expand affordance. Old was 96x96 (thumbnail-sized)
    // which doesn't communicate "tap me to inspect". The
    // tap-to-fullscreen modal was already wired (line 3091),
    // but the small thumbnail didn't visually invite the tap.
    // 180x180 is big enough to see detail at-a-glance but
    // small enough that 2-3 still fit in a single bubble.
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
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12,
    // v3.10.123: paddingVertical 8 → 4. Combined with
    // the paddingBottom 8→0 change in the inline override,
    // the input row is ~12dp shorter. Tobe: "there is a
    // little more room for the keyboard at the bottom,
    // it perhaps can go lower." The reduced vertical
    // padding gives the chat list 12dp of recovered
    // vertical room when the input is at rest.
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
    // v3.10.101: removed `overflow: 'hidden'` so the
    // floating ×-remove button (positioned at top: 2,
    // right: 2 with negative offsets in earlier versions)
    // isn't clipped. The rounded corners are now drawn
    // by the inner Image's borderRadius instead of the
    // container's overflow. Tobe's v3.10.98 feedback:
    // "the red remove button is clipped for the
    // attachment." (Visible in the screenshot — the X
    // was at top: -4, right: -4, outside the 60×60
    // container that had overflow:hidden.)
  },
  // v3.10.101: inner image gets its own borderRadius
  // (slightly smaller than the container's 6 so the
  // rounded corners still show). The image is also
  // padded on the top-right so the × button (now
  // positioned at top: 2, right: 2 INSIDE the
  // container) doesn't overlap the image content.
  attachmentPreviewThumbWrap: {
    width: '100%',
    height: '100%',
  },
  attachmentPreviewThumb: {
    width: '100%',
    height: '100%',
    // v3.10.101: match the container's borderRadius so
    // the image is visually clipped to the same rounded
    // shape. The container no longer has overflow:hidden
    // (so the X button can sit outside the image bounds),
    // so the image itself needs to be rounded.
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
    // v3.10.101: was top: -4, right: -4 (outside the 60×60
    // container that had overflow:hidden) which clipped the
    // button. Now positioned at top: 2, right: 2 inside the
    // container. The button is still 18×18 with a 9px
    // borderRadius, so it overlaps the image by 16px (most
    // of the button). Users see a red circle in the
    // top-right corner of the thumbnail. Tobe's v3.10.98
    // feedback: "the red remove button is clipped for the
    // attachment."
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
  // v3.10.16: different sizes for the + vs mic-icon
  // labels so each renders cleanly inside the smaller
  // 36x36 button. The + is a single ASCII char and
  // looks fine at fontSize 22; the mic/stop emoji
  // glyphs render a bit larger and look better at 18.
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
    paddingHorizontal: 16, paddingVertical: 6,
    backgroundColor: 'rgba(247,147,26,0.08)',
    borderTopWidth: 1, borderTopColor: 'rgba(247,147,26,0.15)',
  },
  chatStatusText: {
    color: 'rgba(247,147,26,0.85)', fontSize: 12, fontStyle: 'italic',
  },
  // v3.4.8: wrapper View for the chat FlatList. flex:1 so it
  // fills all space above the input row, with `position: relative`
  // so the absolutely-positioned chatScrollToBottomBtn below
  // sits at the bottom of THIS container (above the input) rather
  // than the bottom of the whole chat tab (which put it inside
  // the input row). Replaces the previous direct FlatList render.
  // v3.10.125: flex column layout. The FlatList is the first
  // flex child (flex:1) so it fills the available space;
  // the footerOverlay (status bar / attachment row / cross-
  // agent banner / input row) is the second flex child
  // taking its natural height. When the keyboard opens,
  // the inputContainer's paddingBottom grows by
  // keyboardHeight, which grows the footerOverlay's natural
  // height by keyboardHeight, which makes the FlatList
  // flex-shrink by keyboardHeight. The chat list's visible
  // area now stops at the input's top edge.
  chatScrollContainer: { flex: 1, flexDirection: 'column' },
  // v3.10.121: floating footer overlay. Wraps the chat
  // status bar + attachment previews + cross-agent
  // banner + input row. Was originally position:absolute
  // at the bottom of chatScrollContainer (v3.10.121
  // rationale: chat list extends behind the overlay to
  // gain ~50dp of vertical room; Tobe: "lets optimize
  // space more"). The paddingBottom trick on the
  // FlatList's contentContainerStyle reserved the
  // scroll-space for the overlay.
  //
  // v3.10.125: switched from position:absolute to
  // flex-flow (no absolute positioning). The v3.10.124
  // approach (add keyboardHeight to the FlatList's
  // paddingBottom when the keyboard is up on Android)
  // created a "fake bottom" the FlatList rubber-banded
  // against: the last message was visible above the
  // input, but the FlatList had keyboardHeight of blank
  // space below it, so any "scroll down past the last
  // message" gesture snapped back. Tobe's 2026-08-02
  // 16:46 report: "when Im almost at the bottom and i
  // try to scroll further down it takes me back where I
  // started, like thats the bottom while there are text
  // further down."
  //
  // Flex-flow fixes this cleanly: the inputContainer's
  // paddingBottom grows by keyboardHeight when the
  // keyboard is up (the existing v3.10.80 Android
  // edge-to-edge workaround), which grows the
  // footerOverlay's natural height by keyboardHeight,
  // which makes the FlatList above it flex-shrink by
  // keyboardHeight. The FlatList's visible area now stops
  // at the input's top edge — the last message can
  // always scroll fully above the input, no rubber-band.
  //
  // The "chat behind input" optimization from v3.10.121
  // is sacrificed (~50dp of chat space), but the
  // keyboard behavior is now correct and the trade is
  // worth it. Future improvement: bring back the
  // behind-input chat area as a separate "ghost"
  // background-only layer if the user wants the visual.
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
  // v3.10.138: persistent circular jump-to-bottom button. Pinned
  // to the lower-right of the chat list (overlays the scrollable
  // content). Only visible when !chatAtBottom (so it never gets
  // in the way of the latest message). Distinct from the unread
  // badge above: this is the always-available scroll handle, not
  // a "new messages" indicator. Lower-right placement (right: 12,
  // bottom: 12 + insets.bottom) so it doesn't collide with the
  // centered unread badge or the bottom-left companion-emoji
  // overlay.
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
  // v3.10.36: cross-companion chat banner. Shown above
  // the input row when OTHER agents have new messages
  // (unread > 0 for an agentId != activeChatAgentId). The
  // companion tab bar already shows a per-agent unread
  // badge, but the user has to LOOK at the tab bar to know
  // — they don't necessarily when their focus is on the
  // chat they're typing in. Tobe's report (v3.10.35): "I
  // noticed when receiving a new message that it did not
  // appear in the chat but clawsuu had a red sign meaning
  // he has sent a new message. Clicked that red and it
  // appeared in the chat. This should just appear in
  // the chat automatically, and it should appear an
  // update button in the chat at the bottom if we must".
  //
  // We render an inline banner above the chat input. Tapping
  // jumps to that agent's tab (same behavior as the
  // companion tab onPress — loads messages, clears unread,
  // swaps arena sprite, requests fresh history). One
  // banner per agent with unread; stacked vertically when
  // more than one. Keyboard-aware: shrinks to a single
  // line per banner so it doesn't dominate the bottom of
  // the screen.
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
