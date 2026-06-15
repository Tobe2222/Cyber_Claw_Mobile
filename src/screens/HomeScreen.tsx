/**
 * HomeScreen - CyberClaw mobile companion
 * Arena (real sprites) + Chat/Events/Log tabs + TTS + background service
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, StyleSheet,
  Platform, Keyboard, Dimensions, KeyboardAvoidingView, Alert,
  NativeModules, StatusBar, NativeEventEmitter, BackHandler, AppState,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import syncClient from '../services/SyncClient';
import { getSimpleAudioRecorder, disposeSimpleAudioRecorder } from '../services/SimpleAudioRecorder';
import { getVAD, resetVAD } from '../services/SileroVAD';  // Voice Activity Detection
import Clipboard from '@react-native-clipboard/clipboard';
import RNFS from 'react-native-fs';
import { extractAudioFeatures, matchAgainstTraining, AudioFeatures } from '../services/AudioSampleMatcher';
import { base64ToInt16Array } from '../services/AudioUtils';
import { version as APP_VERSION } from '../../package.json';
import RemoteToolHandler from '../services/RemoteToolHandler';

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
const SAMPLE_MATCH_THRESHOLD_BG = 0.65; // background default - stricter

function startSampleMatchListener(
  _phrase: string,
  trainingFeatures: AudioFeatures[],
  onDetected: () => void,
  onLog?: (msg: string) => void,
  threshold?: number,
): () => void {
  const matchThreshold = threshold ?? SAMPLE_MATCH_THRESHOLD_FG;
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('sampleAudioChunk', async (e: { wav: string }) => {
    if (stopped) return;
    try {
      const pcm16 = base64ToInt16Array(e.wav);
      if (pcm16.length < 1600) return;
      const features = extractAudioFeatures(pcm16);
      const result = await matchAgainstTraining(features, trainingFeatures, matchThreshold);
      // Only log when score is high (>45%) to reduce noise
      if (result.score > 0.45) onLog?.(`sample match: ${(result.score * 100).toFixed(0)}% (thr: ${(matchThreshold * 100).toFixed(0)}%)`);
      if (result.matched && !stopped) {
        onLog?.(`\u2705 Wake word matched! (${(result.score * 100).toFixed(0)}%)`);
        onDetected();
      }
    } catch (err: any) {
      onLog?.(`sample match error: ${err.message}`);
    }
  });
  WakeWordModule?.startSampleListening?.().catch((e: any) => {
    onLog?.(`startSampleListening failed: ${e?.message}`);
  });
  return () => {
    stopped = true;
    sub?.remove?.();
    WakeWordModule?.stopSampleListening?.().catch(() => {});
  };
}

async function startBgService() {
  try {
    const enabled = await AsyncStorage.getItem('cyberclaw-bg-listening');
    if (enabled !== 'false' && BackgroundService) {
      const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
      const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey clawsuu') : 'hey clawsuu';
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
}

interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  agentId?: string;
  agentName?: string; // v3.1.15: human-readable name from desktop (e.g. "Lamasuu")
  ts: number;
}

interface LogEntry {
  id: string;
  text: string;
  ts: number;
  type: 'info' | 'sent' | 'received' | 'error';
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ARENA_HEIGHT = Math.min(SCREEN_WIDTH * 0.52, 230);
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
export function addLogEntry(text: string, type: LogEntry['type'] = 'info') {
  const e: LogEntry = { id: `${Date.now()}-${Math.random()}`, text, ts: Date.now(), type };
  syncLog.push(e);
  if (syncLog.length > 300) syncLog.splice(0, syncLog.length - 300);
  logListeners.forEach(fn => fn(e));
}
export function onLogEntry(fn: (e: LogEntry) => void) { logListeners.push(fn); }
export function offLogEntry(fn: (e: LogEntry) => void) {
  const i = logListeners.indexOf(fn); if (i >= 0) logListeners.splice(i, 1);
}

type TabId = 'chat' | 'events' | 'log';

// v3.1.17: per-companion chat helper. We use this in two ways:
//   1. Append a freshly arrived message to a specific companion's
//      history (server tells us which agent it belongs to).
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
    // dedupe
    if (list.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text)) {
      return prev;
    }
    const next = { ...prev, [agentId]: [...list, msg] };
    if (agentId === activeAgentId) {
      setMessages(next[agentId]);
    }
    return next;
  });
}

export default function HomeScreen({ onOpenSettings, onOpenWakeMode }: { onOpenSettings: () => void; onOpenWakeMode?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // v3.1.17: per-companion chat history. The mobile companion tab
  // bar lets the user switch between companions; each companion has
  // its own chat history on the desktop that we mirror locally.
  // `messages` above is a view of `messagesByAgent[activeChatAgentId]`.
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>({});
  // v3.1.17: which companion's chat is currently shown. The
  // companion tab bar updates this when the user taps a tab.
  const [activeChatAgentId, setActiveChatAgentId] = useState<string | null>(null);
  // v3.1.17: unread message count per companion, used to badge
  // companion tabs when the user is on a different one.
  const [chatUnreadByAgent, setChatUnreadByAgent] = useState<Record<string, number>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([...syncLog]);
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);

  const [connState, setConnState] = useState<string>(syncClient.state);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [chatVoiceStatus, setChatVoiceStatus] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
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
  const [agents, setAgents] = useState<Array<{ id: string; name: string; sprite?: string | null; scale?: number | null; emoji?: string | null }>>(() => {
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
  const webViewRef = useRef<WebView>(null);
  // v3.1.14: chat auto-scroll state — only auto-scroll to the newest
  // message when the user is already at (or near) the bottom of the
  // chat. When they've scrolled up to read history, leave them there
  // and show a "↓ new messages" badge so they can jump back down.
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const fullscreenRef = useRef(false);
  const isWakeWordStoppedRef = useRef<boolean>(true);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false); // true while recording/transcribing in wake mode
  // v3.1.17: stable refs that mirror the per-companion state so the
  // sync-event handlers (defined inside the main useEffect) can
  // read the latest values without a stale-closure bug.
  const activeChatAgentIdRef = useRef<string | null>(null);
  const messagesByAgentRef = useRef<Record<string, ChatMessage[]>>({});

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // v3.1.17: keep stable refs in sync with the per-companion state
  // so the sync-event handlers in the main useEffect don't capture
  // stale values.
  useEffect(() => { activeChatAgentIdRef.current = activeChatAgentId; }, [activeChatAgentId]);
  useEffect(() => { messagesByAgentRef.current = messagesByAgent; }, [messagesByAgent]);

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

  // Helper: Add log to voice logs display (only visible in voice mode)
  const addVoiceLog = useCallback((text: string) => {
    setVoiceLogs(prev => {
      const updated = [...prev, text];
      return updated.slice(-4);  // Keep last 4 logs
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
      // Mark wake as handled so the AsyncStorage flag / per-render
      // watcher in HomeScreen doesn't keep re-firing it.
      moduleLevelWakePending = false;
      try { await AsyncStorage.removeItem('cyberclaw-wake-pending'); } catch (_) {}
      wakeWordBusyRef.current = false;
      addLogEntry('🗣️ Wake Mode: handing off to dedicated WakeModeScreen', 'info');
      onOpenWakeMode?.();
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
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.m4a`;
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
                  syncClient.sendAudioInput(base64, 'audio/m4a');
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
                syncClient.sendAudioInput(base64, 'audio/m4a');
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
        // User clicked Voice Mode button in arena → enter fullscreen
        // But not if we're already in Wake Mode - that takes priority
        if (isWakeWordModeRef.current) {
          addLogEntry('Ignoring fullscreen msg - Wake Mode active', 'debug');
        } else {
          addLogEntry(`🎙️ Fullscreen message received from arena`, 'debug');
          enterVoiceMode('focus');
        }
      }
      if (msg.type === 'wakeword') {
        // User clicked Wake Mode button in arena
        addLogEntry(`🗣️ Wake Mode toggle from arena`, 'debug');
        toggleWakeWordMode();
      }
      if (msg.type === 'exitFullscreen') {
        if (isWakeWordModeRef.current) {
          // X button in Wake Mode - exit Wake Mode properly
          addLogEntry('Exiting Wake Mode via X button', 'debug');
          toggleWakeWordMode();
        } else {
          closeFullscreen();
        }
      }
      if (msg.type === 'saveBg') {
        AsyncStorage.setItem('cyberclaw-arena-bg', msg.value);
      }
      if (msg.type === 'saveComp') {
        AsyncStorage.setItem('cyberclaw-arena-comp', msg.value);
      }
    } catch {}
  }, [closeFullscreen]);

  // Handle Android back button in fullscreen mode
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fullscreen) {
        if (isWakeWordModeRef.current) {
          // Back in Wake Mode - toggle off properly (cleans up + closes fullscreen)
          toggleWakeWordMode();
        } else {
          closeFullscreen();
        }
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [fullscreen, closeFullscreen, toggleWakeWordMode]);

  // Wake word → enter voice mode with lock screen
  const handleWakeWord = useCallback(async () => {
    // ALWAYS show a Toast so the user can confirm the wake event reached JS.
    try { NativeModules.NativeBackground?.showToast?.('🎤 Wake word detected!'); } catch (_) {}
    addLogEntry('🎤 Wake word detected - entering Wake Mode', 'info');
    if (wakeWordBusyRef.current) {
      addLogEntry('Wake word detected but already busy - ignoring', 'debug');
      return;
    }
    wakeWordBusyRef.current = true;

    // CRITICAL: stop sample listener BEFORE starting SimpleAudioRecorder
    // Both use AudioRecord - they cannot run simultaneously
    sampleListenerCleanupRef.current?.();
    sampleListenerCleanupRef.current = null;

    // PERSIST the wake event to AsyncStorage BEFORE doing anything else. This
    // survives React re-mounts (e.g. if the activity gets re-ordered to
    // front and React state is wiped). HomeScreen's mount effect will
    // re-enter Wake Mode when it sees the flag. This is the most robust
    // way to handle the wake-from-background case.
    try { await AsyncStorage.setItem('cyberclaw-wake-pending', '1'); } catch (_) {}
    // Clear after 30s as a safety net — the consuming effect will also
    // clear it, but if the consuming effect doesn't fire (e.g. JS error),
    // we don't want the flag to stick around forever.
    setTimeout(() => { AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {}); }, 30000);

    // Module-level flag for the per-render watcher effect below. Survives
    // re-renders (and is the most reliable signal we have).
    moduleLevelWakePending = true;
    moduleLevelWakePendingAt = Date.now();

    // Mark Wake Mode active SYNCHRONOUSLY before any async/native calls.
    isWakeWordModeRef.current = true;
    setIsWakeWordMode(true);

    // DO NOT call NativeBackground.bringToFront() here. It calls
    // startActivity(REORDER_TO_FRONT) on the activity which triggers
    // onNewIntent, which can wipe React state.
    addLogEntry('Wake event handled without native bringToFront (avoids state wipe)', 'debug');

    try {
      await enterVoiceMode('wakeword');
      // Successfully entered voice mode — clear the pending flag so the
      // mount-effect doesn't re-fire the wake event on the next state change.
      moduleLevelWakePending = false;
      try { await AsyncStorage.removeItem('cyberclaw-wake-pending'); } catch (_) {}
    } catch (e: any) {
      addLogEntry(`❌ enterVoiceMode failed: ${e?.message}`, 'error');
      wakeWordBusyRef.current = false;
      // Try to recover by restarting the sample listener
      try {
        const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
        const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey clawsuu') : 'hey clawsuu';
        const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
        const training = trainingJson ? JSON.parse(trainingJson) : null;
        if (training?.features?.length) {
          sampleListenerCleanupRef.current = startSampleMatchListener(
            phrase, training.features, handleWakeWord,
            (m) => addLogEntry(m, 'debug'),
          );
        }
      } catch (_) {}
    }
    // wakeWordBusyRef cleared + sample listener restarted in restartWakeListening
  }, [enterVoiceMode]);

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
      AsyncStorage.getItem('cyberclaw-wake-pending').then(pending => {
        if (consumed) return;
        if (pending === '1') {
          consumed = true;
          addLogEntry('🗣️ Pending wake event found — re-entering Wake Mode', 'info');
          AsyncStorage.removeItem('cyberclaw-wake-pending').catch(() => {});
          // Small delay so any activity re-configuration settles first
          setTimeout(() => {
            // Replay the wake event
            handleWakeWord();
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

  // Per-render watcher for the module-level wake-pending flag. Runs on
  // EVERY render (no deps). If a wake event fired recently (within 10s)
  // and the state has been wiped, re-apply Wake Mode. This is the last
  // line of defense — it catches the case where state is wiped but the
  // component doesn't unmount, the app state doesn't change, and the
  // 2s polling hasn't ticked yet.
  useEffect(() => {
    const now = Date.now();
    if (
      moduleLevelWakePending &&
      moduleLevelWakePendingAt > 0 &&
      now - moduleLevelWakePendingAt < 10000
    ) {
      if (!fullscreen || !isWakeWordMode) {
        addLogEntry('⚠️ Per-render watcher: state wiped during wake event — re-applying', 'debug');
        isWakeWordModeRef.current = true;
        setIsWakeWordMode(true);
        if (!fullscreen) {
          setFullscreen(true);
          fullscreenRef.current = true;
        }
        // Re-apply WebView .fullscreen class
        try {
          webViewRef.current?.injectJavaScript(`
            document.getElementById('ui')?.classList.add('fullscreen');
            document.getElementById('c')?.classList.add('fullscreen');
            document.body.classList.add('fullscreen');
            document.documentElement.classList.add('fullscreen');
            true;
          `);
        } catch (_) {}
      }
    } else if (now - moduleLevelWakePendingAt > 10000) {
      moduleLevelWakePending = false;
    }
  });

  // Load persisted chat
  useEffect(() => {
    AsyncStorage.getItem(CHAT_STORAGE_KEY).then(raw => {
      if (raw) {
        try {
          const loaded = JSON.parse(raw);
          const filtered = loaded.filter((m: any) => m && typeof m.text === 'string' && m.ts && typeof m.isUser === 'boolean');
          // v3.1.16 migration: v3.1.15 stored the array in reversed
          // (newest→oldest) order for an inverted FlatList. v3.1.16
          // uses chronological order. If the stored data starts with
          // a ts that's later than the last item, it's reversed —
          // flip it back. This is non-destructive (no chat clearing)
          // and handles persisted data from any prior version.
          if (filtered.length >= 2) {
            const firstTs = filtered[0].ts;
            const lastTs = filtered[filtered.length - 1].ts;
            if (firstTs > lastTs) {
              setMessages(filtered.reverse());
              return;
            }
          }
          setMessages(filtered);
        } catch (e) {
          console.log('Error loading messages:', e);
        }
      }
    });
    AsyncStorage.getItem('cyberclaw-tts-enabled').then(v => {
      if (v !== null) setTtsEnabled(v === 'true');
    });
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
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
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
      const wasBackground = appStateRef.current === 'background' || appStateRef.current === 'inactive';
      const goingBackground = nextAppState === 'background' || nextAppState === 'inactive';
      const goingForeground = nextAppState === 'active';

      if (goingForeground && wasBackground) {
        // Came back to foreground - restart listener with foreground (lenient) threshold
        if (!isWakeWordModeRef.current && !fullscreenRef.current) {
          const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
          const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
          const phrase = settings.wakeWord || 'hey clawsuu';
          const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
          const training = trainingJson ? JSON.parse(trainingJson) : null;
          if (training?.features?.length) {
            sampleListenerCleanupRef.current?.();
            sampleListenerCleanupRef.current = startSampleMatchListener(
              phrase, training.features, handleWakeWord,
              (msg) => addLogEntry(msg, 'debug'),
              SAMPLE_MATCH_THRESHOLD_FG,
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
            const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
            const training = trainingJson ? JSON.parse(trainingJson) : null;
            if (training?.features?.length) {
              sampleListenerCleanupRef.current?.();
              sampleListenerCleanupRef.current = startSampleMatchListener(
                phrase, training.features, handleWakeWord,
                (msg) => addLogEntry(msg, 'debug'),
                bgThreshold,
              );
            } else {
              WakeWordModule?.start?.(phrase).catch(() => {});
            }
          } else if (wakeMode === 'porcupine' && ppnPath) {
            WakeWordModule?.startPorcupine?.(ppnPath).catch(() => WakeWordModule?.start?.(phrase).catch(() => {}));
          } else {
            WakeWordModule?.start?.(phrase).catch(() => {});
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
        const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase))
          .catch(() => null);
        const training = trainingJson ? JSON.parse(trainingJson) : null;
        if (training?.features?.length) {
          sampleListenerCleanupRef.current?.();
          sampleListenerCleanupRef.current = startSampleMatchListener(
            phrase, training.features, handleWakeWord,
            (msg) => addLogEntry(msg, 'debug'),
            SAMPLE_MATCH_THRESHOLD_FG,
          );
          addLogEntry(`Starting sample-match wake detection, phrase: "${phrase}"`, 'info');
        } else {
          WakeWordModule?.start?.(phrase).catch(() => {});
          addLogEntry(`No training data for sample mode, falling back to Vosk`, 'error');
        }
      } else if (wakeMode === 'porcupine' && ppn) {
        WakeWordModule?.startPorcupine?.(ppn).catch((e: any) => {
          addLogEntry(`Porcupine failed: ${e?.message}, falling back to Vosk`, 'error');
          WakeWordModule?.start?.(phrase).catch(() => {});
        });
        addLogEntry(`Starting Porcupine wake detection`, 'info');
      } else {
        WakeWordModule?.start?.(phrase).catch(() => {});
        addLogEntry(`Starting wake detection, phrase: "${phrase}"`, 'info');
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
      if (msg.isUser) {
        addLogEntry(`📨 Skipping user message`, 'received');
        return;
      }
      // v3.1.17: route incoming chat to the correct companion tab.
      // The desktop tags the message with agentId; if it's missing,
      // fall back to the active chat agent. Either way, we update
      // messagesByAgent[aid] and bump the unread counter for that
      // agent unless it's the currently active one.
      const aid: string = msg.agentId || activeChatAgentIdRef.current || 'companion';
      const incoming: ChatMessage = {
        id: `${msg.ts || Date.now()}-${Math.random()}`,
        text: msg.text,
        isUser: false,
        agentId: aid,
        agentName: msg.agentName,
        ts: msg.ts || Date.now(),
      };
      appendAgentMessage(incoming, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
      if (aid !== activeChatAgentIdRef.current) {
        setChatUnreadByAgent(prev => ({ ...prev, [aid]: (prev[aid] || 0) + 1 }));
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
            try {
              const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
              const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey clawsuu') : 'hey clawsuu';
              const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
              const training = trainingJson ? JSON.parse(trainingJson) : null;
              if (training?.features?.length && !sampleListenerCleanupRef.current) {
                sampleListenerCleanupRef.current = startSampleMatchListener(
                  phrase, training.features, handleWakeWord,
                  (m) => addLogEntry(m, 'debug'),
                );
                addLogEntry('🔄 Sample listener restarted', 'debug');
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
      if (!fullscreenRef.current && msg.active) setChatVoiceStatus('Clawsuu is thinking...');
      if (!fullscreenRef.current && !msg.active) { /* keep until message arrives */ }
    };

    const onChatHistory = (msg: any) => {
      if (Array.isArray(msg.messages) && msg.messages.length > 0) {
        addLogEntry(`← Loaded ${msg.messages.length} messages from desktop`, 'info');
        // v3.1.16: data is stored in chronological order (oldest→newest).
        // The desktop sends it that way; we keep it as-is.
        const loaded = msg.messages.map((m: any) => ({
          id: `hist-${m.ts}-${Math.random()}`,
          text: m.text,
          isUser: m.isUser,
          agentId: m.agentId,
          agentName: m.agentName,
          ts: m.ts,
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
        addLogEntry(`🔊 Written to ${tmpPath}, calling startPlayer`, 'info');

        // If in voice mode, set status to 'playing'
        if (fullscreenRef.current) {
          setVoiceStatus('playing');
        }

        try {
          await WakeWordModule.startPlayer(tmpPath);
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
            const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.m4a`;
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
                    syncClient.sendAudioInput(base64, 'audio/m4a');
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
                    syncClient.sendAudioInput(base64, 'audio/m4a');
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

    syncClient.on('typing', onTyping);
    syncClient.on('chat_history', onChatHistory);
    syncClient.on('arena', onArena);
    syncClient.on('audio_response', onAudioResponse);
    const onVoiceTranscriptResult = (msg: any) => {
      if (!msg.transcript) {
        setChatVoiceStatus(null);
        addLogEntry('No speech detected', 'error');
        return;
      }
      addLogEntry(`Transcribed: "${msg.transcript}"`, 'received');
      // Display transcript in UI
      setMessages(prev => {
        const dupe = prev.some(m => m.isUser && Math.abs(m.ts - Date.now()) < 5000 && m.text === msg.transcript);
        if (dupe) return prev;
        // v3.1.16: append in chronological order.
        return [...prev, { id: `user-${Date.now()}`, text: msg.transcript, isUser: true, ts: Date.now() }];
      });
      // Send to AI - desktop transcribed the audio but we must send the text to trigger the AI response
      setChatVoiceStatus('Clawsuu is thinking...');
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
    const onAgentHistory = (msg: any) => {
      if (!msg?.agentId) return;
      const aid = msg.agentId;
      const loaded: ChatMessage[] = (Array.isArray(msg.messages) ? msg.messages : []).map((m: any) => ({
        id: `hist-${m.ts}-${Math.random()}`,
        text: m.text,
        isUser: m.isUser,
        agentId: m.agentId || aid,
        agentName: m.agentName,
        ts: m.ts,
      }));
      addLogEntry(`← Loaded ${loaded.length} messages for ${aid}`, 'info');
      setMessagesByAgent(prev => ({ ...prev, [aid]: loaded }));
      // If this is the active companion, swap the visible messages.
      // We read activeChatAgentIdRef to avoid stale-closure issues
      // (the closure for this useEffect doesn't see state updates
      // after mount).
      if (activeChatAgentIdRef.current === aid) {
        setMessages(loaded);
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
        setAgents(msg.agents);
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
        // Request history for every companion so switching tabs is
        // instant. The desktop will respond with `agent_history` per
        // agent; we fill each slot as responses arrive.
        for (const a of msg.agents) {
          try { syncClient.requestAgentHistory(a.id); } catch (_) {}
        }
      }
    };
    syncClient.on('agents_list', onAgentsList);

    // NOTE: Wake word detection now happens locally on mobile in Wake Mode

    // NOTE: Wake word listener already set up at line 603 (wakeSub)
    // No need for duplicate listener here

    const onSendError = (e: any) => {
      if (e?.type === 'audio_input') {
        setChatVoiceStatus(null);
        addLogEntry('Not connected - reconnect and try again', 'error');
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
      try { wakeSub?.remove?.(); } catch {}
      try { wakeOpenSub?.remove?.(); } catch {}
      try { debugSub?.remove?.(); } catch {}
      try { syncClient?.off?.('companion_id', onCompanionChange); } catch {}
      try { syncClient?.off?.('state_change', onState); } catch {}
      try { syncClient?.off?.('chat', onChat); } catch {}
      try { syncClient?.off?.('typing', onTyping); } catch {}
      try { syncClient?.off?.('chat_history', onChatHistory); } catch {}
      try { syncClient?.off?.('arena', onArena); } catch {}
      try { syncClient?.off?.('audio_response', onAudioResponse); } catch {}
      try { syncClient?.off?.('voice_transcript_result', onVoiceTranscriptResult); } catch {}
      try { syncClient?.off?.('voice_received', onVoiceReceived); } catch {}
      try { syncClient?.off?.('agents_list', onAgentsList); } catch {}
      try { syncClient?.off?.('agent_history', onAgentHistory); } catch {}

      try { syncClient?.off?.('send_error', onSendError); } catch {}
      try { offLogEntry?.(onLogUpdate); } catch {}
      try { disposeSimpleAudioRecorder?.(); } catch {}
    };
  }, [speak, setArenaThinking]);





  const appStateRef = useRef<string>(AppState.currentState);

  // Add attachment
  const addAttachment = (asset: any) => {
    const attachment: AttachmentItem = {
      id: Date.now().toString(),
      uri: asset.uri || '',
      name: asset.fileName || 'attachment',
      type: asset.type || 'image/jpeg',
    };
    setAttachments(prev => [...prev, attachment]);
    addLogEntry(`📎 Added: ${attachment.name}`, 'info');
  };

  // Remove attachment
  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  // Toggle Wake Mode - v3.1.12: delegate to App-level navigation so the
  // wake mode UI always renders in the dedicated WakeModeScreen (not as
  // a conditional fullscreen render of HomeScreen, which was racy).
  const toggleWakeWordMode = useCallback(async () => {
    if (!isWakeWordModeRef.current) {
      addLogEntry('🗣️ Wake Mode: opening dedicated screen', 'info');
      if (onOpenWakeMode) {
        onOpenWakeMode();
      } else {
        // Fallback: keep the old behaviour in case onOpenWakeMode is
        // missing (e.g. tests or older App.tsx).
        setFullscreen(true);
        fullscreenRef.current = true;
        setVoiceStatus('listening');
        AppControl?.keepScreenOn?.(true);
        const js = `
          document.getElementById('ui').classList.add('fullscreen');
          document.getElementById('c').classList.add('fullscreen');
          true;
        `;
        webViewRef.current?.injectJavaScript(js);
        addLogEntry('🗣️ Wake Mode: ACTIVE (fallback)', 'info');
        isWakeWordModeRef.current = true;
        setIsWakeWordMode(true);
      }
    }
    // Exiting Wake Mode from HomeScreen is no longer supported — the
    // WakeModeScreen has its own X / back handler. The exit logic in
    // WakeModeScreen tears down the listener + recorder.
  }, [onOpenWakeMode]);

  const handleAttach = useCallback(() => {
    Alert.alert('Attach', 'Choose source', [
      { text: 'Camera', onPress: () => launchCamera({ mediaType: 'mixed', quality: 0.8 }, (res) => {
        if (res.assets?.[0]) addAttachment(res.assets[0]);
      })},
      { text: 'Gallery', onPress: () => launchImageLibrary({ mediaType: 'mixed', selectionLimit: 0 }, (res) => {
        if (res.assets && res.assets.length > 0) {
          res.assets.forEach(asset => addAttachment(asset));
        }
      })},
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  const sendMessage = useCallback(async () => {
    if (!isConnected) return;
    // If there's a pending voice recording, send that
    if (pendingAudioPath) {
      try {
        const fs = require('react-native-fs');
        const base64 = await fs.readFile(pendingAudioPath, 'base64');
        setChatVoiceStatus('Sending to desktop...');
        syncClient.sendAudioInput(base64, 'audio/m4a');
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
    if (!text && attachments.length === 0) return;

    if (text) {
      // v3.1.17: tag the user message with the active companion's
      // agentId so it lands in the right slot of messagesByAgent and
      // the desktop routes the response back to the same companion.
      const aid = activeChatAgentIdRef.current || 'companion';
      const userMsg: ChatMessage = { id: `user-${Date.now()}`, text, isUser: true, agentId: aid, ts: Date.now() };
      appendAgentMessage(userMsg, aid, setMessagesByAgent, setMessages, activeChatAgentIdRef.current);
      syncClient.sendChat(text, aid);
      addLogEntry(`→ [${aid}] ${text.substring(0, 80)}`, 'sent');
    }

    for (const att of attachments) {
      try {
        const fs = require('react-native-fs');
        if (att.uri.startsWith('file://')) {
          fs.readFile(att.uri, 'base64').then((b64: string) => {
            syncClient.sendAttachment(b64, att.type, att.name);
            addLogEntry(`📎 Sent: ${att.name}`, 'info');
          });
        }
      } catch (e) { console.log('attachment error', e); }
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
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-chat-voice-${Date.now()}.m4a`;
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
    if (chatAtBottom) {
      setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
    }
    return;
  }
  // Incoming message while at bottom: auto-scroll. While scrolled
  // away: increment the unread badge.
  if (chatAtBottom) {
    setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
  } else {
    setChatUnreadCount(c => c + 1);
  }
}, [messages.length]);

// v3.1.16: when the user switches to the chat tab, jump to the
// newest message so they don't have to manually scroll. This is
// the "open at the bottom" behavior the user expects. Also clear
// the unread badge — they're looking at the chat now.
useEffect(() => {
  if (activeTab === 'chat') {
    if (messages.length > 0) {
      setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
    }
    setChatUnreadCount(0);
  }
}, [activeTab]);

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

    // v3.1.15: show the actual agent name (e.g. "🐾 Lamasuu") if we
    // know which agent spoke, otherwise fall back to the legacy label.
    // v3.1.15+ also reads item.agentName from the desktop payload.
    const agentLabel = item.isUser
      ? '👤 You'
      : (item.agentName || (item.agentId && item.agentId !== 'boar' ? `🐾 ${item.agentId}` : '🐾 Clawsuu'));

    const dateStr = getDateBucketLabel(item.ts);

    return (
      <View>
        {showDateSeparator && <Text style={styles.dateSeparator}>{dateStr}</Text>}
        <View style={[styles.messageBubble, item.isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={[styles.agentLabel, item.isUser ? styles.userLabel : styles.aiLabel]}>
            {agentLabel}
          </Text>
          <Text style={[styles.messageText, item.isUser ? styles.userText : styles.aiText]}>{item.text}</Text>
          <Text style={styles.timestamp}>{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
        </View>
      </View>
    );
  }, [messages]);

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

  // Watch companionId changes and reload WebView when it updates
  useEffect(() => {
    addLogEntry(`Companion updated: ${companionId}`, 'info');
    setWebViewKey(k => k + 1);
  }, [companionId]);

  // v3.1.15: when the agents list updates, push it into the WebView so
  // the arena can render one sprite per agent. Only injects if the
  // WebView is mounted; otherwise the next onLoadEnd will pick it up
  // via the agents list sent in the prefs message.
  useEffect(() => {
    if (agents.length === 0) return;
    if (!webViewRef.current) return;
    try {
      const js = `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'agentsList', agents }))}})); document.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'agentsList', agents }))}})); true;`;
      webViewRef.current.injectJavaScript(js);
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
            {isWakeWordMode && (
              <Text style={styles.wakeModeBadge}>🗣️ Wake Mode</Text>
            )}
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

      {/* Arena - Conditional rendering based on fullscreen or landscape */}
      {!keyboardVisible && (
        <View style={fullscreen || isLandscape ? [StyleSheet.absoluteFill, { zIndex: 100 }] : { height: ARENA_HEIGHT, borderBottomWidth: 2, borderBottomColor: '#f7931a' }}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: `file:///android_asset/arena.html?companion=${companionId}&platform=mobile` }}
            style={{ flex: 1, backgroundColor: '#0a0a2e' }}
            scrollEnabled={false}
            bounces={false}
            javaScriptEnabled
            allowFileAccess
            originWhitelist={['*']}
            onMessage={handleArenaMessage}
            onLoadEnd={() => {
              Promise.all([
                AsyncStorage.getItem('cyberclaw-arena-bg'),
                AsyncStorage.getItem('cyberclaw-arena-comp'),
              ]).then(([bgId, compId]) => {
                const prefs = { type: 'loadPrefs', bgId: bgId || 'forest', compId: compId || 'fox' };
                const js = `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(prefs))}})); document.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(prefs))}})); true;`;
                webViewRef.current?.injectJavaScript(js);
                // v3.1.15: also seed the agents list at load so the
                // arena can show all companions immediately. Uses the
                // same channel as the runtime agentsList injection.
                if (agents.length > 0) {
                  const agentsJs = `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'agentsList', agents }))}})); document.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'agentsList', agents }))}})); true;`;
                  webViewRef.current?.injectJavaScript(agentsJs);
                }
              });
            }}
          />
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
          {/* Voice mode log display - green terminal at bottom */}
          {fullscreen && (
            <View style={styles.voiceLogOverlay} pointerEvents="none">
              <Text style={styles.voiceLogText}>
                {voiceLogs.slice(-3).map((log, i) => `${log}`).join('\n')}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Thinking indicator - Hidden when fullscreen */}
      {!fullscreen && isThinking && (
        <View style={styles.thinkingBar}>
          <Text style={styles.thinkingText}>💭 Clawsuu is thinking...</Text>
        </View>
      )}

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
          flow is working. */}
      {!fullscreen && !isLandscape && (() => {
        const list = agents.length > 0 ? agents : [{ id: 'clawsuu', name: 'Clawsuu', emoji: '🐾' }];
        return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.companionTabBar}
          contentContainerStyle={styles.companionTabBarContent}
        >
          {list.map(a => {
            const isActive = activeChatAgentId === a.id;
            const unread = chatUnreadByAgent[a.id] || 0;
            return (
              <TouchableOpacity
                key={a.id}
                style={[styles.companionTab, isActive && styles.companionTabActive]}
                onPress={() => {
                  // Switch active companion: update the visible
                  // `messages` view to this companion's history, clear
                  // their unread counter, and request a fresh history
                  // in case anything changed on the desktop.
                  setActiveChatAgentId(a.id);
                  setMessages(messagesByAgent[a.id] || []);
                  setChatUnreadByAgent(prev => ({ ...prev, [a.id]: 0 }));
                  try { syncClient.requestAgentHistory(a.id); } catch (_) {}
                }}
              >
                <Text style={styles.companionTabEmoji}>{a.emoji || '🤖'}</Text>
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
      <KeyboardAvoidingView style={styles.tabContent} behavior='padding'>
        {activeTab === 'chat' && (
          <>
            {chatUnreadCount > 0 && !chatAtBottom && (
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
            <FlatList
              ref={chatRef}
              data={messages}
              keyExtractor={i => i.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.chatList}
              showsVerticalScrollIndicator={true}
              scrollEnabled={true}
              // v3.1.16: simple chronological FlatList (not inverted).
              // Newest message lives at the end of the array and the
              // end of the screen, where the user reads it. We use
              // scrollToEnd to jump there.
              inverted={false}
              onScroll={(e) => {
                // Without inversion, "at the bottom" means near the
                // end of contentSize.height (within a small threshold
                // of layoutHeight).
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                setChatAtBottom(distanceFromEnd < 32);
              }}
              onContentSizeChange={() => {
                // Auto-scroll to the newest on first render and whenever
                // the user is already at the bottom when new content
                // arrives.
                if (chatAtBottom) {
                  chatRef.current?.scrollToEnd({ animated: false });
                }
              }}
              onLayout={() => {
                if (messages.length > 0) {
                  setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 150);
                }
              }}
              ListFooterComponent={null} // Disabled: old messages mix with current session
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>
                    {isConnected ? "Say hi to Clawsuu! 🐾🐾" : "Connect to desktop CyberClaw to chat"}
                  </Text>
                </View>
              }
            />
            {chatVoiceStatus && (
              <View style={styles.chatStatusBar}>
                <Text style={styles.chatStatusText}>{chatVoiceStatus}</Text>
              </View>
            )}
            <View style={styles.inputContainer}>
              <TouchableOpacity style={styles.micButton} onPress={handleAttach}>
                <Text style={styles.micButtonText}>+</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.micButton, isVoiceListening && styles.micButtonActive]}
                onPress={toggleVoiceInput}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.6}
              >
                <Text style={[styles.micButtonText, isVoiceListening && { color: '#ef4444' }]}>
                  {isVoiceListening ? '⏹ Stop' : 'Mic'}
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
                  placeholder={isConnected ? "Message Clawsuu..." : "Not connected"}
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
                style={[styles.sendButton, (!pendingAudioPath && !inputText.trim() || !isConnected) && styles.sendButtonDisabled]}
                onPress={sendMessage}
                disabled={!pendingAudioPath && (!inputText.trim() || !isConnected)}
              >
                <Text style={styles.sendButtonText}>▶</Text>
              </TouchableOpacity>
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
              <Text style={styles.wakeDebugText} numberOfLines={1}>Mic: {wakeDebug}</Text>
            </View>
            <FlatList
              ref={logRef}
              data={logEntries}
              keyExtractor={i => i.id}
              renderItem={renderLog}
              contentContainerStyle={styles.logList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: false })}
              ListEmptyComponent={<Text style={[styles.emptyChatText, { padding: 20 }]}>No log entries</Text>}
            />
          </>
        )}
      </KeyboardAvoidingView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
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
    paddingBottom: 10,
    backgroundColor: '#111', borderBottomWidth: 1, borderBottomColor: '#222',
  },
  headerTitle: { color: '#f7931a', fontSize: 16, fontWeight: 'bold' },
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
  headerTitleLeft: { color: '#f7931a', fontSize: 16, fontWeight: 'bold' },
  headerTitleRight: { color: '#f7931a', fontSize: 16, fontWeight: 'bold' },
  headerCameraSpace: { width: 32 }, // room for camera cutout
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  dotOnline: { backgroundColor: '#4ade80' },
  dotOffline: { backgroundColor: '#666' },
  dotLost: { backgroundColor: '#ef4444' },
  statusLabel: { color: '#888', fontSize: 12, marginRight: 10 },
  settingsBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center', alignItems: 'center',
  },
  settingsIcon: { fontSize: 16 },
  thinkingBar: {
    backgroundColor: '#1a1a0a', paddingHorizontal: 16, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#333',
  },
  thinkingText: { color: '#f7931a', fontSize: 12, fontStyle: 'italic' },
  wakeDebugBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)', paddingHorizontal: 10, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: '#222',
  },
  wakeDebugText: { flex: 1, color: '#4ade80', fontSize: 11, fontFamily: 'monospace' },
  tabBar: {
    flexDirection: 'row', backgroundColor: '#111',
    borderBottomWidth: 1, borderBottomColor: '#222',
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#f7931a' },
  tabText: { color: '#666', fontSize: 13 },
  tabTextActive: { color: '#f7931a', fontWeight: 'bold' },
  // v3.1.17: companion tab bar (one tab per companion). Sits
  // between the system tabs and the chat content.
  companionTabBar: {
    backgroundColor: '#0a0a14',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
    maxHeight: 64,
  },
  companionTabBarContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  companionTab: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#15151f',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#222',
  },
  companionTabActive: {
    backgroundColor: 'rgba(247,147,26,0.18)',
    borderColor: '#f7931a',
  },
  companionTabEmoji: {
    fontSize: 16,
    marginRight: 6,
  },
  companionTabName: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 90,
  },
  companionTabNameActive: {
    color: '#f7931a',
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
  chatList: { padding: 12, paddingBottom: 8 },
  dateSeparator: {
    color: '#f7931a',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
    marginVertical: 10,
    opacity: 0.85,
  },
  messageBubble: { maxWidth: '85%', padding: 10, borderRadius: 12, marginBottom: 8 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#1a3a5c', borderBottomRightRadius: 4 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: '#1a1a2e', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#333' },
  agentLabel: { fontSize: 10, fontWeight: '700', marginBottom: 4 },
  userLabel: { color: '#ffffff', fontWeight: 'bold' },
  aiLabel: { color: '#f7931a', fontWeight: 'bold' },
  messageText: { fontSize: 12, lineHeight: 16 },
  userText: { color: '#ffffff', fontWeight: '500' },  // White for user
  aiText: { color: '#f7931a' },  // Orange for companion
  timestamp: { color: '#888', fontSize: 8, marginTop: 4, textAlign: 'right' },
  emptyChat: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 40 },
  emptyChatText: { color: '#555', fontSize: 14, textAlign: 'center' },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#111',
  },
  textInput: {
    flex: 1, backgroundColor: '#1a1a2e', color: '#e0e0e0',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 15, maxHeight: 100, borderWidth: 1, borderColor: '#333',
  },
  sendButton: {
    marginLeft: 8, width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#f7931a', justifyContent: 'center', alignItems: 'center',
  },
  sendButtonDisabled: { backgroundColor: '#333' },
  sendButtonText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  eventLine: { color: '#3b82f6', fontSize: 12, fontFamily: 'monospace', lineHeight: 18, marginBottom: 4, fontWeight: '500' },  // Blue for events
  logList: { padding: 12 },
  logLine: { color: '#8a8', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  logSent: { color: '#4a9eff' },
  logReceived: { color: '#4ade80' },
  logError: { color: '#ff0000' },  // Red for error logs
  micButton: {
    backgroundColor: 'rgba(247,147,26,0.12)', borderRadius: 20,
    width: 48, height: 48, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(247,147,26,0.4)', marginRight: 6,
  },
  micButtonActive: {
    backgroundColor: 'rgba(239,68,68,0.25)', borderColor: '#ef4444',
  },

  micButtonText: { color: '#f7931a', fontSize: 11, fontWeight: '600' },
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
