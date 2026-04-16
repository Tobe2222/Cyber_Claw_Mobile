/**
 * HomeScreen — Main CyberClaw mobile interface
 * Arena (WebView) on top, chat below
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Dimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import syncClient from '../services/SyncClient';

interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  agentId?: string;
  ts: number;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ARENA_HEIGHT = Math.min(SCREEN_WIDTH * 0.6, 280);

export default function HomeScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    // Set up sync client handlers
    const onConnected = () => setConnected(true);
    const onDisconnected = () => { setConnected(false); setAuthenticated(false); };
    const onAuthenticated = () => setAuthenticated(true);
    const onChat = (msg: any) => {
      setMessages(prev => [...prev, {
        id: `${msg.ts}-${Math.random()}`,
        text: msg.text,
        isUser: msg.isUser,
        agentId: msg.agentId,
        ts: msg.ts,
      }]);
    };

    syncClient.on('connected', onConnected);
    syncClient.on('disconnected', onDisconnected);
    syncClient.on('authenticated', onAuthenticated);
    syncClient.on('chat', onChat);

    // Auto-connect if saved (silently — don't crash on bad saved IP)
    syncClient.loadSaved().then(({ host, token }) => {
      if (host) {
        syncClient.connect().catch((e) => {
          console.log('[HomeScreen] Auto-connect failed:', e);
        });
      }
    });

    return () => {
      syncClient.off('connected', onConnected);
      syncClient.off('disconnected', onDisconnected);
      syncClient.off('authenticated', onAuthenticated);
      syncClient.off('chat', onChat);
    };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const sendMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;

    // Add to local messages immediately
    setMessages(prev => [...prev, {
      id: `user-${Date.now()}`,
      text,
      isUser: true,
      ts: Date.now(),
    }]);

    // Send to desktop via sync
    syncClient.sendChat(text);
    setInputText('');
    Keyboard.dismiss();
  }, [inputText]);

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

  // Arena HTML — loads the pixel arena in a WebView
  const arenaHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0a; overflow: hidden; }
        canvas { display: block; width: 100vw; height: 100vh; }
        .status {
          position: absolute; top: 8px; left: 8px;
          color: #666; font-size: 11px; font-family: monospace;
        }
        .status.connected { color: #4ade80; }
      </style>
    </head>
    <body>
      <div class="status" id="status">Waiting for connection...</div>
      <canvas id="arena"></canvas>
      <script>
        const canvas = document.getElementById('arena');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Placeholder arena with a simple companion sprite
        let companion = { x: canvas.width / 2, y: canvas.height * 0.6, vx: 0.5, frame: 0 };
        
        function draw() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          // Ground
          const horizon = canvas.height * 0.45;
          const grad = ctx.createLinearGradient(0, horizon, 0, canvas.height);
          grad.addColorStop(0, '#1a3a1a');
          grad.addColorStop(1, '#0d1f0d');
          ctx.fillStyle = grad;
          ctx.fillRect(0, horizon, canvas.width, canvas.height - horizon);
          
          // Sky
          const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
          skyGrad.addColorStop(0, '#0a0a2e');
          skyGrad.addColorStop(1, '#1a1a3e');
          ctx.fillStyle = skyGrad;
          ctx.fillRect(0, 0, canvas.width, horizon);
          
          // Stars
          ctx.fillStyle = '#fff';
          for (let i = 0; i < 30; i++) {
            const sx = (i * 137.5) % canvas.width;
            const sy = (i * 73.3) % horizon;
            ctx.globalAlpha = 0.3 + Math.sin(Date.now() * 0.001 + i) * 0.2;
            ctx.fillRect(sx, sy, 1.5, 1.5);
          }
          ctx.globalAlpha = 1;
          
          // Companion (placeholder circle with eyes)
          const cx = companion.x;
          const cy = companion.y;
          const r = 20;
          
          ctx.fillStyle = '#f7931a';
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
          
          // Eyes
          ctx.fillStyle = '#000';
          ctx.beginPath();
          ctx.arc(cx - 6, cy - 4, 3, 0, Math.PI * 2);
          ctx.arc(cx + 6, cy - 4, 3, 0, Math.PI * 2);
          ctx.fill();
          
          // Mouth
          ctx.beginPath();
          ctx.arc(cx, cy + 3, 5, 0, Math.PI);
          ctx.stroke();
          
          // Shadow
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.beginPath();
          ctx.ellipse(cx, cy + r + 3, r * 0.8, 4, 0, 0, Math.PI * 2);
          ctx.fill();
          
          // Move
          companion.x += companion.vx;
          if (companion.x > canvas.width - 30 || companion.x < 30) {
            companion.vx *= -1;
          }
          
          requestAnimationFrame(draw);
        }
        draw();

        // Listen for state updates from React Native
        window.addEventListener('message', (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'connection_status') {
              const el = document.getElementById('status');
              el.textContent = msg.connected ? '● Connected' : '○ Disconnected';
              el.className = msg.connected ? 'status connected' : 'status';
            }
          } catch {}
        });
      </script>
    </body>
    </html>
  `;

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Connection status bar */}
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>
          🐾 CyberClaw
        </Text>
        <View style={[styles.statusDot, connected && authenticated ? styles.dotOnline : styles.dotOffline]} />
        <Text style={styles.statusLabel}>
          {!connected ? 'Disconnected' : !authenticated ? 'Connecting...' : 'Connected'}
        </Text>
      </View>

      {/* Arena */}
      <View style={[styles.arenaContainer, { height: ARENA_HEIGHT }]}>
        <WebView
          ref={webViewRef}
          source={{ html: arenaHTML }}
          style={styles.arena}
          scrollEnabled={false}
          bounces={false}
          javaScriptEnabled
          onMessage={(event) => {
            // Handle messages from arena WebView
            try {
              const msg = JSON.parse(event.nativeEvent.data);
              console.log('Arena message:', msg);
            } catch {}
          }}
        />
      </View>

      {/* Chat */}
      <View style={styles.chatContainer}>
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
                {authenticated 
                  ? "Say hi to your companion! 🐾" 
                  : "Connect to your desktop CyberClaw to start chatting"}
              </Text>
            </View>
          }
        />
      </View>

      {/* Input */}
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder={authenticated ? "Type a message..." : "Not connected"}
          placeholderTextColor="#555"
          editable={authenticated}
          multiline
          maxLength={2000}
          onSubmitEditing={sendMessage}
          blurOnSubmit
        />
        <TouchableOpacity 
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]} 
          onPress={sendMessage}
          disabled={!inputText.trim() || !authenticated}
        >
          <Text style={styles.sendButtonText}>▶</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 50 : 10,
    paddingBottom: 8,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  statusText: {
    color: '#f7931a',
    fontSize: 16,
    fontWeight: 'bold',
    flex: 1,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  dotOnline: { backgroundColor: '#4ade80' },
  dotOffline: { backgroundColor: '#666' },
  statusLabel: {
    color: '#888',
    fontSize: 12,
  },
  arenaContainer: {
    borderBottomWidth: 2,
    borderBottomColor: '#f7931a',
  },
  arena: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  chatContainer: {
    flex: 1,
  },
  chatList: {
    padding: 12,
    paddingBottom: 8,
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#1a3a5c',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1a2e',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#333',
  },
  agentLabel: {
    color: '#f7931a',
    fontSize: 11,
    marginBottom: 4,
    fontWeight: 'bold',
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  userText: { color: '#e0e0e0' },
  aiText: { color: '#ccc' },
  timestamp: {
    color: '#555',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  emptyChat: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 40,
  },
  emptyChatText: {
    color: '#555',
    fontSize: 14,
    textAlign: 'center',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#222',
    backgroundColor: '#111',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#333',
  },
  sendButton: {
    marginLeft: 8,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f7931a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#333',
  },
  sendButtonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
