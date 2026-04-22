/**
 * HomeScreen — CyberClaw mobile companion
 * Arena (real sprites) + Chat/Events/Log tabs + TTS + background service
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Platform, Keyboard, Dimensions, KeyboardAvoidingView, Alert,
  NativeModules, StatusBar, NativeEventEmitter,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import syncClient from '../services/SyncClient';

// Native modules
const { BackgroundService, AppControl, WakeWordModule } = NativeModules;
async function startBgService() {
  try { if (BackgroundService) await BackgroundService.start(); } catch {}
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

export default function HomeScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([...syncLog]);
  const [inputText, setInputText] = useState('');
  const [connState, setConnState] = useState<string>(syncClient.state);
  const [activeTab, setActiveTab] = useState<TabId>('chat');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [lockScreenMode, setLockScreenMode] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const eventsRef = useRef<FlatList>(null);
  const logRef = useRef<FlatList>(null);
  const webViewRef = useRef<WebView>(null);

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

  // When fullscreen closes, restore lock screen flags
  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    setLockScreenMode(false);
    AppControl?.showOnLockScreen?.(false);
    AppControl?.keepScreenOn?.(false);
    const js = `window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})})); document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:false})})); true;`;
    webViewRef.current?.injectJavaScript(js);
  }, []);

  // Open fullscreen from arena WebView message
  const handleArenaMessage = useCallback((e: any) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'fullscreen') {
        setFullscreen(true);
        AppControl?.keepScreenOn?.(true);
        webViewRef.current?.injectJavaScript(`
          window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true})}));
          document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true})}));
          true;
        `);
      }
      if (msg.type === 'exitFullscreen') {
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

  // Wake word → bring to foreground + show zoomed companion on lock screen
  const handleWakeWord = useCallback(() => {
    bringToForeground();
    setFullscreen(true);
    setLockScreenMode(true);
    AppControl?.showOnLockScreen?.(true);
    AppControl?.keepScreenOn?.(true);
    setTimeout(() => {
      const js = `window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})})); document.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'setFullscreen',value:true,focused:true})})); true;`;
      webViewRef.current?.injectJavaScript(js);
    }, 300);
  }, []);

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

  // toggleVoiceInput defined after sendMessage below

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
          addLogEntry(`[wake] Porcupine failed: ${e?.message}, falling back to Vosk`, 'error');
          WakeWordModule?.start?.(phrase).catch(() => {});
        });
        addLogEntry(`[wake] starting Porcupine mode`, 'info');
      } else {
        WakeWordModule?.start?.(phrase).catch(() => {});
        addLogEntry(`[wake] starting, phrase: "${phrase}"`, 'info');
      }
    });

    // Wake word event → bring app to front in focus mode
    const wakeEmitter = WakeWordModule ? new NativeEventEmitter(WakeWordModule) : null;
    const wakeSub = wakeEmitter?.addListener('wakeWordDetected', () => {
      handleWakeWord();
    });
    const debugSub = wakeEmitter?.addListener('wakeWordDebug', (e: any) => {
      const label = e.text ? `${e.state}: "${e.text}"` : e.state;
      setWakeDebug(label);
      // Don't spam 'error' or 'unavailable' to log — show once only
      if (e.state === 'unavailable') {
        addLogEntry(`[wake] Speech Recognition not available on this device`, 'error');
      } else if (e.state !== 'error') {
        addLogEntry(`[wake] ${label}`, 'info');
      }
    });
    const onState = (data: any) => {
      setConnState(data.state);
      addLogEntry(`State → ${data.state}`, 'info');
    };

    const onChat = (msg: any) => {
      if (msg.isUser) return;
      setMessages(prev => {
        const dupe = prev.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text);
        if (dupe) return prev;
        return [...prev, { id: `${msg.ts}-${Math.random()}`, text: msg.text, isUser: false, agentId: msg.agentId, ts: msg.ts }];
      });
      addLogEntry(`← ${msg.text.substring(0, 80)}`, 'received');
      // Always speak if last input was voice; otherwise respect ttsEnabled setting
      if (lastInputWasVoice) {
        speak(msg.text);
        setLastInputWasVoice(false);
      } else {
        speak(msg.text);
      }
    };

    const onTyping = (msg: any) => {
      setIsThinking(!!msg.active);
      setArenaThinking(!!msg.active);
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
        await WakeWordModule.startPlayer(tmpPath);
        addLogEntry('🔊 Playing audio response', 'received');
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
      if (msg.transcript) {
        setInputText(msg.transcript);
        addLogEntry(`🗣️ Transcribed: "${msg.transcript}"`, 'received');
      }
    };
    syncClient.on('voice_transcript_result', onVoiceTranscriptResult);
    onLogEntry(onLogUpdate);

    syncClient.loadSaved().then(({ host }) => {
      if (host) {
        addLogEntry(`Connecting to ${host}...`);
        syncClient.connect().catch(e => addLogEntry(`Connect failed: ${e?.message}`, 'error'));
      }
    });

    return () => {
      wakeSub?.remove();
      debugSub?.remove();
      syncClient.off('state_change', onState);
      syncClient.off('chat', onChat);
      syncClient.off('typing', onTyping);
      syncClient.off('chat_history', onChatHistory);
      syncClient.off('arena', onArena);
      syncClient.off('audio_response', onAudioResponse);
      syncClient.off('voice_transcript_result', onVoiceTranscriptResult);
      offLogEntry(onLogUpdate);
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

  const sendMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isConnected) return;
    setMessages(prev => [...prev, { id: `user-${Date.now()}`, text, isUser: true, ts: Date.now() }]);
    syncClient.sendChat(text);
    addLogEntry(`→ ${text.substring(0, 80)}`, 'sent');
    setInputText('');
  }, [inputText, isConnected]);

  const toggleVoiceInput = useCallback(async () => {
    if (!isConnected) {
      Alert.alert('Not Connected', 'Please connect to your desktop first.');
      return;
    }
    if (isVoiceListening) {
      // Stop recording, resume wake word
      try {
        const result = await WakeWordModule.stopRecorder();
        setIsVoiceListening(false);
        // Resume wake word in correct mode
        const [ppnRaw, modeRaw, settingsRaw] = await Promise.all([
          AsyncStorage.getItem('cyberclaw-ppn-path'),
          AsyncStorage.getItem('cyberclaw-wake-mode'),
          AsyncStorage.getItem('cyberclaw-audio-settings'),
        ]);
        const wakeMode = modeRaw || 'vosk';
        const ppnPath = ppnRaw || '';
        const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey claw') : 'hey claw';
        if (wakeMode === 'porcupine' && ppnPath) {
          WakeWordModule?.startPorcupine?.(ppnPath).catch(() => WakeWordModule?.start?.(phrase));
        } else {
          WakeWordModule?.start?.(phrase).catch(() => {});
        }
        // Read file as base64
        const fs = require('react-native-fs');
        const base64 = await fs.readFile(result, 'base64');
        syncClient.sendAudioInput(base64, 'audio/m4a');
        addLogEntry('🎤 Audio sent to desktop', 'sent');
      } catch (e: any) {
        setIsVoiceListening(false);
        WakeWordModule?.start?.('hey claw').catch(() => {});
        addLogEntry(`Recording error: ${e?.message}`, 'error');
      }
    } else {
      // Pause wake word, start recording
      try {
        WakeWordModule?.stop?.().catch(() => {});
        const fs = require('react-native-fs');
        const recPath = `${fs.TemporaryDirectoryPath}/cyberclaw-voice-${Date.now()}.m4a`;
        await WakeWordModule.startRecorder(recPath);
        setIsVoiceListening(true);
        addLogEntry('🎤 Recording...', 'info');
      } catch (e: any) {
        // Resume wake word on error too
        Promise.all([
          AsyncStorage.getItem('cyberclaw-ppn-path'),
          AsyncStorage.getItem('cyberclaw-wake-mode'),
          AsyncStorage.getItem('cyberclaw-audio-settings'),
        ]).then(([ppn, mode, settingsRaw]) => {
          const phrase = settingsRaw ? (JSON.parse(settingsRaw).wakeWord || 'hey claw') : 'hey claw';
          if (mode === 'porcupine' && ppn) WakeWordModule?.startPorcupine?.(ppn).catch(() => WakeWordModule?.start?.(phrase));
          else WakeWordModule?.start?.(phrase).catch(() => {});
        });
        addLogEntry(`Mic error: ${e?.message}`, 'error');
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
      <StatusBar hidden={fullscreen} />
      {/* Header */}
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

      {/* Arena — expands to fullscreen when fullscreen state is active */}
      {(!keyboardVisible || fullscreen) && (
        <View style={fullscreen
          ? [StyleSheet.absoluteFill, { zIndex: 100 }]
          : { height: ARENA_HEIGHT, borderBottomWidth: 2, borderBottomColor: '#f7931a' }
        }>
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
            <View style={styles.listeningBadge} pointerEvents="none">
              <Text style={styles.listeningText}>Mic: {wakeDebug}</Text>
            </View>
          )}
          {fullscreen && lockScreenMode && (
            <View style={styles.lockBadge}>
              <Text style={styles.lockBadgeText}>🐾 CyberClaw</Text>
            </View>
          )}
        </View>
      )}

      {/* Thinking indicator */}
      {isThinking && (
        <View style={styles.thinkingBar}>
          <Text style={styles.thinkingText}>💭 Clawsuu is thinking...</Text>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabBar}>
        {(['chat', 'events', 'log'] as TabId[]).map(tab => (
          <TouchableOpacity key={tab} style={[styles.tab, activeTab === tab && styles.tabActive]} onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'chat' ? '💬 Chat' : tab === 'events' ? '📜 Events' : '📋 Log'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

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
            {isVoiceListening && (
              <View style={styles.recordingBanner}>
                <Text style={styles.recordingBannerText}>⏹ Recording… tap Stop when done</Text>
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
              <TouchableOpacity
                style={[styles.sendButton, (!inputText.trim() || !isConnected) && styles.sendButtonDisabled]}
                onPress={sendMessage}
                disabled={!inputText.trim() || !isConnected}
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
  lockBadge: {
    position: 'absolute', top: 16, right: 12,
  },
  lockBadgeText: {
    color: 'rgba(247,147,26,0.6)', fontSize: 13,
    fontFamily: 'monospace', letterSpacing: 2,
  },
});
