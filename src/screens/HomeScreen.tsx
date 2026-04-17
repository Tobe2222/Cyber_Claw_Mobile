/**
 * HomeScreen — Main CyberClaw mobile interface
 * Arena on top, tabbed content below (Chat / Events / Log)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
  Keyboard,
  Dimensions,
  KeyboardAvoidingView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import syncClient from '../services/SyncClient';

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
const ARENA_HEIGHT = Math.min(SCREEN_WIDTH * 0.5, 220);
const CHAT_STORAGE_KEY = 'cyberclaw-chat-history';
const LOG_STORAGE_KEY = 'cyberclaw-sync-log';

// Shared log array — accessible from settings too
export const syncLog: LogEntry[] = [];
export function addLogEntry(text: string, type: LogEntry['type'] = 'info') {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${Math.random()}`,
    text,
    ts: Date.now(),
    type,
  };
  syncLog.push(entry);
  if (syncLog.length > 200) syncLog.splice(0, syncLog.length - 200);
  // Notify listeners
  logListeners.forEach(fn => fn(entry));
}
const logListeners: ((entry: LogEntry) => void)[] = [];
export function onLogEntry(fn: (entry: LogEntry) => void) { logListeners.push(fn); }
export function offLogEntry(fn: (entry: LogEntry) => void) {
  const idx = logListeners.indexOf(fn);
  if (idx >= 0) logListeners.splice(idx, 1);
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
  const flatListRef = useRef<FlatList>(null);

  const isConnected = connState === 'connected' || connState === 'reconnecting';

  // Load persisted chat on mount
  useEffect(() => {
    AsyncStorage.getItem(CHAT_STORAGE_KEY).then(raw => {
      if (raw) {
        try { setMessages(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  // Save chat when messages change
  useEffect(() => {
    if (messages.length > 0) {
      // Keep last 100 messages
      const toSave = messages.slice(-100);
      AsyncStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(toSave));
    }
  }, [messages]);

  // Keyboard listeners
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => {
    const onStateChange = (data: any) => {
      setConnState(data.state);
      addLogEntry(`State: ${data.state}`, 'info');
    };

    const onChat = (msg: any) => {
      if (msg.isUser) return; // Don't echo our own messages
      setMessages(prev => {
        const isDupe = prev.some(m => Math.abs(m.ts - msg.ts) < 2000 && m.text === msg.text);
        if (isDupe) return prev;
        return [...prev, {
          id: `${msg.ts}-${Math.random()}`,
          text: msg.text,
          isUser: false,
          agentId: msg.agentId,
          ts: msg.ts,
        }];
      });
      addLogEntry(`← Received: ${msg.text.substring(0, 60)}...`, 'received');
    };

    const onLogUpdate = (entry: LogEntry) => {
      setLogEntries(prev => [...prev, entry]);
    };

    syncClient.on('state_change', onStateChange);
    syncClient.on('chat', onChat);
    onLogEntry(onLogUpdate);

    // Auto-connect
    syncClient.loadSaved().then(({ host }) => {
      if (host) {
        addLogEntry(`Auto-connecting to ${host}...`);
        syncClient.connect().catch((e) => {
          addLogEntry(`Auto-connect failed: ${e?.message || e}`, 'error');
        });
      }
    });

    return () => {
      syncClient.off('state_change', onStateChange);
      syncClient.off('chat', onChat);
      offLogEntry(onLogUpdate);
    };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0 && activeTab === 'chat') {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length, activeTab]);

  const sendMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text || !isConnected) return;

    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      text,
      isUser: true,
      ts: Date.now(),
    }]);

    syncClient.sendChat(text);
    addLogEntry(`→ Sent: ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`, 'sent');
    setInputText('');
  }, [inputText, isConnected]);

  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => (
    <View style={[styles.messageBubble, item.isUser ? styles.userBubble : styles.aiBubble]}>
      {!item.isUser && (
        <Text style={styles.agentLabel}>🐾 Companion</Text>
      )}
      <Text style={[styles.messageText, item.isUser ? styles.userText : styles.aiText]}>
        {item.text}
      </Text>
      <Text style={styles.timestamp}>
        {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  ), []);

  const renderLogEntry = useCallback(({ item }: { item: LogEntry }) => (
    <Text style={[styles.logLine, 
      item.type === 'sent' && styles.logSent,
      item.type === 'received' && styles.logReceived,
      item.type === 'error' && styles.logError,
    ]}>
      [{new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}] {item.text}
    </Text>
  ), []);

  // Arena HTML — no "waiting for connection" text
  const arenaHTML = `
    <!DOCTYPE html>
    <html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0a; overflow: hidden; }
        canvas { display: block; width: 100vw; height: 100vh; }
      </style>
    </head><body>
      <canvas id="arena"></canvas>
      <script>
        const canvas = document.getElementById('arena');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        let companion = { x: canvas.width / 2, y: canvas.height * 0.6, vx: 0.5 };
        function draw() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const horizon = canvas.height * 0.45;
          // Sky
          const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
          skyGrad.addColorStop(0, '#0a0a2e');
          skyGrad.addColorStop(1, '#1a1a3e');
          ctx.fillStyle = skyGrad;
          ctx.fillRect(0, 0, canvas.width, horizon);
          // Ground
          const grad = ctx.createLinearGradient(0, horizon, 0, canvas.height);
          grad.addColorStop(0, '#1a3a1a');
          grad.addColorStop(1, '#0d1f0d');
          ctx.fillStyle = grad;
          ctx.fillRect(0, horizon, canvas.width, canvas.height - horizon);
          // Stars
          ctx.fillStyle = '#fff';
          for (let i = 0; i < 30; i++) {
            ctx.globalAlpha = 0.3 + Math.sin(Date.now() * 0.001 + i) * 0.2;
            ctx.fillRect((i * 137.5) % canvas.width, (i * 73.3) % horizon, 1.5, 1.5);
          }
          ctx.globalAlpha = 1;
          // Companion
          const cx = companion.x, cy = companion.y, r = 20;
          ctx.fillStyle = '#f7931a';
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.arc(cx - 6, cy - 4, 3, 0, Math.PI * 2); ctx.arc(cx + 6, cy - 4, 3, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy + 3, 5, 0, Math.PI); ctx.stroke();
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.beginPath(); ctx.ellipse(cx, cy + r + 3, r * 0.8, 4, 0, 0, Math.PI * 2); ctx.fill();
          companion.x += companion.vx;
          if (companion.x > canvas.width - 30 || companion.x < 30) companion.vx *= -1;
          requestAnimationFrame(draw);
        }
        draw();
      </script>
    </body></html>
  `;

  const statusLabel = connState === 'connected' ? 'Connected' :
    connState === 'reconnecting' ? 'Connected' :
    connState === 'connecting' ? 'Connecting...' :
    connState === 'lost' ? 'Connection lost' : 'Disconnected';

  return (
    <View style={styles.container}>
      {/* Header bar: title + status + settings */}
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

      {/* Arena — hide when keyboard is open to give more chat space */}
      {!keyboardVisible && (
        <View style={[styles.arenaContainer, { height: ARENA_HEIGHT }]}>
          <WebView
            source={{ html: arenaHTML }}
            style={styles.arena}
            scrollEnabled={false}
            bounces={false}
            javaScriptEnabled
          />
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabBar}>
        {(['chat', 'events', 'log'] as TabId[]).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'chat' ? '💬 Chat' : tab === 'events' ? '📜 Events' : '📋 Log'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Tab content */}
      <KeyboardAvoidingView
        style={styles.tabContent}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {activeTab === 'chat' && (
          <>
            <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={item => item.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.chatList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <Text style={styles.emptyChatText}>
                    {isConnected ? "Say hi to your companion! 🐾" : "Connect to desktop CyberClaw to start chatting"}
                  </Text>
                </View>
              }
            />
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                value={inputText}
                onChangeText={setInputText}
                placeholder={isConnected ? "Type a message..." : "Not connected"}
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
          <View style={styles.eventsContainer}>
            {events.length === 0 ? (
              <Text style={styles.emptyChatText}>No events yet</Text>
            ) : (
              <FlatList
                data={events}
                keyExtractor={(_, i) => `ev-${i}`}
                renderItem={({ item }) => <Text style={styles.eventLine}>{item}</Text>}
              />
            )}
          </View>
        )}

        {activeTab === 'log' && (
          <FlatList
            data={logEntries}
            keyExtractor={item => item.id}
            renderItem={renderLogEntry}
            contentContainerStyle={styles.logList}
            showsVerticalScrollIndicator={false}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 44,
    paddingBottom: 10,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
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
  arenaContainer: { borderBottomWidth: 2, borderBottomColor: '#f7931a' },
  arena: { flex: 1, backgroundColor: '#0a0a0a' },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  tab: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
  },
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
  eventsContainer: { flex: 1, padding: 12 },
  eventLine: { color: '#aaa', fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  logList: { padding: 12 },
  logLine: { color: '#8a8', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  logSent: { color: '#4a9eff' },
  logReceived: { color: '#4ade80' },
  logError: { color: '#ef4444' },
});
