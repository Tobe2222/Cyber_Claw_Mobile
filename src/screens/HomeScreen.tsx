/**
 * HomeScreen — CyberClaw mobile companion
 * Arena (real sprites) + Chat/Events/Log tabs + TTS + background service
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Platform, Keyboard, Dimensions, KeyboardAvoidingView, Alert,
  NativeModules, StatusBar, NativeEventEmitter, BackHandler, AppState,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import syncClient from '../services/SyncClient';
import { getSimpleAudioRecorder, disposeSimpleAudioRecorder } from '../services/SimpleAudioRecorder';

// Native modules
const { BackgroundService, AppControl, WakeWordModule } = NativeModules;
async function startBgService() {
  try {
    const enabled = await AsyncStorage.getItem('cyberclaw-bg-listening');
    if (enabled !== 'false' && BackgroundService) await BackgroundService.start();
  } catch {}
}
async function bringToForeground() {
  try { if (AppControl) await AppControl.bringToForeground(); } catch {}
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
  const [connState, setConnState] = useState<string>(syncClient.state);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [chatVoiceStatus, setChatVoiceStatus] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [lockScreenMode, setLockScreenMode] = useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<string>('idle');
  const flatListRef = useRef<FlatList>(null);
  const eventsRef = useRef<FlatList>(null);
  const logRef = useRef<FlatList>(null);
  const webViewRef = useRef<WebView>(null);
  const fullscreenRef = useRef(false);
  const isWakeWordStoppedRef = useRef<boolean>(true);

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // Speak via WebView TTS
  const speak = useCallback((text: string) => {
    if (!ttsEnabled || !webViewRef.current) return;
    const escaped = text.replace(/'/g, "\\'").replace(/\n/g, ' ');
    webViewRef.current.injectJavaScript(`
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('${escaped}');
        u.rate = 0.95;
        u.pitch = 1.1;
        window.speechSynthesis.speak(u);
      }
      true;
    `);
  }, [ttsEnabled]);

  // Propagate thinking state to both WebViews
  const setArenaThinking = useCallback((active: boolean) => {
    const js = `window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: ${false} }) })); document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: ${false} }) })); true;`;
    const jsActive = `window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: true }) })); document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: true }) })); true;`;
    const jsInactive = `window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: false }) })); document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'thinking', active: false }) })); true;`;
    const inject = active ? jsActive : jsInactive;
    webViewRef.current?.injectJavaScript(inject);
  }, []);

  // Close fullscreen mode and reset state
  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    fullscreenRef.current = false;
    AppControl?.keepScreenOn?.(false);
    const js = `window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})})); document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})})); true;`;
    webViewRef.current?.injectJavaScript(js);
    addLogEntry('[voice] Exited voice mode', 'info');
  }, []);

  // Simplified enterVoiceMode - only handles wakeword wake-up
  const enterVoiceMode = useCallback(async (source: 'wakeword' | 'focus' = 'focus') => {
    if (source === 'wakeword') {
      bringToForeground();
      AppControl?.showOnLockScreenWithDismiss?.();
      AppControl?.keepScreenOn?.(true);
      setFullscreen(true);  // Set state so overlay renders
      fullscreenRef.current = true;
      addLogEntry('[voice] Entering voice mode', 'info');
      
      // Tell arena to enter focus mode
      webViewRef.current?.injectJavaScript(`
        window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})}));
        document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})}));
        true;
      `);
      
      // Auto-start listening with SimpleAudioRecorder + countdown on silence
      try {
        const fs = require('react-native-fs');
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.m4a`;
        const recorder = getSimpleAudioRecorder();
        
        // FIXED: Track whether we've transitioned to 'recording' state
        let hasTransitionedToRecording = false;
        
        // Set up silence detection: start countdown and auto-send
        let countdownInterval: NodeJS.Timeout | null = null;
        let silenceEventFired = false;
        let maxDurationTimeout: NodeJS.Timeout | null = null;
        
        const unsubSilence = recorder.once('silence', async () => {
          silenceEventFired = true;
          addLogEntry('[voice] Silence detected after 5s', 'info');
          setVoiceStatus('silence_countdown');
          let count = 3;
          setSilenceCountdown(count);
          
          countdownInterval = setInterval(() => {
            count--;
            setSilenceCountdown(count);
            if (count <= 0) {
              if (countdownInterval) clearInterval(countdownInterval);
              if (maxDurationTimeout) clearTimeout(maxDurationTimeout);
              addLogEntry('[voice] Countdown complete, sending audio', 'info');
              // Auto-stop and send
              recorder.stop().then(async (resultPath: string) => {
                setIsVoiceListening(false);
                if (!resultPath) {
                  setVoiceStatus('idle');
                  addLogEntry('[voice] No recording path returned', 'error');
                  return;
                }
                try {
                  const stats = await fs.stat(resultPath);
                  addLogEntry(`[voice] Audio file: ${stats.size} bytes`, 'info');
                  const base64 = await fs.readFile(resultPath, 'base64');
                  addLogEntry(`[voice] Base64 size: ${base64.length} chars`, 'info');
                  if (base64.length < 100) {
                    addLogEntry('[voice] ⚠️ Base64 audio very small', 'error');
                  }
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
            addLogEntry('[voice] Audio detection timeout - status: recording', 'info');
          }
        }, 500);
        
        // FIXED #2: Add max duration fallback (30s)
        // If silence event doesn't fire after 30s, auto-stop and send
        maxDurationTimeout = setTimeout(() => {
          if (!silenceEventFired && isVoiceListening) {
            addLogEntry('[voice] ⚠️ Max duration (30s) reached - silence event may not have fired', 'error');
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
                setVoiceStatus('transcribing');
                syncClient.sendAudioInput(base64, 'audio/m4a');
                addLogEntry('[voice] Forced send after max duration', 'sent');
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
    }
  }, []);

  // Handle messages from arena (companion screen)
  const handleArenaMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'fullscreen') {
        // Ignore fullscreen request if already recording in chat mode
        if (isVoiceListening) {
          addLogEntry('Ignored: Voice fullscreen blocked during chat recording', 'info');
          return;
        }
        // User clicked Voice button in arena → enter fullscreen
        setFullscreen(true);
        fullscreenRef.current = true;
        AppControl?.keepScreenOn?.(true);
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
  }, [closeFullscreen]);

  // Handle Android back button in fullscreen mode
  useEffect(() => {
    if (!fullscreen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeFullscreen();
      return true;
    });
    return () => subscription.remove();
  }, [fullscreen, closeFullscreen]);

  // Wake word → enter voice mode with lock screen
  const handleWakeWord = useCallback(async () => {
    await enterVoiceMode('wakeword');
  }, [enterVoiceMode]);

  // Load persisted chat
  useEffect(() => {
    AsyncStorage.getItem(CHAT_STORAGE_KEY).then(raw => {
      if (raw) { try { setMessages(JSON.parse(raw)); } catch {} }
    });
    AsyncStorage.getItem('cyberclaw-tts-enabled').then(v => {
      if (v !== null) setTtsEnabled(v === 'true');
    });
  }, []);

  // Persist chat
  useEffect(() => {
    if (messages.length > 0) {
      AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-100)));
    }
  }, [messages]);

  // Keyboard
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const [wakeDebug, setWakeDebug] = useState<string>('init');
  const [wakePhrase, setWakePhrase] = useState<string>('hey claw');
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const [pendingAudioPath, setPendingAudioPath] = useState<string | null>(null);

  // toggleVoiceInput defined after sendMessage below

  // AppState listener to manage wake word based on app foreground/background
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        // App came to foreground → STOP wake word ONCE (unless already stopped)
        if (!isWakeWordStoppedRef.current) {
          WakeWordModule?.stop?.().catch(() => {});
          isWakeWordStoppedRef.current = true;
          addLogEntry('[lifecycle] App in foreground', 'info');
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App went to background → START wake word ONCE (unless in fullscreen/voice mode)
        if (isWakeWordStoppedRef.current && !fullscreenRef.current) {
          Promise.all([
            AsyncStorage.getItem('cyberclaw-audio-settings'),
            AsyncStorage.getItem('cyberclaw-ppn-path'),
            AsyncStorage.getItem('cyberclaw-wake-mode'),
          ]).then(([settingsRaw, ppnPath, wakeModeRaw]) => {
            const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
            const ppn = ppnPath || '';
            const wakeMode = wakeModeRaw || 'vosk';
            const phrase = settings.wakeWord || 'hey claw';
            if (wakeMode === 'porcupine' && ppn) {
              WakeWordModule?.startPorcupine?.(ppn).catch((e: any) => {
                WakeWordModule?.start?.(phrase).catch(() => {});
              });
            } else {
              WakeWordModule?.start?.(phrase).catch(() => {});
            }
            isWakeWordStoppedRef.current = false;
            addLogEntry('[lifecycle] App in background', 'info');
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
    ]).then(([settingsRaw, ppnPath, wakeModeRaw]) => {
      const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
      const ppn = ppnPath || '';
      const wakeMode = wakeModeRaw || 'vosk';
      const phrase = settings.wakeWord || 'hey claw';
      setWakePhrase(phrase);
      if (wakeMode === 'porcupine' && ppn) {
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
    const wakeEmitter = WakeWordModule ? new NativeEventEmitter(WakeWordModule) : null;
    const wakeSub = wakeEmitter?.addListener('wakeWordDetected', () => {
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
    const debugSub = wakeEmitter?.addListener('wakeWordDebug', (e: any) => {
      const label = e.text ? `${e.state}: "${e.text}"` : e.state;
      setWakeDebug(label);
      // Don't spam 'error' or 'unavailable' to log — show once only
      if (e.state === 'unavailable') {
        addLogEntry(`Speech Recognition not available on this device`, 'error');
      } else if (e.state !== 'error') {
        addLogEntry(`Wake word: ${label}`, 'info');
      }
    });
    const onState = (data: any) => {
      setConnState(data.state);
      addLogEntry(`State → ${data.state}`, 'info');
    };

    const onChat = (msg: any) => {
      if (msg.isUser) return;
      setChatVoiceStatus(null); // clear status when response arrives
      setMessages(prev => {
        const dupe = prev.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text);
        if (dupe) return prev;
        return [...prev, { id: `${msg.ts}-${Math.random()}`, text: msg.text, isUser: false, agentId: msg.agentId, ts: msg.ts }];
      });
      addLogEntry(`← ${msg.text.substring(0, 80)}`, 'received');
      speak(msg.text);
    };

    const onTyping = (msg: any) => {
      setIsThinking(!!msg.active);
      setArenaThinking(!!msg.active);
      if (!fullscreenRef.current && msg.active) setChatVoiceStatus('🧠 Clawsuu is thinking...');
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
      try {
        if (!msg.audioBase64) return;
        const fs = require('react-native-fs');
        const ext = (msg.mimeType && msg.mimeType.includes('wav')) ? 'wav' : 'mp3';
        const tmpPath = `${fs.TemporaryDirectoryPath}/cyberclaw-response-${Date.now()}.${ext}`;
        await fs.writeFile(tmpPath, msg.audioBase64, 'base64');
        
        // If in voice mode, set status to 'playing'
        if (fullscreenRef.current) {
          setVoiceStatus('playing');
          addLogEntry('[voice] Response audio status: playing', 'info');
        }
        
        await WakeWordModule.startPlayer(tmpPath);
        addLogEntry('🔊 Playing audio response', 'received');
        
        // After playback, if still in voice mode, restart listening loop
        if (fullscreenRef.current) {
          addLogEntry('[voice] Playback finished, restarting listening loop', 'info');
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
              addLogEntry('[voice] Silence detected in loop', 'info');
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
                  addLogEntry('[voice] Loop countdown complete, sending audio', 'info');
                  // FIXED: Actually stop and send audio
                  try {
                    const resultPath = await recorder.stop();
                    if (!resultPath) {
                      addLogEntry('[voice] No recording path returned in loop', 'error');
                      setVoiceStatus('listening');
                      return;
                    }
                    const stats = await fs.stat(resultPath);
                    addLogEntry(`[voice] Loop audio file: ${stats.size} bytes`, 'info');
                    const base64 = await fs.readFile(resultPath, 'base64');
                    addLogEntry(`[voice] Loop base64 size: ${base64.length} chars`, 'info');
                    if (base64.length < 100) {
                      addLogEntry('[voice] ⚠️ Loop base64 audio very small', 'error');
                    }
                    setVoiceStatus('transcribing');
                    addLogEntry('[voice] Loop: sending audio', 'sent');
                    syncClient.sendAudioInput(base64, 'audio/m4a');
                  } catch (e: any) {
                    addLogEntry(`[voice] Loop send error: ${e?.message}`, 'error');
                    setVoiceStatus('listening');
                  }
                }
              }, 1000);
            });
            
            // FIXED #1: Add audio detection timer for loop
            audioDetectTimer = setTimeout(() => {
              if (!hasTransitionedToRecording && fullscreenRef.current) {
                hasTransitionedToRecording = true;
                setVoiceStatus('recording');
                addLogEntry('[voice] Loop: audio detection - status: recording', 'info');
              }
            }, 500);
            
            // FIXED #2: Add max duration fallback for loop
            maxDurationTimeout = setTimeout(() => {
              if (!silenceEventFired && isVoiceListening) {
                addLogEntry('[voice] ⚠️ Loop: Max duration (30s) reached - forcing send', 'error');
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
                    addLogEntry('[voice] Loop: forced send after max duration', 'sent');
                  } catch (e: any) {
                    setVoiceStatus('listening');
                    addLogEntry(`[voice] Loop: send error after timeout: ${e?.message}`, 'error');
                  }
                }).catch((e: any) => {
                  setIsVoiceListening(false);
                  setVoiceStatus('listening');
                  addLogEntry(`[voice] Loop: stop error: ${e?.message}`, 'error');
                });
              }
            }, 30000);
            
            await recorder.start(recPath, 5000);
            addLogEntry('[voice] Loop: listening restarted', 'info');
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
    syncClient.on('typing', onTyping);
    syncClient.on('chat_history', onChatHistory);
    syncClient.on('arena', onArena);
    syncClient.on('audio_response', onAudioResponse);
    const onVoiceTranscriptResult = (msg: any) => {
      if (!msg.transcript) {
        setChatVoiceStatus(null);
        addLogEntry('⚠️ No speech detected', 'error');
        return;
      }
      addLogEntry(`🗣️ Transcribed: "${msg.transcript}"`, 'received');
      // Add to messages and auto-send
      setMessages(prev => [...prev, { id: `user-${Date.now()}`, text: msg.transcript, isUser: true, ts: Date.now() }]);
      setChatVoiceStatus('🧠 Clawsuu is thinking...');
      syncClient.sendChat(msg.transcript);
    };
    syncClient.on('voice_transcript_result', onVoiceTranscriptResult);

    const onVoiceReceived = () => {
      setChatVoiceStatus('💻 Received at desktop, transcribing...');
    };
    syncClient.on('voice_received', onVoiceReceived);

    const onSendError = (e: any) => {
      if (e?.type === 'audio_input') {
        setChatVoiceStatus(null);
        addLogEntry('❌ Not connected — reconnect and try again', 'error');
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
      wakeSub?.remove();
      wakeOpenSub?.remove();
      debugSub?.remove();
      syncClient.off('state_change', onState);
      syncClient.off('chat', onChat);
      syncClient.off('typing', onTyping);
      syncClient.off('chat_history', onChatHistory);
      syncClient.off('arena', onArena);
      syncClient.off('audio_response', onAudioResponse);
      syncClient.off('voice_transcript_result', onVoiceTranscriptResult);
      syncClient.off('voice_received', onVoiceReceived);
      syncClient.off('send_error', onSendError);
      offLogEntry(onLogUpdate);
      disposeSimpleAudioRecorder();
    };
  }, [speak, setArenaThinking]);

  // Scroll to bottom
  useEffect(() => {
    if (messages.length > 0 && activeTab === 'chat') {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      setTimeout(() => logRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [messages.length, activeTab]);

  const [lastInputWasVoice, setLastInputWasVoice] = useState(false);
  const appStateRef = useRef<string>(AppState.currentState);

  const handleAttach = useCallback(() => {
    Alert.alert('Attach', 'Choose source', [
      { text: 'Camera', onPress: () => launchCamera({ mediaType: 'mixed', quality: 0.8 }, (res) => {
        if (res.assets?.[0]) {
          const asset = res.assets[0];
          addLogEntry(`[attach] ${asset.fileName} (${asset.type})`, 'info');
          syncClient.sendChat(`[Image: ${asset.fileName}]`);
        }
      })},
      { text: 'Gallery', onPress: () => launchImageLibrary({ mediaType: 'mixed', selectionLimit: 1 }, (res) => {
        if (res.assets?.[0]) {
          const asset = res.assets[0];
          addLogEntry(`[attach] ${asset.fileName} (${asset.type})`, 'info');
          syncClient.sendChat(`[Image: ${asset.fileName}]`);
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
        setMessages(prev => [...prev, { id: `user-${Date.now()}`, text: '🎤 Voice message', isUser: true, ts: Date.now() }]);
        setChatVoiceStatus('📤 Sending to desktop...');
        syncClient.sendAudioInput(base64, 'audio/m4a');
        addLogEntry('🎤 Voice message sent', 'sent');
        setPendingAudioPath(null);
        // Status will update via mobile-voice-incoming / transcript events
      } catch (e: any) {
        setChatVoiceStatus(null);
        addLogEntry(`Send error: ${e?.message}`, 'error');
      }
      return;
    }
    const text = inputText.trim();
    if (!text) return;
    setMessages(prev => [...prev, { id: `user-${Date.now()}`, text, isUser: true, ts: Date.now() }]);
    syncClient.sendChat(text);
    addLogEntry(`→ ${text.substring(0, 80)}`, 'sent');
    setInputText('');
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
        addLogEntry('[voice] Chat mic stopped, wake word managed by AppState', 'info');
      } catch (e: any) {
        setIsVoiceListening(false);
        addLogEntry(`Stop recording error: ${e?.message}`, 'error');
      }
    } else {
      // Discard any pending audio, PAUSE wake word, start recording with SimpleAudioRecorder
      setPendingAudioPath(null);
      try {
        // PAUSE wake word while recording in chat - prevent conflicts
        WakeWordModule?.stop?.().catch(() => {});
        
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
            setChatVoiceStatus('🎤 Ready to send');
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
            addLogEntry('[voice] Restarting voice loop (wake word stays paused)', 'info');
          } catch (e: any) {
            addLogEntry(`Error after silence: ${e?.message}`, 'error');
          }
        });
        
        await recorder.start(recPath, 5000);
        setIsVoiceListening(true);
        setVoiceStatus('recording');
        setChatVoiceStatus('🔴 Recording...');
        addLogEntry('Recording started', 'info');
      } catch (e: any) {
        addLogEntry(`Microphone error: ${e?.message}`, 'error');
        Alert.alert('Microphone Error', e?.message || 'Could not start recording');
      }
    }
  }, [isConnected, isVoiceListening]);

  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => (
    <View style={[styles.messageBubble, item.isUser ? styles.userBubble : styles.aiBubble]}>
      {!item.isUser && <Text style={styles.agentLabel}>🐾 Clawsuu</Text>}
      <Text style={[styles.messageText, item.isUser ? styles.userText : styles.aiText]}>{item.text}</Text>
      <Text style={styles.timestamp}>{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
    </View>
  ), []);

  const renderLog = useCallback(({ item }: { item: LogEntry }) => (
    <Text style={[styles.logLine,
      item.type === 'sent' && styles.logSent,
      item.type === 'received' && styles.logReceived,
      item.type === 'error' && styles.logError,
    ]}>
      [{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] {item.text}
    </Text>
  ), []);

  const statusLabel = connState === 'connected' ? 'Connected' :
    connState === 'reconnecting' ? 'Connected' :
    connState === 'connecting' ? 'Connecting...' :
    connState === 'lost' ? 'Lost' : 'Offline';

  return (
    <View style={styles.container}>
      <StatusBar hidden={false} />
      {/* Header */}
      {!fullscreen && (
        <View style={styles.headerBar}>
          <Text style={styles.headerTitle}>🐾 CyberClaw</Text>
          <View style={styles.headerRight}>
            <View style={[styles.statusDot, isConnected ? styles.dotOnline : connState === 'lost' ? styles.dotLost : styles.dotOffline]} />
            <Text style={styles.statusLabel}>{statusLabel}</Text>
            <TouchableOpacity style={styles.settingsBtn} onPress={onOpenSettings}>
              <Text style={styles.settingsIcon}>⚙️</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Arena - Conditional rendering based on fullscreen */}
      {!keyboardVisible && (
        <View style={fullscreen ? [StyleSheet.absoluteFill, { zIndex: 100 }] : { height: ARENA_HEIGHT, borderBottomWidth: 2, borderBottomColor: '#f7931a' }}>
          <WebView
            ref={webViewRef}
            source={{ uri: 'file:///android_asset/arena.html' }}
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
          {fullscreen && (
            <TouchableOpacity style={styles.voiceModeCloseBtn} onPress={closeFullscreen} hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}>
              <Text style={styles.voiceModeBtnText}>✕</Text>
            </TouchableOpacity>
          )}
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
        </View>
      )}

      {/* Thinking indicator - Hidden when fullscreen */}
      {!fullscreen && isThinking && (
        <View style={styles.thinkingBar}>
          <Text style={styles.thinkingText}>💭 Clawsuu is thinking...</Text>
        </View>
      )}

      {/* Tabs - Hidden when fullscreen */}
      {!fullscreen && (
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

      {/* Tab content - Hidden when fullscreen */}
      {!fullscreen && (
      <KeyboardAvoidingView style={styles.tabContent} behavior='padding'>
        {activeTab === 'chat' && (
          <>
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={i => i.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.chatList}
              showsVerticalScrollIndicator={false}
              onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>
                    {isConnected ? "Say hi to Clawsuu! 🐾" : "Connect to desktop CyberClaw to chat"}
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
              <TouchableOpacity style={styles.wakeTestBtn} onPress={() => {
                addLogEntry('[wake] test button pressed', 'info');
                WakeWordModule?.test?.().catch((e: any) => addLogEntry(`[wake] test error: ${e?.message}`, 'error'));
              }}>
                <Text style={styles.wakeTestBtnText}>test wake</Text>
              </TouchableOpacity>
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
  wakeTestBtn: {
    backgroundColor: 'rgba(247,147,26,0.15)', borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 6,
    borderWidth: 1, borderColor: 'rgba(247,147,26,0.6)',
    minWidth: 80, alignItems: 'center',
  },
  wakeTestBtnText: { color: '#f7931a', fontSize: 12, fontWeight: '600' },
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
  messageBubble: { maxWidth: '85%', padding: 10, borderRadius: 12, marginBottom: 8 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#1a3a5c', borderBottomRightRadius: 4 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: '#1a1a2e', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#333' },
  agentLabel: { color: '#f7931a', fontSize: 11, marginBottom: 4, fontWeight: 'bold' },
  messageText: { fontSize: 15, lineHeight: 20 },
  userText: { color: '#e0e0e0' },
  aiText: { color: '#ccc' },
  timestamp: { color: '#555', fontSize: 10, marginTop: 4, textAlign: 'right' },
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
  eventLine: { color: '#aaa', fontSize: 12, fontFamily: 'monospace', lineHeight: 18, marginBottom: 4 },
  logList: { padding: 12 },
  logLine: { color: '#8a8', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  logSent: { color: '#4a9eff' },
  logReceived: { color: '#4ade80' },
  logError: { color: '#ef4444' },
  // Fullscreen modal
  fsContainer: { flex: 1, backgroundColor: '#0a0a2e' },
  fsControls: {
    position: 'absolute', top: 40, right: 12,
    flexDirection: 'row', gap: 8,
  },
  fsBtn: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8,
    width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(247,147,26,0.3)',
  },
  fsBtnText: { color: '#f7931a', fontSize: 16 },
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
  recordingBanner: {
    backgroundColor: 'rgba(239,68,68,0.15)', borderTopWidth: 1, borderTopColor: 'rgba(239,68,68,0.4)',
    paddingVertical: 6, alignItems: 'center',
  },
  recordingBannerText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },
  listeningBadge: {
    position: 'absolute', top: 16, left: 12,
    pointerEvents: 'none',
  },
  listeningText: {
    color: 'rgba(74,222,128,0.9)', fontSize: 10, fontFamily: 'monospace',
    backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 8,
  },
  voicePipelineOverlay: {
    position: 'absolute',
    top: 60,
    left: 0, right: 0,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  voicePipelineText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    overflow: 'hidden',
    textAlign: 'center',
  },
  lockBadge: {
    position: 'absolute', top: 16, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
  },
  lockBadgeText: {
    color: 'rgba(247,147,26,0.6)', fontSize: 13,
    fontFamily: 'monospace', letterSpacing: 2,
  },
  // Voice Mode Button
  voiceModeBtn: {
    marginHorizontal: 12, marginVertical: 8,
    backgroundColor: 'rgba(247,147,26,0.2)',
    borderWidth: 1, borderColor: '#f7931a',
    borderRadius: 8, paddingVertical: 10,
    alignItems: 'center',
  },
  voiceModeBtnText: {
    color: '#f7931a', fontSize: 14, fontWeight: '600',
  },
  // Voice Log Container (fullscreen)
  voiceLogContainer: {
    position: 'absolute', bottom: 60, right: 12,
    width: 160, maxHeight: 140,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderWidth: 1, borderColor: 'rgba(247,147,26,0.3)',
    borderRadius: 8, padding: 8,
  },
  voiceLogLine: {
    color: '#888', fontSize: 10, fontFamily: 'monospace',
    lineHeight: 14, marginBottom: 2,
  },
  voiceLogError: { color: '#ef4444' },
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
});
