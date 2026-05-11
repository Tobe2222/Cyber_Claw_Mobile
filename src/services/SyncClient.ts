/**
 * SyncClient — connects to CyberClaw desktop's WebSocket sync server
 * Handles pairing, auth, state sync, and message routing.
 * 
 * Connection states (for UI):
 *   - 'disconnected': no connection, not trying
 *   - 'connecting': actively trying to connect
 *   - 'connected': WebSocket open + authenticated (paired)
 *   - 'reconnecting': temporarily lost, auto-recovering (still show as "connected" to user)
 *   - 'lost': failed to reconnect after multiple attempts
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_TOKEN = 'cyberclaw-sync-token';
const STORAGE_KEY_HOST = 'cyberclaw-sync-host';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'lost';

type MessageHandler = (msg: any) => void;

class SyncClient {
  private ws: WebSocket | null = null;
  private host: string = '';
  private port: number = 9247;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private _state: ConnectionState = 'disconnected';
  private _authenticated: boolean = false;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 20; // ~100 seconds before "lost"
  private _isReconnecting: boolean = false;
  private _connectingPromise: Promise<void> | null = null;

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  off(type: string, handler: MessageHandler) {
    const list = this.handlers.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  private emit(type: string, data: any) {
    const list = this.handlers.get(type);
    if (list) list.forEach(h => h(data));
  }

  private setState(state: ConnectionState) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state_change', { state });
  }

  async loadSaved(): Promise<{ host: string; token: string | null }> {
    const host = await AsyncStorage.getItem(STORAGE_KEY_HOST) || '';
    const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
    this.host = host;
    this.token = token;
    return { host, token };
  }

  async connect(host?: string): Promise<void> {
    if (host) {
      // Clean up host input
      let cleaned = host.trim().replace(/^\[|\]$/g, '');
      // Only strip trailing :port for IPv4
      if (!cleaned.includes(':') || (cleaned.match(/:/g) || []).length === 1) {
        cleaned = cleaned.replace(/:\d+$/, '');
      }
      this.host = cleaned;
      await AsyncStorage.setItem(STORAGE_KEY_HOST, this.host);
    }

    if (!this.host) throw new Error('No host configured');

    // Prevent multiple simultaneous connect attempts
    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = this._doConnect();
    try {
      await this._connectingPromise;
    } finally {
      this._connectingPromise = null;
    }
  }

  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Close existing connection cleanly
        if (this.ws) {
          try { this.ws.close(); } catch {}
          this.ws = null;
        }

        // Validate and build URL
        const isIPv6 = this.host.includes(':');
        if (isIPv6) {
          const groups = this.host.split(':').filter(g => g.length > 0);
          const hasShorthand = this.host.includes('::');
          if (!hasShorthand && groups.length !== 8) {
            throw new Error(`Invalid IPv6 address (${groups.length}/8 groups)`);
          }
        }

        const wsHost = isIPv6 ? `[${this.host}]` : this.host;
        const url = `ws://${wsHost}:${this.port}`;

        if (!this._isReconnecting) {
          this.setState('connecting');
        }

        this.ws = new WebSocket(url);

        const connectTimeout = setTimeout(() => {
          if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
          }
          reject(new Error('Connection timeout (10s). Server not reachable.'));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(connectTimeout);
          this._reconnectAttempts = 0;

          // Auto-authenticate if we have a saved token
          if (this.token) {
            this.send({ type: 'auth', token: this.token });
          }
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            this._handleMessage(msg);
          } catch (e) {
            console.error('[SyncClient] Bad message:', e);
          }
        };

        this.ws.onclose = () => {
          clearTimeout(connectTimeout);
          this.ws = null;

          // If we were authenticated, this is a temporary disconnect — reconnect silently
          if (this._authenticated && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._isReconnecting = true;
            this._authenticated = false;
            this.setState('reconnecting'); // UI keeps showing "connected" for this state
            this._scheduleReconnect();
          } else if (this._isReconnecting && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._scheduleReconnect();
          } else if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            this._isReconnecting = false;
            this._authenticated = false;
            this.setState('lost');
          } else {
            this._authenticated = false;
            this.setState('disconnected');
          }
        };

        this.ws.onerror = (err: any) => {
          clearTimeout(connectTimeout);
          console.error('[SyncClient] Error:', err?.message || err);
          // Don't reject if we're reconnecting — onclose handles that
          if (!this._isReconnecting) {
            reject(new Error(err?.message || 'WebSocket connection error'));
          }
        };
      } catch (e) {
        console.error('[SyncClient] Connection failed:', e);
        if (!this._isReconnecting) {
          this.host = '';
          AsyncStorage.removeItem(STORAGE_KEY_HOST);
        }
        reject(e);
      }
    });
  }

  disconnect() {
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._authenticated = false;
    this.setState('disconnected');
  }

  pair(code: string, deviceName: string = 'Android') {
    this.send({ type: 'pair', code, deviceName });
  }

  sendChat(text: string, agentId: string = 'companion') {
    this.send({ type: 'chat', text, agentId });
  }

  sendVoiceTranscript(transcript: string, context: string, lookbackMinutes: number) {
    this.send({ type: 'voice_transcript', transcript, context, lookbackMinutes });
  }

  sendAudioInput(audioBase64: string, mimeType: string = 'audio/m4a') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[SyncClient] Audio input failed: WebSocket not open (state: ' + (this.ws?.readyState || 'none') + ')');
      this.emit('send_error', { type: 'audio_input', reason: 'not_connected' });
      return;
    }
    try {
      this.send({ type: 'audio_input', audioBase64, mimeType });
    } catch (e: any) {
      console.error('[SyncClient] Audio input send failed:', e.message);
      this.emit('send_error', { type: 'audio_input', reason: e?.message });
    }
  }

  requestChatHistory() {
    this.send({ type: 'request_chat_history' });
  }

  requestState() {
    this.send({ type: 'request_state' });
  }

  sendCompanionAction(action: any) {
    this.send({ type: 'companion_interaction', action });
  }

  setCompanionId(companionId: string) {
    this.send({ type: 'set_companion_id', companionId });
  }

  get state(): ConnectionState { return this._state; }
  get connected(): boolean { return this._state === 'connected' || this._state === 'reconnecting'; }
  get authenticated(): boolean { return this._authenticated; }

  private _handleMessage(msg: any) {
    switch (msg.type) {
      case 'hello':
        break;

      case 'pair_result':
        if (msg.success && msg.token) {
          this.token = msg.token;
          this._authenticated = true;
          this._isReconnecting = false;
          AsyncStorage.setItem(STORAGE_KEY_TOKEN, msg.token);
          this.setState('connected');
          this.emit('paired', { token: msg.token });
        } else {
          this.emit('pair_failed', { error: msg.error });
        }
        break;

      case 'auth_result':
        if (msg.success) {
          this._authenticated = true;
          this._isReconnecting = false;
          this._reconnectAttempts = 0;
          this.setState('connected');
          this.emit('authenticated', { name: msg.name });
          // Auto-request chat history from desktop
          setTimeout(() => this.requestChatHistory(), 300);
        } else {
          this.token = null;
          AsyncStorage.removeItem(STORAGE_KEY_TOKEN);
          this.emit('auth_failed', { error: msg.error });
        }
        break;

      case 'chat_history':
        this.emit('chat_history', msg);
        break;

      case 'typing':
        this.emit('typing', msg);
        break;

      case 'state_sync':
        this.emit('state', msg);
        break;

      case 'chat_message':
        console.log('[SyncClient] Received chat_message:', msg.text?.substring(0, 50));
        this.emit('chat', msg);
        break;

      case 'arena_event':
        this.emit('arena', msg);
        break;

      case 'audio_response':
        this.emit('audio_response', msg);
        break;

      case 'pong':
        break;

      case 'companion_id':
        this.emit('companion_id', msg);
        break;

      default:
        this.emit(msg.type, msg);
    }
  }

  private send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e: any) {
        this.emit('send_error', { type: obj.type, reason: e?.message });
      }
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this._reconnectAttempts++;
    const delay = Math.min(5000, 1000 * this._reconnectAttempts); // 1s, 2s, 3s, 4s, 5s...
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.host) {
        this._doConnect().catch(() => {});
      }
    }, delay);
  }
}

export const syncClient = new SyncClient();
export default syncClient;
