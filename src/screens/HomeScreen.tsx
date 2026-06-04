/**
 * HomeScreen — CyberClaw mobile companion
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

// Native modules
const { BackgroundService, AppControl, WakeWordModule } = NativeModules;
// Lazy getter — NativeEventEmitter must not be instantiated at module eval time
// (bridge may not be ready). Create on first use instead.
let _wakeWordEmitter: NativeEventEmitter | null = null;
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
const SAMPLE_MATCH_THRESHOLD = 0.55;

function startSampleMatchListener(
  _phrase: string,
  trainingFeatures: AudioFeatures[],
  onDetected: () => void,
  onLog?: (msg: string) => void,
): () => void {
  let stopped = false;
  const sub = wakeWordEmitter?.addListener('sampleAudioChunk', async (e: { wav: string }) => {
    if (stopped) return;
    try {
      const pcm16 = base64ToInt16Array(e.wav);
      if (pcm16.length < 1600) return;
      const features = extractAudioFeatures(pcm16);
      const result = await matchAgainstTraining(features, trainingFeatures, SAMPLE_MATCH_THRESHOLD);
      onLog?.(`sample match: ${(result.score * 100).toFixed(0)}%`);
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
    if (enabled !== 'false' && BackgroundService) await BackgroundService.start();
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

export default function HomeScreen({ onOpenSettings, onOpenArenaSettings }: { onOpenSettings: () => void; onOpenArenaSettings: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const [webViewKey, setWebViewKey] = useState(0);
  const chatRef = useRef<FlatList>(null);
  const eventsRef = useRef<FlatList>(null);
  const logRef = useRef<FlatList>(null);
  const webViewRef = useRef<WebView>(null);
  const fullscreenRef = useRef(false);
  const isWakeWordStoppedRef = useRef<boolean>(true);
  const sampleListenerCleanupRef = useRef<(() => void) | null>(null);
  const wakeWordBusyRef = useRef(false); // true while recording/transcribing in wake mode

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // Load companion selection from storage on mount
  useEffect(() => {
    AsyncStorage.getItem('cyberclaw-arena-comp').then(v => {
      if (v) {
        addLogEntry('Loaded companion from storage: ' + v, 'info');
        setCompanionId(v);
      }
    }).catch(() => {});
    
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
    // Prefer native Android TTS — works reliably even when AudioRecord is active
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
    setVoiceLogs([]);  // Clear logs on enter
    addVoiceLog('🎙️ Listening...');
    
    // FIXED: Set fullscreen ALWAYS, not just for wakeword
    AppControl?.keepScreenOn?.(true);
    setFullscreen(true);
    fullscreenRef.current = true;
    
    // Initialize Voice Activity Detection
    const vad = getVAD({ sampleRate: 16000, frameSize: 512, silenceThreshold: 0.02 });
    resetVAD();
    addVoiceLog('🎙️ VAD ready');
    
    if (source === 'wakeword') {
      bringToForeground();
      AppControl?.showOnLockScreenWithDismiss?.();
      addLogEntry('Entering voice mode', 'info');
      
      // Tell arena to enter focus mode
      webViewRef.current?.injectJavaScript(`
        window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})}));
        document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})}));
        true;
      `);
    }
    
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
      if (msg.type === 'openArenaSettings') {
        // Arena Settings button clicked - open full-screen Arena Settings
        onOpenArenaSettings();
        return;
      }
      
      if (msg.type === 'log') {
        // Log message from arena - display in app logs
        addLogEntry(msg.text || 'Arena log', 'info');
        return;
      }
      
      if (msg.type === 'fullscreen') {
        // User clicked Voice Mode button in arena → enter fullscreen
        // But not if we're already in wake word mode — that takes priority
        if (isWakeWordModeRef.current) {
          addLogEntry('Ignoring fullscreen msg — wake word mode active', 'debug');
        } else {
          addLogEntry(`🎙️ Fullscreen message received from arena`, 'debug');
          enterVoiceMode('focus');
        }
      }
      if (msg.type === 'wakeword') {
        // User clicked Wake Word Mode button in arena
        addLogEntry(`🗣️ Wake Word Mode toggle from arena`, 'debug');
        toggleWakeWordMode();
      }
      if (msg.type === 'exitFullscreen') {
        // User clicked Exit in voice mode → exit fullscreen
        closeFullscreen();
      }
      if (msg.type === 'saveBg') {
        AsyncStorage.setItem('cyberclaw-arena-bg', msg.value);
      }
      if (msg.type === 'saveComp') {
        AsyncStorage.setItem('cyberclaw-arena-comp', msg.value);
      }
    } catch {}
  }, [closeFullscreen, onOpenArenaSettings]);

  // Handle Android back button in fullscreen mode
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      addLogEntry(`🎙️ hardwareBackPress event (fullscreen=${fullscreen})`, 'debug');
      if (fullscreen) {
        addLogEntry('🎙️ Back pressed in fullscreen, exiting', 'debug');
        closeFullscreen();
        return true;
      }
      return false;
    });
    return () => backHandler.remove();
  }, [fullscreen, closeFullscreen]);

  // Wake word → enter voice mode with lock screen
  const handleWakeWord = useCallback(async () => {
    if (wakeWordBusyRef.current) {
      addLogEntry('Wake word detected but already busy — ignoring', 'debug');
      return;
    }
    wakeWordBusyRef.current = true;
    // CRITICAL: stop sample listener BEFORE starting SimpleAudioRecorder
    // Both use AudioRecord — they cannot run simultaneously
    sampleListenerCleanupRef.current?.();
    sampleListenerCleanupRef.current = null;
    addLogEntry('🎤 Wake word! Stopped sample listener, starting recorder', 'info');
    await enterVoiceMode('wakeword');
    // wakeWordBusyRef cleared + sample listener restarted in restartWakeListening
  }, [enterVoiceMode]);

  // Load persisted chat
  useEffect(() => {
    AsyncStorage.getItem(CHAT_STORAGE_KEY).then(raw => {
      if (raw) { 
        try { 
          const loaded = JSON.parse(raw);
          const filtered = loaded.filter((m: any) => m && typeof m.text === 'string' && m.ts && typeof m.isUser === 'boolean');
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
  
  // Wake Word Mode
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const isWakeWordModeRef = useRef(false);
  const [wakeWordSession, setWakeWordSession] = useState<{ id: string; audioChunks: string[] } | null>(null);

  // toggleVoiceInput defined after sendMessage below

  // AppState listener to manage wake word based on app foreground/background
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        // App came to foreground → STOP wake word ONCE (unless already stopped)
        if (!isWakeWordStoppedRef.current) {
          if (NativeModules.NativeBackground) {
          try {
            NativeModules.NativeBackground.stopListening();
            NativeModules.NativeBackground.showToast('🔕 Wake word listening stopped');
          } catch (e) {}
        }
          // Stop sample listener if running
          sampleListenerCleanupRef.current?.();
          sampleListenerCleanupRef.current = null;
          isWakeWordStoppedRef.current = true;
          // Lifecycle: app in foreground
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App went to background → START wake word ONCE (unless in fullscreen/voice mode)
        if (isWakeWordStoppedRef.current && !fullscreenRef.current) {
          Promise.all([
            AsyncStorage.getItem('cyberclaw-audio-settings'),
            AsyncStorage.getItem('cyberclaw-ppn-path'),
            AsyncStorage.getItem('cyberclaw-wake-mode'),
          ]).then(async ([settingsRaw, ppnPath, wakeModeRaw]) => {
            const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
            const ppn = ppnPath || '';
            const wakeMode = wakeModeRaw || 'vosk';
            const phrase = settings.wakeWord || 'hey claw';
            if (wakeMode === 'sample') {
              // Load training features and start looping sample listener
              const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase))
                .catch(() => null);
              const training = trainingJson ? JSON.parse(trainingJson) : null;
              if (training?.features?.length) {
                sampleListenerCleanupRef.current?.();
                sampleListenerCleanupRef.current = startSampleMatchListener(
                  phrase, training.features, handleWakeWord,
                );
              } else {
                // No training data, fall back to Vosk
                WakeWordModule?.start?.(phrase).catch(() => {});
              }
            } else if (wakeMode === 'porcupine' && ppn) {
              WakeWordModule?.startPorcupine?.(ppn).catch((e: any) => {
                WakeWordModule?.start?.(phrase).catch(() => {});
              });
            } else {
              WakeWordModule?.start?.(phrase).catch(() => {});
            }
            isWakeWordStoppedRef.current = false;
            // Lifecycle: app in background
          });
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

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
      const wakeMode = wakeModeRaw || 'vosk';
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
    // If so, don't start wake word yet — wait for transition
    if (appStateRef.current !== 'active') {
      // App is backgrounded — wake word will be started by AppState listener
    }

    // Wake word event → bring app to front in focus mode
    const wakeSub = wakeWordEmitter?.addListener('wakeWordDetected', () => {
      handleWakeWord();
    });
    // Also listen for wake-word-opened-app from MainActivity (broadcast receiver path)
    const { DeviceEventEmitter } = require('react-native');
    const wakeOpenSub = DeviceEventEmitter.addListener('wakeWordOpenedApp', () => {
      handleWakeWord();
    });
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
      // If in voice mode, treat text response as audio response
      if (fullscreenRef.current && !msg.isUser) {
        addLogEntry(`🎙️ Voice mode response: "${msg.text.substring(0, 50)}..."`, 'info');
        addVoiceLog(`🔊 Responding: "${msg.text.substring(0, 40)}..."`);
        setVoiceStatus('playing');

        // Always add response to chat log (wake word mode or regular voice)
        setChatVoiceStatus(null);
        setMessages(prev => {
          const dupe = prev.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text);
          if (dupe) return prev;
          return [...prev, { id: `${msg.ts}-${Math.random()}`, text: msg.text, isUser: false, agentId: msg.agentId, ts: msg.ts }];
        });

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

          ttsDoneSub = wakeWordEmitter?.addListener('ttsDone', restartWakeListening);
          const wordCount = msg.text.split(/\s+/).length;
          const fallbackMs = Math.max(4000, Math.ceil((wordCount / 130) * 60 * 1000) + 2000);
          ttsTimeoutId = setTimeout(restartWakeListening, fallbackMs);

          speak(msg.text);
        } else {
          speak(msg.text);
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
      setMessages(prev => {
        const dupe = prev.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text);
        if (dupe) {
          addLogEntry(`📨 Skipping duplicate message`, 'received');
          return prev;
        }
        addLogEntry(`📨 Chat updated, total: ${prev.length + 1}`, 'received');
        return [...prev, { id: `${msg.ts}-${Math.random()}`, text: msg.text, isUser: false, agentId: msg.agentId, ts: msg.ts }];
      });
      speak(msg.text);
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
        setMessages(msg.messages.map((m: any) => ({
          id: `hist-${m.ts}-${Math.random()}`,
          text: m.text,
          isUser: m.isUser,
          agentId: m.agentId,
          ts: m.ts,
        })));
      }
    };

    const onArena = (msg: any) => {
      setEvents(prev => [`${new Date().toLocaleTimeString()} ${msg.event || JSON.stringify(msg)}`, ...prev.slice(0, 99)]);
    };

    const onAudioResponse = async (msg: any) => {
      addLogEntry(`🔊 onAudioResponse called: fullscreen=${fullscreenRef.current}, hasAudio=${!!msg.audioBase64}`, 'debug');
      try {
        if (!msg.audioBase64) {
          addLogEntry(`🔊 No audioBase64, returning`, 'debug');
          return;
        }
        const fs = require('react-native-fs');
        const ext = (msg.mimeType && msg.mimeType.includes('wav')) ? 'wav' : 'mp3';
        const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-response-${Date.now()}.${ext}`;
        await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
        
        // If in voice mode, set status to 'playing'
        if (fullscreenRef.current) {
          setVoiceStatus('playing');
          addLogEntry('Response audio status: playing', 'info');
        }
        
        await WakeWordModule.startPlayer(tmpPath);
        addLogEntry('Playing audio response', 'received');
        
        // After playback, if still in voice mode, restart listening loop
        if (fullscreenRef.current) {
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
        return [...prev, { id: `user-${Date.now()}`, text: msg.transcript, isUser: true, ts: Date.now() }];
      });
      // Send to AI — desktop transcribed the audio but we must send the text to trigger the AI response
      setChatVoiceStatus('Clawsuu is thinking...');
      syncClient.sendChat(msg.transcript);
    };
    syncClient.on('voice_transcript_result', onVoiceTranscriptResult);

    const onVoiceReceived = () => {
      setChatVoiceStatus('Received at desktop, transcribing...');
    };
    syncClient.on('voice_received', onVoiceReceived);

    // NOTE: Wake word detection now happens locally on mobile in Wake Mode
    
    // NOTE: Wake word listener already set up at line 603 (wakeSub)
    // No need for duplicate listener here

    const onSendError = (e: any) => {
      if (e?.type === 'audio_input') {
        setChatVoiceStatus(null);
        addLogEntry('Not connected — reconnect and try again', 'error');
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

    return () => {
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

  // Toggle Wake Word Mode - enters fullscreen listening mode with wake word detection
  const toggleWakeWordMode = useCallback(async () => {
    if (!isWakeWordMode) {
      // Entering wake word mode
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

      addLogEntry('🗣️ Wake Word Mode: ACTIVE', 'info');
      addVoiceLog('Wake listening...');

      // Load training features and start DTW sample-match listener
      try {
        const settingsRaw = await AsyncStorage.getItem('cyberclaw-audio-settings').catch(() => null);
        const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey clawsuu') : 'hey clawsuu';
        const trainingJson = await AsyncStorage.getItem(getWakeSamplesKey(phrase)).catch(() => null);
        const training = trainingJson ? JSON.parse(trainingJson) : null;

        if (training?.features?.length) {
          addLogEntry(`🎤 Sample-match listening for: "${phrase}"`, 'info');
          sampleListenerCleanupRef.current?.();
          sampleListenerCleanupRef.current = startSampleMatchListener(
            phrase,
            training.features,
            handleWakeWord,
            (msg) => addLogEntry(msg, 'debug'),
          );
          addVoiceLog(`Matching: "${phrase}"`);
        } else {
          // Fallback to Vosk if no training data
          addLogEntry('No training data — falling back to Vosk', 'error');
          WakeWordModule?.start?.(phrase).catch(() => {});
        }
      } catch (e: any) {
        addLogEntry(`❌ Wake detection start error: ${e?.message}`, 'error');
      }
    } else {
      // Exiting wake word mode
      sampleListenerCleanupRef.current?.();
      sampleListenerCleanupRef.current = null;
      wakeWordBusyRef.current = false;
      try { WakeWordModule?.stop?.(); } catch (_) {}
      try { WakeWordModule?.stopSampleListening?.(); } catch (_) {}
      closeFullscreen();
      addLogEntry('🗣️ Wake Word Mode: OFF', 'info');
    }
    const newMode = !isWakeWordMode;
    isWakeWordModeRef.current = newMode;
    setIsWakeWordMode(newMode);
  }, [isWakeWordMode, closeFullscreen, handleWakeWord]);

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
      setMessages(prev => [...prev, { id: `user-${Date.now()}`, text, isUser: true, ts: Date.now() }]);
      syncClient.sendChat(text);
      addLogEntry(`→ ${text.substring(0, 80)}`, 'sent');
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
  useEffect(() => {
    if (activeTab === 'chat' && messages.length > 0) {
      // Always scroll to bottom when entering chat tab
      setTimeout(() => {
        chatRef.current?.scrollToEnd({ animated: false });
      }, 50);
    }
  }, [activeTab, messages.length]);



  const onChatScroll = useCallback((event: any) => {
    // Just track scroll events, don't interfere with position
  }, []);

  const renderMessage = useCallback(({ item, index }: { item: ChatMessage; index: number }) => {
    if (!item || typeof item.text !== 'string' || !item.ts || typeof item.isUser !== 'boolean') {
      return <View />;
    }
    
    // Show date separator when bucket changes (Today/Yesterday/This Week/Last Week/Older date)
    let showDateSeparator = false;
    if (index === 0 || !messages[index - 1]) {
      showDateSeparator = true;
    } else {
      const prevBucket = getDateBucket(messages[index - 1].ts);
      const currBucket = getDateBucket(item.ts);
      showDateSeparator = prevBucket !== currBucket;
    }
    
    const dateStr = getDateBucketLabel(item.ts);
    
    return (
      <View>
        {showDateSeparator && <Text style={styles.dateSeparator}>{dateStr}</Text>}
        <View style={[styles.messageBubble, item.isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={[styles.agentLabel, item.isUser ? styles.userLabel : styles.aiLabel]}>
            {item.isUser ? '👤 You' : '🐾 Clawsuu'}
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
            <Text style={styles.versionTag}>v2.13.73</Text>
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
            source={{ uri: `file:///android_asset/arena.html?companion=${companionId}` }}
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

      {/* Tab content - Hidden when fullscreen or landscape */}
      {!fullscreen && !isLandscape && (
      <KeyboardAvoidingView style={styles.tabContent} behavior='padding'>
        {activeTab === 'chat' && (
          <>
            <FlatList
              ref={chatRef}
              data={messages}
              keyExtractor={i => i.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.chatList}
              showsVerticalScrollIndicator={true}
              scrollEnabled={true}
              inverted={false}
              onLayout={() => {
                if (messages.length > 0) {
                  setTimeout(() => chatRef.current?.scrollToEnd({ animated: false }), 50);
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
