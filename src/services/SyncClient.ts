/**
 * SyncClient — connects to CyberClaw desktop's WebSocket sync server
 * Handles pairing, auth, state sync, and message routing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_TOKEN = 'cyberclaw-sync-token';
const STORAGE_KEY_HOST = 'cyberclaw-sync-host';

export type SyncState = {
  connected: boolean;
  authenticated: boolean;
  deviceName: string;
};

type MessageHandler = (msg: any) => void;

class SyncClient {
  private ws: WebSocket | null = null;
  private host: string = '';
  private port: number = 9247;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private _connected: boolean = false;
  private _authenticated: boolean = false;

  /**
   * Register a handler for a message type
   */
  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  /**
   * Remove a handler
   */
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

  /**
   * Load saved connection info
   */
  async loadSaved(): Promise<{ host: string; token: string | null }> {
    const host = await AsyncStorage.getItem(STORAGE_KEY_HOST) || '';
    const token = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
    this.host = host;
    this.token = token;
    return { host, token };
  }

  /**
   * Connect to the desktop sync server
   */
  async connect(host?: string): Promise<void> {
    if (host) {
      // Strip port if user included it (e.g. "192.168.1.100:9247" → "192.168.1.100")
      this.host = host.replace(/:\d+$/, '');
      await AsyncStorage.setItem(STORAGE_KEY_HOST, this.host);
    }

    if (!this.host) {
      throw new Error('No host configured');
    }

    return new Promise((resolve, reject) => {
      // Use wss:// (TLS) — self-signed cert is accepted by default in React Native
      const url = `wss://${this.host}:${this.port}`;
      console.log(`[SyncClient] Connecting to ${url}`);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[SyncClient] Connected');
        this._connected = true;
        this.emit('connected', {});

        // Auto-authenticate if we have a saved token
        if (this.token) {
          this.send({ type: 'auth', token: this.token });
        }
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleMessage(msg);
        } catch (e) {
          console.error('[SyncClient] Bad message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[SyncClient] Disconnected');
        this._connected = false;
        this._authenticated = false;
        this.emit('disconnected', {});
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[SyncClient] Error:', err);
        this._connected = false;
        reject(err);
      };
    });
  }

  /**
   * Disconnect
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this._authenticated = false;
  }

  /**
   * Pair with desktop using 6-digit code
   */
  pair(code: string, deviceName: string = 'Android') {
    this.send({ type: 'pair', code, deviceName });
  }

  /**
   * Send a chat message to the desktop
   */
  sendChat(text: string, agentId: string = 'companion') {
    this.send({ type: 'chat', text, agentId });
  }

  /**
   * Send voice transcript with context
   */
  sendVoiceTranscript(transcript: string, context: string, lookbackMinutes: number) {
    this.send({
      type: 'voice_transcript',
      transcript,
      context,
      lookbackMinutes
    });
  }

  /**
   * Request full state sync
   */
  requestState() {
    this.send({ type: 'request_state' });
  }

  /**
   * Send companion interaction (feed, play)
   */
  sendCompanionAction(action: any) {
    this.send({ type: 'companion_interaction', action });
  }

  get connected(): boolean { return this._connected; }
  get authenticated(): boolean { return this._authenticated; }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'hello':
        console.log(`[SyncClient] Server version ${msg.version}`);
        break;

      case 'pair_result':
        if (msg.success && msg.token) {
          this.token = msg.token;
          this._authenticated = true;
          AsyncStorage.setItem(STORAGE_KEY_TOKEN, msg.token);
          this.emit('paired', { token: msg.token });
          this.emit('authenticated', {});
        } else {
          this.emit('pair_failed', { error: msg.error });
        }
        break;

      case 'auth_result':
        if (msg.success) {
          this._authenticated = true;
          this.emit('authenticated', { name: msg.name });
        } else {
          // Token invalid, clear it
          this.token = null;
          AsyncStorage.removeItem(STORAGE_KEY_TOKEN);
          this.emit('auth_failed', { error: msg.error });
        }
        break;

      case 'state_sync':
        this.emit('state', msg);
        break;

      case 'chat_message':
        this.emit('chat', msg);
        break;

      case 'arena_event':
        this.emit('arena', msg);
        break;

      case 'pong':
        break;

      default:
        this.emit(msg.type, msg);
    }
  }

  private send(obj: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.host) {
        console.log('[SyncClient] Reconnecting...');
        this.connect().catch(() => {});
      }
    }, 5000);
  }
}

// Singleton
export const syncClient = new SyncClient();
export default syncClient;
